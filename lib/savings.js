/**
 * Token savings and conservative money estimation.
 *
 * Prices come from the official DeepSeek pricing page fetched on 2026-10-22.
 * Text-token pricing is not exposed by DSH itself (only image pricing is), so
 * the table is plugin-owned and can be calibrated from the panel.
 *
 * Default policy (`cacheMissOffPeak`): count direct compression savings once,
 * at the off-peak cache-miss input price. This deliberately ignores later
 * re-sends and peak pricing, so the displayed amount is a conservative lower
 * bound, not a bill.
 */

export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const PRICING_FETCHED_AT = '2026-10-22';
export const PRICE_MODES = Object.freeze(['cacheMissOffPeak', 'cacheHitOffPeak', 'peakCacheMiss', 'custom']);

/** Official prices in CNY per 1M tokens (off-peak, plus peak multiplier). */
export const OFFICIAL_PRICING = Object.freeze({
  source: PRICING_SOURCE,
  fetchedAt: PRICING_FETCHED_AT,
  currency: 'CNY',
  peakMultiplier: 2,
  unknownRoute: 'deepseek/deepseek-flash',
  routes: Object.freeze([
    Object.freeze({
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputCacheHitOffPeak: 0.02,
      inputCacheMissOffPeak: 1.0,
      outputOffPeak: 4.0,
    }),
    Object.freeze({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      inputCacheHitOffPeak: 0.15,
      inputCacheMissOffPeak: 4.5,
      outputOffPeak: 13.5,
    }),
  ]),
});

/**
 * Resolve the unit price for one model route.
 *
 * @param {object} [input] - `{provider, model, mode, pricing, customUnitPricePerMTokens}`.
 * @returns {{provider: string, model: string, routeKey: string, mode: string, unitPricePerMTokens: number, currency: string, source: string|null, fetchedAt: string|null}}
 */
export function priceFor(input = {}) {
  const pricing = input.pricing && typeof input.pricing === 'object' ? input.pricing : OFFICIAL_PRICING;
  const mode = PRICE_MODES.includes(input.mode) ? input.mode : 'cacheMissOffPeak';
  const route = findRoute(pricing, input.provider, input.model);
  const provider = route?.provider ?? input.provider ?? 'deepseek';
  const model = route?.model ?? input.model ?? 'deepseek-flash';

  let unitPrice = 0;
  if (route) {
    if (mode === 'cacheMissOffPeak') unitPrice = numberOrZero(route.inputCacheMissOffPeak);
    else if (mode === 'cacheHitOffPeak') unitPrice = numberOrZero(route.inputCacheHitOffPeak);
    else if (mode === 'peakCacheMiss') unitPrice = numberOrZero(route.inputCacheMissOffPeak) * (numberOrZero(pricing.peakMultiplier) || 2);
    else if (mode === 'custom') unitPrice = numberOrZero(input.customUnitPricePerMTokens);
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) unitPrice = 0;

  return {
    provider,
    model,
    routeKey: routeKey(provider, model),
    mode,
    unitPricePerMTokens: unitPrice,
    currency: pricing.currency ?? 'CNY',
    source: pricing.source ?? null,
    fetchedAt: pricing.fetchedAt ?? null,
  };
}

/**
 * Compute direct savings for one digest.
 *
 * @param {{rawTokens?: number, digestTokens?: number}} input - token counts.
 * @returns {{rawTokens: number, digestTokens: number, savedTokens: number}}
 */
export function computeSavings(input = {}) {
  const rawTokens = Math.max(0, Math.floor(numberOrZero(input.rawTokens)));
  const digestTokens = Math.max(0, Math.floor(numberOrZero(input.digestTokens)));
  return { rawTokens, digestTokens, savedTokens: Math.max(0, rawTokens - digestTokens) };
}

/**
 * Estimate the saved amount for one route.
 *
 * @param {object} input - `{savedTokens, provider, model, mode, pricing, customUnitPricePerMTokens}`.
 * @returns {object} saved tokens, CNY amount, and the applied price.
 */
