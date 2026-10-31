/**
 * Read-only panel snapshot and its authenticated Host route.
 *
 * The Client page fetches one JSON document on open/refresh. The route is
 * registered through `ctx.connection.fetch`, so it inherits the same browser
 * authentication as the rest of the Web API.
 */

import { groupFailures } from './groups.js';
import { estimateUsageCost } from './cost.js';
import { normalizeRules } from './rules.js';
import { OFFICIAL_PRICING, PRICE_MODES, estimateSavings } from './savings.js';

export const SNAPSHOT_ROUTE = '/api/failure-ledger.snapshot';
export const SNAPSHOT_SCHEMA = 'dsh-failure-snapshot/1';

/**
 * Build one detached snapshot.
 *
 * @param {{store: object, config?: object, now?: Date|number, sessionTitles?: object, sessionCatalog?: object[], contexts?: object, views?: object}} input - data sources.
 * @returns {Promise<object>} snapshot JSON.
 */
export async function buildSnapshot(input = {}) {
  const store = input.store;
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const now = input.now == null ? new Date() : new Date(input.now);
  const generatedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();

  const [totalsResult, failuresResult, anomaliesResult, guardsResult, guardHitsResult, playbookResult, sessionStatsResult, recentResult] = store
    ? await Promise.all([
      store.getTotals(),
      store.listFailures({ limit: 500, scope: 'all' }),
      store.listAnomalies({ limit: 50 }),
      store.listGuards(),
      store.listGuardHits({ limit: 500 }),
      store.listPlaybook({ limit: 500 }),
      store.getSessionStats(),
      store.listRecentFailures({ limit: 40 }),
    ])
    : [
      { ok: true, totals: {} },
      { ok: true, entries: [] },
      { ok: true, entries: [] },
      { ok: true, guards: [] },
      { ok: true, entries: [] },
      { ok: true, entries: [] },
      { ok: true, sessions: [] },
      { ok: true, entries: [] },
    ];

  const totals = totalsResult?.ok ? totalsResult.totals ?? {} : {};
  const failures = failuresResult?.ok ? failuresResult.entries ?? [] : [];
  const anomalies = anomaliesResult?.ok ? anomaliesResult.entries ?? [] : [];
  const guards = guardsResult?.ok ? guardsResult.guards ?? [] : [];
  const guardHits = guardHitsResult?.ok ? guardHitsResult.entries ?? [] : [];
  const playbook = playbookResult?.ok ? playbookResult.entries ?? [] : [];
  const recent = recentResult?.ok ? recentResult.entries ?? [] : [];
  const sessionRows = sessionStatsResult?.ok ? sessionStatsResult.sessions ?? [] : [];
  const sessionTitles = input.sessionTitles && typeof input.sessionTitles === 'object'
    ? input.sessionTitles
    : {};
  const sessionCatalog = Array.isArray(input.sessionCatalog) ? input.sessionCatalog : [];
  const contexts = input.contexts && typeof input.contexts === 'object' ? input.contexts : {};
  const views = input.views && typeof input.views === 'object' ? input.views : {};
  const catalogIds = new Set(sessionCatalog.map((row) => String(row.sessionId)));
  const today = localDayKey(now.getTime());
  const budgetConfig = config.budget && typeof config.budget === 'object' ? config.budget : {};
  const statsById = new Map(sessionRows.map((row) => [String(row.sessionId), row]));
  const allSessionIds = catalogIds.size > 0
    ? new Set(catalogIds)
    : new Set(sessionRows.map((row) => String(row.sessionId)));
  const sessionStats = [...allSessionIds].map((id) => {
    const row = statsById.get(id) ?? {
      sessionId: id,
      failures: 0,
      anomalies: 0,
      savedTokens: 0,
      compressions: 0,
    };
    const catalogRow = sessionCatalog.find((entry) => String(entry.sessionId) === id);
    const view = views[id] && typeof views[id] === 'object' ? views[id] : {};
    const usage = view.usage && typeof view.usage === 'object' ? view.usage : null;
    const cost = usage == null ? null : estimateUsageCost(usage, view.route ?? {});
    const dailyUsage = view.usageDaily?.[today] ?? null;
    const dailyCost = dailyUsage == null ? null : estimateUsageCost(dailyUsage, view.route ?? {});
    return {
      ...row,
      title: sessionTitles[id] ?? catalogRow?.title ?? null,
      context: view.context ?? contexts[id] ?? null,
      usage,
      cost: cost == null ? null : { ...cost, cny: round(cost.cny, 2) },
      todayCost: dailyCost == null ? null : { ...dailyCost, cny: round(dailyCost.cny, 2) },
      budget: evaluateBudget(cost?.cny ?? 0, dailyCost?.cny ?? 0, budgetConfig),
    };
  }).sort((left, right) => (
    (right.failures - left.failures)
    || (right.anomalies - left.anomalies)
    || (right.savedTokens - left.savedTokens)
  ));
  const totalCostCNY = round(sessionStats.reduce((sum, row) => sum + (row.cost?.cny ?? 0), 0), 2);
  const todayCostCNY = round(sessionStats.reduce((sum, row) => sum + (row.todayCost?.cny ?? 0), 0), 2);
  const budget = {
    enabled: budgetConfig.enabled === true,
    sessionCNY: numberOrZero(budgetConfig.sessionCNY),
    dailyCNY: numberOrZero(budgetConfig.dailyCNY),
    warnRatio: numberOrZero(budgetConfig.warnRatio) || 0.8,
    todayCostCNY,
    status: sessionStats.reduce((worst, row) => (
      worst === 'exceeded' || row.budget?.status === 'exceeded' ? 'exceeded'
        : worst === 'approaching' || row.budget?.status === 'approaching' ? 'approaching'
          : 'ok'
    ), 'ok'),
  };
  const resolvedUntil = new Map();
  for (const entry of playbook) {
    const fingerprint = entry?.fingerprint;
    const at = Date.parse(entry?.resolvedAt ?? '');
    if (typeof fingerprint !== 'string' || !Number.isFinite(at)) continue;
    const previous = resolvedUntil.get(fingerprint) ?? 0;
    if (at > previous) resolvedUntil.set(fingerprint, at);
  }
  const recentFailures = recent.map((entry) => {
    const resolvedAt = resolvedUntil.get(entry.fingerprint);
    const time = Date.parse(entry.time ?? '');
    return {
      id: entry.id ?? null,
      fingerprint: entry.fingerprint ?? null,
      time: entry.time ?? null,
      session: entry.session ?? null,
      tool: entry.tool ?? null,
      category: entry.category ?? null,
      severity: entry.severity ?? 'medium',
      code: entry.code ?? null,
      report: entry.report ?? null,
      resolved: resolvedAt !== undefined && Number.isFinite(time) && time <= resolvedAt,
    };
  });
  const unresolvedGroups = groupFailures(failures);
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
      cny: round(estimate.cny, 2),
      unitPricePerMTokens: estimate.unitPricePerMTokens,
    };
  });
  const estimatedCNY = round(byRoute.reduce((sum, row) => sum + row.cny, 0), 2);
  const unresolvedFingerprints = new Set(unresolvedGroups.map((group) => group.fingerprint));
  const hitFingerprints = new Set(
    guardHits.map((entry) => entry.fingerprint).filter((value) => typeof value === 'string'),
  );
  const coveredFingerprints = [...unresolvedFingerprints].filter((value) => hitFingerprints.has(value)).length;
  const guardsWithHits = guards.filter((guard) => Number(guard.hits) > 0).length;
  const resolvedFingerprints = new Set(
    playbook.map((entry) => entry.fingerprint).filter((value) => typeof value === 'string'),
  );
  const learnedGuardFingerprints = new Set(
    guards
      .filter((guard) => typeof guard.fingerprint === 'string')
      .map((guard) => guard.fingerprint),
  );
  const resolvedGuarded = [...resolvedFingerprints]
    .filter((fingerprint) => learnedGuardFingerprints.has(fingerprint)).length;

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
    sessions: allSessionIds.size,
    sessionStats,
    recentFailures,
    unresolved: {
      entries: failures.length,
      fingerprints: unresolvedFingerprints.size,
    },
    unresolvedGroups: unresolvedGroups.slice(0, 100).map((group) => ({
      fingerprint: group.fingerprint,
      count: group.count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      tool: group.tool ?? null,
      category: group.category ?? null,
      severity: group.severity ?? null,
      code: group.code ?? null,
      session: group.session ?? null,
      report: group.report ?? null,
    })),
    guardCoverage: {
      unresolvedFingerprints: unresolvedFingerprints.size,
      coveredFingerprints,
      percent: unresolvedFingerprints.size === 0
        ? 0
        : Math.round((coveredFingerprints / unresolvedFingerprints.size) * 100),
      guardsWithHits,
      guardHits: guardHits.length,
      resolvedFingerprints: resolvedFingerprints.size,
      resolvedGuarded,
      resolvedPercent: resolvedFingerprints.size === 0
        ? 0
        : Math.round((resolvedGuarded / resolvedFingerprints.size) * 100),
    },
    guards: guards.map((guard) => ({
      id: guard.id,
      label: guard.label ?? guard.id,
      fingerprint: guard.fingerprint ?? null,
      tool: guard.tool ?? null,
      category: guard.category ?? null,
      code: guard.code ?? null,
      action: guard.action ?? 'hint',
      mode: guard.mode ?? 'observe',
      source: guard.source ?? null,
      enabled: guard.enabled !== false,
      hits: guard.hits ?? 0,
      hint: guard.hint ?? '',
      lastHitAt: guard.lastHitAt ?? null,
      lastFingerprint: guard.lastFingerprint ?? null,
    })),
    guardsSummary: {
      total: guards.length,
      hits: guards.reduce((sum, guard) => sum + (Number(guard.hits) || 0), 0),
    },
    playbook: playbook.map((entry) => ({
      fingerprint: entry.fingerprint ?? null,
      id: entry.id ?? null,
      fix: entry.fix ?? '',
      guardId: entry.guardId ?? null,
      regression: entry.regression ?? null,
      resolvedAt: entry.resolvedAt ?? null,
    })),
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
    totalCostCNY,
    todayCostCNY,
    budget,
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
      guards: config.guards ?? {},
      selfHeal: config.selfHeal ?? {},
      budget: config.budget ?? {},
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

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function localDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function evaluateBudget(sessionCost, dailyCost, config) {
  if (config.enabled !== true) return null;
  const sessionLimit = numberOrZero(config.sessionCNY);
  const dailyLimit = numberOrZero(config.dailyCNY);
  const warnRatio = numberOrZero(config.warnRatio) || 0.8;
  if (sessionLimit <= 0 && dailyLimit <= 0) return null;
  const sessionRatio = sessionLimit > 0 ? sessionCost / sessionLimit : 0;
  const dailyRatio = dailyLimit > 0 ? dailyCost / dailyLimit : 0;
  const ratio = Math.max(sessionRatio, dailyRatio);
  const status = ratio >= 1 ? 'exceeded' : ratio >= warnRatio ? 'approaching' : 'ok';
  return {
    status,
    ratio: round(ratio, 4),
    sessionLimitCNY: sessionLimit,
    dailyLimitCNY: dailyLimit,
    warnRatio,
  };
}
