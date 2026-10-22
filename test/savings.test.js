import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFICIAL_PRICING,
  PRICE_MODES,
  PRICING_FETCHED_AT,
  PRICING_SOURCE,
  computeSavings,
  estimateSavedCNY,
  estimateSavings,
  estimateTextSavings,
  estimateTokens,
  priceFor,
  summarizeSavings,
} from '../lib/savings.js';

test('official pricing table matches the 2026-10-22 DeepSeek page', () => {
  assert.equal(PRICING_SOURCE, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/');
  assert.equal(PRICING_FETCHED_AT, '2026-10-22');
  assert.deepEqual(
    OFFICIAL_PRICING.routes.map((route) => [route.model, route.inputCacheHitOffPeak, route.inputCacheMissOffPeak, route.outputOffPeak]),
    [
      ['deepseek-flash', 0.02, 1.0, 4.0],
      ['deepseek-v4-pro', 0.15, 4.5, 13.5],
    ],
  );
  assert.equal(OFFICIAL_PRICING.peakMultiplier, 2);
  assert.deepEqual(PRICE_MODES, ['cacheMissOffPeak', 'cacheHitOffPeak', 'peakCacheMiss', 'custom']);
});

test('default price mode is off-peak cache miss for Flash', () => {
  const price = priceFor();
  assert.equal(price.model, 'deepseek-flash');
  assert.equal(price.mode, 'cacheMissOffPeak');
  assert.equal(price.unitPricePerMTokens, 1.0);
  assert.equal(price.currency, 'CNY');
  assert.equal(price.source, PRICING_SOURCE);
  assert.equal(price.fetchedAt, PRICING_FETCHED_AT);
});

test('price modes cover cache hit, peak, and Pro', () => {
  assert.equal(priceFor({ mode: 'cacheHitOffPeak' }).unitPricePerMTokens, 0.02);
  assert.equal(priceFor({ mode: 'peakCacheMiss' }).unitPricePerMTokens, 2.0);
  assert.equal(priceFor({ model: 'deepseek-v4-pro' }).unitPricePerMTokens, 4.5);
  assert.equal(priceFor({ model: 'deepseek-v4-pro', mode: 'cacheHitOffPeak' }).unitPricePerMTokens, 0.15);
  assert.equal(priceFor({ model: 'deepseek-v4-pro', mode: 'peakCacheMiss' }).unitPricePerMTokens, 9.0);
});

test('unknown routes fall back to Flash and invalid modes fall back conservatively', () => {
  const unknown = priceFor({ model: 'does-not-exist' });
  assert.equal(unknown.model, 'deepseek-flash');
  assert.equal(unknown.unitPricePerMTokens, 1.0);

  const invalid = priceFor({ mode: 'not-a-mode' });
  assert.equal(invalid.mode, 'cacheMissOffPeak');
  assert.equal(invalid.unitPricePerMTokens, 1.0);
});

test('custom mode uses the supplied unit price and rejects invalid values', () => {
  assert.equal(priceFor({ mode: 'custom', customUnitPricePerMTokens: 3 }).unitPricePerMTokens, 3);
  assert.equal(priceFor({ mode: 'custom', customUnitPricePerMTokens: 0 }).unitPricePerMTokens, 0);
});

test('computeSavings never returns negative totals', () => {
  assert.deepEqual(computeSavings({ rawTokens: 1000, digestTokens: 200 }), {
    rawTokens: 1000,
    digestTokens: 200,
    savedTokens: 800,
  });
  assert.deepEqual(computeSavings({ rawTokens: 100, digestTokens: 500 }), {
    rawTokens: 100,
    digestTokens: 500,
    savedTokens: 0,
  });
  assert.deepEqual(computeSavings(), { rawTokens: 0, digestTokens: 0, savedTokens: 0 });
});

test('one million saved Flash tokens cost one yuan at the default price', () => {
  assert.equal(estimateSavedCNY({ savedTokens: 1_000_000 }), 1);
  assert.equal(estimateSavedCNY({ savedTokens: 1_000_000, model: 'deepseek-v4-pro' }), 4.5);
  assert.equal(estimateSavedCNY({ savedTokens: 1_000_000, mode: 'peakCacheMiss' }), 2);
  assert.equal(estimateSavedCNY({ savedTokens: 1_000_000, mode: 'cacheHitOffPeak' }), 0.02);
});

test('estimateSavings returns the applied route and price metadata', () => {
  const estimate = estimateSavings({ savedTokens: 500_000, model: 'deepseek-v4-pro' });
  assert.equal(estimate.savedTokens, 500_000);
  assert.equal(estimate.cny, 2.25);
  assert.equal(estimate.routeKey, 'deepseek/deepseek-v4-pro');
  assert.equal(estimate.mode, 'cacheMissOffPeak');
  assert.equal(estimate.unitPricePerMTokens, 4.5);
});

test('summarizeSavings groups by route', () => {
  const summary = summarizeSavings([
    { savedTokens: 1_000_000, provider: 'deepseek', model: 'deepseek-flash' },
    { savedTokens: 500_000, provider: 'deepseek', model: 'deepseek-v4-pro' },
  ]);
  assert.equal(summary.savedTokens, 1_500_000);
  assert.equal(summary.cny, 3.25);
  assert.equal(summary.byRoute.length, 2);
  assert.deepEqual(
    summary.byRoute.map((row) => [row.model, row.savedTokens, row.cny]),
    [
      ['deepseek-flash', 1_000_000, 1],
      ['deepseek-v4-pro', 500_000, 2.25],
    ],
  );
});

test('empty savings summarize to zero', () => {
  assert.deepEqual(summarizeSavings([]), { savedTokens: 0, cny: 0, currency: 'CNY', byRoute: [] });
});

test('token estimation is conservative and bounded', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('一二三四'), 1);
  assert.deepEqual(estimateTextSavings('a'.repeat(40), 'a'.repeat(4)), {
    rawTokens: 10,
    digestTokens: 1,
    savedTokens: 9,
  });
});

test('small amounts round to six decimals', () => {
  assert.equal(estimateSavedCNY({ savedTokens: 1 }), 0.000001);
  assert.equal(estimateSavedCNY({ savedTokens: 10 }), 0.00001);
});
