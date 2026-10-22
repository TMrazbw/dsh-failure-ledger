import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeHostConfig } from '../lib/config-schema.js';
import { SNAPSHOT_ROUTE, buildSnapshot, createSnapshotRoute } from '../lib/snapshot.js';
import { createStore } from '../lib/store.js';

async function withStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-snap-'));
  const store = createStore({ root });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await store.init();
  return { root, store };
}

test('normalizeHostConfig merges defaults, rules, and savings', () => {
  const config = normalizeHostConfig({
    reportRoot: 'D:\\tmp\\ledger',
    digest: { maxInlineTokens: 10 },
    rules: { repeatFailure: { threshold: 5 } },
    report: { maxTotalMB: 25 },
    savings: { priceMode: 'peakCacheMiss', customUnitPricePerMTokens: 3 },
  });
  assert.equal(config.reportRoot, 'D:\\tmp\\ledger');
  assert.equal(config.digest.maxInlineTokens, 10);
  assert.equal(config.digest.maxDetailChars, 200);
  assert.equal(config.report.maxTotalMB, 25);
  assert.equal(config.rules.repeatFailure.threshold, 5);
  assert.equal(config.rules.repeatFailure.windowMinutes, 10);
  assert.equal(config.rules.maxTokens.enabled, true);
  assert.equal(config.savings.priceMode, 'peakCacheMiss');
  assert.equal(config.savings.customUnitPricePerMTokens, 3);

  const fallback = normalizeHostConfig({ savings: { priceMode: 'nope' } });
  assert.equal(fallback.savings.priceMode, 'cacheMissOffPeak');
  assert.equal(fallback.report.maxTotalMB, 100);
  assert.equal(fallback.reportRoot, 'failure-reports');

  const volatileRefs = normalizeHostConfig({
    digest: { maxInlineTokens: { get: () => 12 } },
    rules: { repeatFailure: { threshold: { get: () => 7 } } },
  });
  assert.equal(volatileRefs.digest.maxInlineTokens, 12);
  assert.equal(volatileRefs.rules.repeatFailure.threshold, 7);
});

test('buildSnapshot exposes totals, error sources, rules, and conservative money', async (t) => {
  const { store } = await withStore(t);
  await store.recordFailure({
    fingerprint: 'fp-a',
    tool: 'pwsh',
    category: 'sandbox-denied',
    severity: 'high',
    session: 's1',
    route: 'deepseek/deepseek-flash',
    tokensRaw: 1000,
    tokensDigest: 200,
  });
  await store.recordFailure({
    fingerprint: 'fp-b',
    tool: 'read',
    category: 'not-found',
    severity: 'medium',
    session: 's2',
    route: 'deepseek/deepseek-flash',
  });
  await store.recordSavings({ savedTokens: 800, provider: 'deepseek', model: 'deepseek-flash', route: 'deepseek/deepseek-flash', tool: 'pwsh' });
  await store.recordAnomaly({ ruleId: 'repeatFailure', count: 3, wastedTokens: 600, session: 's1' });

  const config = normalizeHostConfig();
  const snapshot = await buildSnapshot({ store, config, now: new Date('2026-10-22T12:00:00Z') });

  assert.equal(snapshot.schema, 'dsh-failure-snapshot/1');
  assert.equal(snapshot.generatedAt, '2026-10-22T12:00:00.000Z');
  assert.equal(snapshot.totals.failures, 2);
  assert.equal(snapshot.totals.anomalies, 1);
  assert.equal(snapshot.totals.savedTokens, 800);
  assert.equal(snapshot.sessions, 2);
  assert.equal(snapshot.errorSources.byTool.find((row) => row.tool === 'pwsh').failures, 1);
  assert.equal(snapshot.errorSources.byCategory.find((row) => row.category === 'sandbox-denied').failures, 1);
  assert.equal(snapshot.byRoute.length, 1);
  assert.equal(snapshot.byRoute[0].savedTokens, 800);
  assert.equal(snapshot.byRoute[0].cny, 0.0008);
  assert.equal(snapshot.estimatedCNY, 0.0008);
  assert.equal(snapshot.failures.length, 2);
  assert.deepEqual(snapshot.unresolved, { entries: 2, fingerprints: 2 });
  assert.equal(snapshot.anomalies[0].ruleId, 'repeatFailure');
  assert.equal(snapshot.rules.repeatFailure.threshold, 3);
  assert.equal(snapshot.pricing.mode, 'cacheMissOffPeak');
  assert.equal(snapshot.limits.inbox, 20);
});

test('buildSnapshot tolerates a missing store', async () => {
  const snapshot = await buildSnapshot({ store: null, config: {}, now: 0 });
  assert.equal(snapshot.totals.failures, 0);
  assert.deepEqual(snapshot.failures, []);
  assert.deepEqual(snapshot.unresolved, { entries: 0, fingerprints: 0 });
  assert.equal(snapshot.estimatedCNY, 0);
});

test('the snapshot route returns JSON and rejects non-GET requests', async () => {
  const payload = { schema: 'dsh-failure-snapshot/1', totals: { failures: 1 } };
  const route = createSnapshotRoute({ getSnapshot: () => payload });
  assert.equal(route.path, SNAPSHOT_ROUTE);
  assert.deepEqual(Array.from(route.methods), ['GET']);

  const get = await route.fetch(new Request('http://localhost/api/failure-ledger.snapshot'));
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await get.json(), payload);

  const post = await route.fetch(new Request('http://localhost/api/failure-ledger.snapshot', { method: 'POST' }));
  assert.equal(post.status, 405);
  assert.deepEqual(await post.json(), { error: 'method_not_allowed' });
});

test('the snapshot route reports failures as JSON', async () => {
  const route = createSnapshotRoute({ getSnapshot: () => { throw new Error('boom'); } });
  const response = await route.fetch(new Request('http://localhost/api/failure-ledger.snapshot'));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'snapshot_failed');
});
