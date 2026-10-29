/**
 * DFL — read-only usage cost estimation.
 *
 * Cost is intentionally approximate: it reuses the published DFL price table
 * and never calls a Provider or reads a balance. Cache writes are charged at
 * the miss price because the available usage shape does not expose a separate
 * cache-write unit price.
 */

import { OFFICIAL_PRICING } from './savings.js';

/**
 * Estimate one session's cost from cumulative TokenUsage.
 *
 * @param {object} usage - `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}`.
 * @param {{provider?: string, model?: string}} [route] - last known route.
 * @param {object} [pricing] - price table; defaults to OFFICIAL_PRICING.
 * @returns {{cny: number, routeKey: string, provider: string, model: string, currency: string, estimated: true}} cost.
 */
export function estimateUsageCost(usage = {}, route = {}, pricing = OFFICIAL_PRICING) {
  const picked = pickRoute(pricing, route.provider, route.model);
  const input = positive(usage.inputTokens);
  const output = positive(usage.outputTokens);
  const cacheRead = positive(usage.cacheReadTokens);
  const cacheWrite = positive(usage.cacheWriteTokens);
  const reasoning = positive(usage.reasoningTokens);
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const cny = (
    uncached * positive(picked.inputCacheMissOffPeak)
    + cacheRead * positive(picked.inputCacheHitOffPeak)
    + cacheWrite * positive(picked.inputCacheMissOffPeak)
    + (output + reasoning) * positive(picked.outputOffPeak)
  ) / 1_000_000;
  return {
    cny: round(cny, 6),
    routeKey: `${picked.provider}/${picked.model}`,
    provider: picked.provider,
    model: picked.model,
    currency: 'CNY',
    estimated: true,
  };
}

function pickRoute(pricing, provider, model) {
  const routes = Array.isArray(pricing?.routes) ? pricing.routes : [];
  const wanted = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  const exact = routes.find((route) => `${route.provider}/${route.model}`.toLowerCase() === wanted);
  if (exact) return exact;
  const fallback = routes.find((route) => `${route.provider}/${route.model}` === 'deepseek/deepseek-flash');
  return fallback ?? routes[0] ?? {
    provider: 'deepseek',
    model: 'deepseek-flash',
    inputCacheHitOffPeak: 0.02,
    inputCacheMissOffPeak: 1,
    outputOffPeak: 4,
  };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