export function estimateSavings(input = {}) {
  const savedTokens = Math.max(0, numberOrZero(input.savedTokens));
  const price = priceFor(input);
  return {
    savedTokens,
    cny: round(savedTokens / 1_000_000 * price.unitPricePerMTokens, 6),
    currency: price.currency,
    unitPricePerMTokens: price.unitPricePerMTokens,
    mode: price.mode,
    routeKey: price.routeKey,
    provider: price.provider,
    model: price.model,
    source: price.source,
    fetchedAt: price.fetchedAt,
  };
}

/**
 * Convenience wrapper returning only the CNY amount.
 *
 * @param {object} input - same as {@link estimateSavings}.
 * @returns {number} estimated CNY.
 */
export function estimateSavedCNY(input = {}) {
  return estimateSavings(input).cny;
}

/**
 * Aggregate many savings entries by route.
 *
 * @param {object[]} entries - `[{savedTokens, provider, model}]`.
 * @param {object} [options] - `{mode, pricing, customUnitPricePerMTokens}`.
 * @returns {{savedTokens: number, cny: number, currency: string, byRoute: object[]}}
 */
export function summarizeSavings(entries = [], options = {}) {
  const byRoute = new Map();
  let savedTokens = 0;
  let cny = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const saved = Math.max(0, numberOrZero(entry.savedTokens));
    if (saved === 0) continue;
    const estimate = estimateSavings({
      savedTokens: saved,
      provider: entry.provider,
      model: entry.model,
      mode: options.mode,
      pricing: options.pricing,
      customUnitPricePerMTokens: options.customUnitPricePerMTokens,
    });
    savedTokens += saved;
    cny += estimate.cny;
    if (!byRoute.has(estimate.routeKey)) {
      byRoute.set(estimate.routeKey, {
        routeKey: estimate.routeKey,
        provider: estimate.provider,
        model: estimate.model,
        savedTokens: 0,
        cny: 0,
      });
    }
    const row = byRoute.get(estimate.routeKey);
    row.savedTokens += saved;
    row.cny = round(row.cny + estimate.cny, 6);
  }

  return {
    savedTokens,
    cny: round(cny, 6),
    currency: options.pricing?.currency ?? OFFICIAL_PRICING.currency,
    byRoute: [...byRoute.values()],
  };
}

/**
 * Conservative character-based token estimate (4 characters per token).
 * CJK text is under-priced by this heuristic, which keeps savings conservative.
 *
 * @param {unknown} text - raw text.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  const chars = Array.from(String(text ?? '')).length;
  return chars === 0 ? 0 : Math.ceil(chars / 4);
}

/**
 * Estimate savings from raw and digest text.
 *
 * @param {unknown} rawText - original error text.
 * @param {unknown} digestText - rendered digest text.
 * @returns {{rawTokens: number, digestTokens: number, savedTokens: number}}
 */
export function estimateTextSavings(rawText, digestText) {
  const rawTokens = estimateTokens(rawText);
  const digestTokens = estimateTokens(digestText);
  return computeSavings({ rawTokens, digestTokens });
}

function findRoute(pricing, provider, model) {
  const routes = Array.isArray(pricing?.routes) ? pricing.routes : [];
  const key = routeKey(provider ?? 'deepseek', model ?? 'deepseek-flash');
  const exact = routes.find((route) => routeKey(route.provider, route.model) === key);
  if (exact) return exact;

  const fallback = String(pricing?.unknownRoute ?? 'deepseek/deepseek-flash').split('/');
  const fallbackRoute = routes.find((route) => routeKey(route.provider, route.model) === routeKey(fallback[0], fallback[1]));
  return fallbackRoute ?? routes[0] ?? null;
}

function routeKey(provider, model) {
  return `${String(provider ?? '').trim().toLowerCase()}/${String(model ?? '').trim().toLowerCase()}`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
