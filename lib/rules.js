/**
 * Pure token-anomaly rules (PROJECT.md §2.15).
 *
 * `evaluateRules(stats, config)` takes a plain, JSON-shaped snapshot produced
 * by the session projection (or tests) and returns bounded hits with evidence.
 * Rules never mutate model behavior; they only produce anomaly records.
 */

export const RULE_IDS = Object.freeze([
  'repeatFailure',
  'largeErrorResend',
  'requestRetry',
  'cacheReset',
  'contextPressure',
  'contextJump',
  'maxTokens',
  'abortedTurn',
  'subagentFailure',
  'idleLoop',
]);

/** Conservative defaults; every rule is enabled. */
export const DEFAULT_RULES = Object.freeze({
  repeatFailure: Object.freeze({ enabled: true, windowMinutes: 10, threshold: 3 }),
  largeErrorResend: Object.freeze({ enabled: true, minRawTokens: 250 }),
  requestRetry: Object.freeze({ enabled: true, alertAfter: 2 }),
  cacheReset: Object.freeze({ enabled: true, minInputTokens: 4000 }),
  contextPressure: Object.freeze({ enabled: true, ratio: 0.8 }),
  contextJump: Object.freeze({
    enabled: true,
    minDeltaTokens: 8000,
    minWindowRatio: 0.1,
    maxHitsPerSession: 3,
  }),
  maxTokens: Object.freeze({ enabled: true }),
  abortedTurn: Object.freeze({ enabled: true }),
  subagentFailure: Object.freeze({ enabled: true }),
  idleLoop: Object.freeze({ enabled: true, minStepsWithoutProgress: 4 }),
});

/**
 * Merge a partial config over the conservative defaults.
 *
 * @param {object} [config] - partial `{ [ruleId]: {enabled, ...thresholds} }`.
 * @returns {object} complete rule config.
 */
export function normalizeRules(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const id of RULE_IDS) {
    const base = DEFAULT_RULES[id];
    const given = source[id] && typeof source[id] === 'object' ? source[id] : {};
    out[id] = { ...base, ...given, enabled: given.enabled ?? base.enabled };
  }
  return out;
}

/**
 * Evaluate every enabled rule over one stats snapshot.
 *
 * @param {object} [stats] - snapshot; see individual predicates for accepted fields.
 * @param {object} [config] - partial rule config.
 * @returns {{hits: object[], byRule: Record<string, object[]>, wastedTokens: number}}
 */
export function evaluateRules(stats = {}, config = {}) {
  const rules = normalizeRules(config);
  const hits = [
    ...evaluateRepeatFailure(stats, rules.repeatFailure),
    ...evaluateLargeErrorResend(stats, rules.largeErrorResend),
    ...evaluateRequestRetry(stats, rules.requestRetry),
    ...evaluateCacheReset(stats, rules.cacheReset),
    ...evaluateContextPressure(stats, rules.contextPressure),
    ...evaluateContextJump(stats, rules.contextJump),
    ...evaluateMaxTokens(stats, rules.maxTokens),
    ...evaluateAbortedTurn(stats, rules.abortedTurn),
    ...evaluateSubagentFailure(stats, rules.subagentFailure),
    ...evaluateIdleLoop(stats, rules.idleLoop),
  ];

  const byRule = {};
  for (const hit of hits) {
    if (!byRule[hit.ruleId]) byRule[hit.ruleId] = [];
    byRule[hit.ruleId].push(hit);
  }

  return {
    hits,
    byRule,
    wastedTokens: hits.reduce((sum, hit) => sum + hit.wastedTokens, 0),
  };
}

/**
 * Aggregate hits for a reminder line.
 *
 * @param {object[]} hits - hits from {@link evaluateRules}.
 * @returns {{count: number, totalCount: number, wastedTokens: number}}
 */
export function summarizeHits(hits) {
  if (!Array.isArray(hits)) return { count: 0, totalCount: 0, wastedTokens: 0 };
  return {
    count: hits.length,
    totalCount: hits.reduce((sum, hit) => sum + numberOrZero(hit.count), 0),
    wastedTokens: hits.reduce((sum, hit) => sum + numberOrZero(hit.wastedTokens), 0),
  };
}

