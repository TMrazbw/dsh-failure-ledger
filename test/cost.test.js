import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateUsageCost } from '../lib/cost.js';

test('flash input and output use the published off-peak prices', () => {
  assert.equal(estimateUsageCost({ inputTokens: 1_000_000 }, {}).cny, 1);
  assert.equal(estimateUsageCost({ outputTokens: 1_000_000 }, {}).cny, 4);
});

test('cache reads are billed at the cache-hit price', () => {
  const cost = estimateUsageCost({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, {});
  assert.equal(cost.cny, 0.02);
});

test('cache writes are conservatively billed at the miss price', () => {
  const cost = estimateUsageCost({ inputTokens: 0, cacheWriteTokens: 1_000_000 }, {});
  assert.equal(cost.cny, 1);
});

test('the pro route uses its own prices', () => {
  const cost = estimateUsageCost({ inputTokens: 1_000_000 }, { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(cost.cny, 4.5);
  assert.equal(cost.routeKey, 'deepseek/deepseek-v4-pro');
});

test('unknown routes fall back to flash and empty usage is free', () => {
  const cost = estimateUsageCost({ inputTokens: 1_000_000 }, { provider: 'other', model: 'unknown' });
  assert.equal(cost.routeKey, 'deepseek/deepseek-flash');
  assert.equal(cost.cny, 1);
  assert.equal(estimateUsageCost({}, {}).cny, 0);
});
