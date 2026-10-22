/**
 * Read-only panel snapshot and its authenticated Host route.
 *
 * The Client page fetches one JSON document on open/refresh. The route is
 * registered through `ctx.connection.fetch`, so it inherits the same browser
 * authentication as the rest of the Web API.
 */

import { normalizeRules } from './rules.js';
import { OFFICIAL_PRICING, PRICE_MODES, estimateSavings } from './savings.js';

export const SNAPSHOT_ROUTE = '/api/failure-ledger.snapshot';
export const SNAPSHOT_SCHEMA = 'dsh-failure-snapshot/1';

/**
 * Build one detached snapshot.
 *
 * @param {{store: object, config?: object, now?: Date|number}} input - data sources.
 * @returns {Promise<object>} snapshot JSON.
 */
export async function buildSnapshot(input = {}) {
  const store = input.store;
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const now = input.now == null ? new Date() : new Date(input.now);
  const generatedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();

  const [totalsResult, failuresResult, anomaliesResult] = store
    ? await Promise.all([
      store.getTotals(),
      store.listFailures({ limit: 500, scope: 'all' }),
      store.listAnomalies({ limit: 50 }),
    ])
    : [
      { ok: true, totals: {} },
      { ok: true, entries: [] },
      { ok: true, entries: [] },
    ];

  const totals = totalsResult?.ok ? totalsResult.totals ?? {} : {};
  const failures = failuresResult?.ok ? failuresResult.entries ?? [] : [];
  const anomalies = anomaliesResult?.ok ? anomaliesResult.entries ?? [] : [];
  const rules = normalizeRules(config.rules);
  const mode = PRICE_MODES.includes(config.savings?.priceMode) ? config.savings.priceMode : 'cacheMissOffPeak';
  const custom = config.savings?.customUnitPricePerMTokens;

  const byRoute = Object.entries(totals.byRoute ?? {}).map(([route, bucket]) => {
    const [provider = 'unknown', model = 'unknown'] = route.split('/');
    const estimate = estimateSavings({
      savedTokens: bucket?.savedTokens ?? 0,
      provider,
      model,
      mode,
      pricing: OFFICIAL_PRICING,
      customUnitPricePerMTokens: custom,
    });
    return {
      route: estimate.routeKey,
      provider: estimate.provider,
      model: estimate.model,
      failures: bucket?.failures ?? 0,
      savedTokens: estimate.savedTokens,
      cny: estimate.cny,
      unitPricePerMTokens: estimate.unitPricePerMTokens,
    };
  });
  const estimatedCNY = round(byRoute.reduce((sum, row) => sum + row.cny, 0), 6);

  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt,
    totals: {
      failures: totals.failures ?? 0,
      compressions: totals.compressions ?? 0,
      anomalies: totals.anomalies ?? 0,
      savedTokens: totals.savedTokens ?? 0,
      anomalyWastedTokens: totals.anomalyWastedTokens ?? 0,
      byRule: totals.byRule ?? {},
    },
    sessions: Object.keys(totals.bySession ?? {}).length,
    unresolved: {
      entries: failures.length,
      fingerprints: new Set(
        failures.map((entry) => entry.fingerprint).filter((value) => typeof value === 'string'),
      ).size,
    },
    errorSources: {
      byTool: Object.entries(totals.byTool ?? {}).map(([tool, bucket]) => ({
        tool,
        failures: bucket?.failures ?? 0,
        savedTokens: bucket?.savedTokens ?? 0,
      })),
      byCategory: Object.entries(totals.byCategory ?? {}).map(([category, count]) => ({
        category,
        failures: count,
      })),
    },
    failures: failures.map((entry) => ({
      id: entry.id ?? null,
      fingerprint: entry.fingerprint ?? null,
      time: entry.time ?? null,
      session: entry.session ?? null,
      parent: entry.parent ?? null,
      agentKind: entry.agentKind ?? 'root',
      tool: entry.tool ?? null,
      category: entry.category ?? null,
      severity: entry.severity ?? 'medium',
      code: entry.code ?? null,
      tokensSaved: entry.tokensSaved ?? 0,
      report: entry.report ?? null,
    })),
    anomalies: anomalies.map((entry) => ({
      time: entry.time ?? null,
      ruleId: entry.ruleId ?? null,
      count: entry.count ?? 0,
      wastedTokens: entry.wastedTokens ?? 0,
      session: entry.session ?? null,
      turn: entry.turn ?? null,
      evidence: entry.evidence ?? null,
    })),
    byRoute,
    estimatedCNY,
    pricing: {
      source: OFFICIAL_PRICING.source,
      fetchedAt: OFFICIAL_PRICING.fetchedAt,
      currency: OFFICIAL_PRICING.currency,
      peakMultiplier: OFFICIAL_PRICING.peakMultiplier,
      mode,
      customUnitPricePerMTokens: custom ?? null,
      routes: OFFICIAL_PRICING.routes,
    },
    rules,
    config: {
      reportRoot: config.reportRoot ?? null,
      minSeverity: config.minSeverity ?? 'medium',
      digest: config.digest ?? {},
      report: config.report ?? {},
      savings: config.savings ?? {},
      projection: config.projection ?? {},
      reminder: config.reminder ?? {},
      panel: config.panel ?? {},
    },
    limits: { list: 10, show: 60, stats: 15, inbox: 20 },
  };
}

/**
 * Build the `connection.fetch` route that serves one snapshot.
 *
 * @param {{getSnapshot: () => Promise<object>|object}} options - snapshot source.
 * @returns {object} ConnectionFetchRoute.
 */
export function createSnapshotRoute(options = {}) {
  const getSnapshot = typeof options.getSnapshot === 'function' ? options.getSnapshot : async () => ({});
  return {
    path: SNAPSHOT_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request && request.method !== 'GET') {
        return jsonResponse({ error: 'method_not_allowed' }, 405);
      }
      try {
        const data = await getSnapshot();
        return jsonResponse(data, 200);
      } catch (error) {
        return jsonResponse({ error: 'snapshot_failed', message: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  };
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