function evaluateRepeatFailure(stats, config) {
  if (!config.enabled) return [];
  const now = numberOrZero(stats.now) || Date.now();
  const windowMs = Math.max(1, numberOrZero(config.windowMinutes) || 10) * 60_000;
  const threshold = Math.max(2, Math.floor(numberOrZero(config.threshold) || 3));
  const groups = new Map();

  for (const failure of Array.isArray(stats.recentFailures) ? stats.recentFailures : []) {
    if (!failure || typeof failure.fingerprint !== 'string') continue;
    const time = toTime(failure.time, now);
    if (time > now || now - time > windowMs) continue;
    if (!groups.has(failure.fingerprint)) groups.set(failure.fingerprint, []);
    groups.get(failure.fingerprint).push({ ...failure, time });
  }

  const hits = [];
  for (const [fingerprint, group] of groups) {
    if (group.length < threshold) continue;
    group.sort((left, right) => left.time - right.time);
    const wastedTokens = group.slice(1).reduce((sum, failure) => sum + numberOrZero(failure.tokens), 0);
    hits.push(
      makeHit('repeatFailure', group.length, wastedTokens, {
        fingerprint,
        tool: group[0].tool ?? null,
        category: group[0].category ?? null,
        count: group.length,
        windowMinutes: Math.round(windowMs / 60_000),
        firstAt: group[0].time,
        lastAt: group[group.length - 1].time,
      }),
    );
  }
  return hits;
}

function evaluateLargeErrorResend(stats, config) {
  if (!config.enabled) return [];
  const minTokens = numberOrZero(config.minRawTokens) || 250;
  const hits = [];
  for (const entry of Array.isArray(stats.largeErrors) ? stats.largeErrors : []) {
    if (!entry) continue;
    const tokens = numberOrZero(entry.tokens);
    const stepsAfter = Math.floor(numberOrZero(entry.stepsAfter));
    if (tokens <= minTokens || stepsAfter < 1) continue;
    hits.push(
      makeHit('largeErrorResend', 1, tokens * stepsAfter, {
        fingerprint: entry.fingerprint ?? null,
        tool: entry.tool ?? null,
        category: entry.category ?? null,
        tokens,
        stepsAfter,
      }),
    );
  }
  return hits;
}

function evaluateRequestRetry(stats, config) {
  if (!config.enabled) return [];
  const retries = stats.retries && typeof stats.retries === 'object' ? stats.retries : {};
  const attempts = Math.floor(numberOrZero(retries.attempts));
  const alertAfter = Math.max(1, Math.floor(numberOrZero(config.alertAfter) || 2));
  if (attempts < alertAfter) return [];
  const promptTokens = numberOrZero(retries.promptTokens);
  return [
    makeHit('requestRetry', attempts, attempts * promptTokens, {
      attempts,
      promptTokens,
      codes: Array.isArray(retries.codes) ? retries.codes.slice(0, 5) : [],
    }),
  ];
}

function evaluateCacheReset(stats, config) {
  if (!config.enabled) return [];
  const request = stats.lastRequest && typeof stats.lastRequest === 'object' ? stats.lastRequest : null;
  if (!request) return [];
  const reason = String(request.reason ?? '');
  const inputTokens = numberOrZero(request.inputTokens);
  const cacheReadTokens = numberOrZero(request.cacheReadTokens);
  const minInputTokens = numberOrZero(config.minInputTokens) || 4000;
  const headerReset = reason === 'change' || reason === 'series';
  const cacheCold = inputTokens >= minInputTokens && cacheReadTokens === 0;
  if (!headerReset && !cacheCold) return [];
  return [
    makeHit('cacheReset', 1, inputTokens, {
      reason: reason || null,
      inputTokens,
      cacheReadTokens,
      headerReset,
      cacheCold,
      minInputTokens,
    }),
  ];
}

function evaluateContextPressure(stats, config) {
  if (!config.enabled) return [];
  const pressure = stats.pressure && typeof stats.pressure === 'object' ? stats.pressure : null;
  if (!pressure) return [];
  const projectedTokens = numberOrZero(pressure.projectedTokens);
  const contextWindow = numberOrZero(pressure.contextWindow);
  if (projectedTokens <= 0 || contextWindow <= 0) return [];
  const ratio = projectedTokens / contextWindow;
  const limit = numberOrZero(config.ratio) || 0.8;
  if (ratio < limit) return [];
  return [
    makeHit('contextPressure', 1, 0, {
      projectedTokens,
      contextWindow,
      ratio: Math.round(ratio * 1000) / 1000,
      threshold: limit,
    }),
  ];
}

function evaluateContextJump(stats, config) {
  if (!config.enabled) return [];
  const context = stats.context && typeof stats.context === 'object' ? stats.context : null;
  if (!context) return [];
  const series = Array.isArray(context.series) ? context.series : [];
  const minDelta = numberOrZero(config.minDeltaTokens) || 8000;
  const minRatio = numberOrZero(config.minWindowRatio) || 0.1;
  const maxHits = Math.max(1, Math.floor(numberOrZero(config.maxHitsPerSession) || 3));
  const seen = new Set();
  const hits = [];
  for (let index = series.length - 1; index >= 0 && hits.length < maxHits; index -= 1) {
    const entry = series[index];
    if (!entry || entry.compaction === true) continue;
    const delta = numberOrZero(entry.delta);
    const window = numberOrZero(entry.window);
    if (delta < minDelta || window <= 0) continue;
    const ratio = delta / window;
    if (ratio < minRatio) continue;
    const key = `${entry.turn ?? ''}|${entry.source ?? ''}|${entry.tool ?? ''}|${entry.callId ?? ''}|${entry.at ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(
      makeHit('contextJump', 1, 0, {
        at: entry.at ?? null,
        delta,
        window,
        ratio: Math.round(ratio * 1000) / 1000,
        source: entry.source ?? 'unknown',
        tool: entry.tool ?? null,
        callId: entry.callId ?? null,
        turn: entry.turn ?? null,
        step: entry.step ?? null,
        compaction: false,
        thresholdDelta: minDelta,
        thresholdRatio: minRatio,
      }),
    );
  }
  return hits;
}

function evaluateMaxTokens(stats, config) {
  if (!config.enabled) return [];
  const kind = reasonKind(stats.turn?.reason ?? stats.turnReason);
  if (kind !== 'max-tokens') return [];
  return [makeHit('maxTokens', 1, 0, { reason: kind })];
}

function evaluateAbortedTurn(stats, config) {
  if (!config.enabled) return [];
  const kind = reasonKind(stats.turn?.reason ?? stats.turnReason);
  if (kind !== 'aborted' && kind !== 'interrupted') return [];
  return [makeHit('abortedTurn', 1, 0, { reason: kind })];
}

function evaluateSubagentFailure(stats, config) {
  if (!config.enabled) return [];
  const failed = (Array.isArray(stats.subagents) ? stats.subagents : []).filter((entry) => entry && entry.ok === false);
  if (failed.length === 0) return [];
  return [
    makeHit(
      'subagentFailure',
      failed.length,
      failed.reduce((sum, entry) => sum + numberOrZero(entry.tokens), 0),
      {
        children: failed.slice(0, 5).map((entry) => ({
          childSession: entry.childSession ?? null,
          tool: entry.tool ?? null,
          category: entry.category ?? null,
        })),
      },
    ),
  ];
}

function evaluateIdleLoop(stats, config) {
  if (!config.enabled) return [];
  const idle = stats.idle && typeof stats.idle === 'object' ? stats.idle : null;
  if (!idle) return [];
  const steps = Math.floor(numberOrZero(idle.stepsWithoutProgress));
  const threshold = Math.max(1, Math.floor(numberOrZero(config.minStepsWithoutProgress) || 4));
  if (steps < threshold) return [];
  return [makeHit('idleLoop', steps, numberOrZero(idle.tokens), { stepsWithoutProgress: steps, threshold })];
}

function makeHit(ruleId, count, wastedTokens, evidence) {
  return {
    ruleId,
    count: Math.max(1, Math.floor(numberOrZero(count) || 1)),
    wastedTokens: Math.max(0, Math.floor(numberOrZero(wastedTokens))),
    evidence,
  };
}

function reasonKind(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.kind === 'string') return value.kind;
  return null;
}

function toTime(value, fallback) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
