import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createStore, parseFrontMatter } from '../lib/store.js';

const FIXED = new Date('2026-10-22T06:00:00.000Z');

async function withStore(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-store-'));
  const store = createStore({ root, now: () => FIXED, ...options });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const result = await store.init();
  assert.equal(result.ok, true, result.error);
  return { root, store };
}

async function readJsonl(filePath) {
  let text = '';
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function fileExists(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('init creates the directory tree, seed files, and zero totals', async (t) => {
  const { root, store } = await withStore(t);

  for (const file of ['index.jsonl', 'savings.jsonl', 'anomalies.jsonl', 'playbook.jsonl', 'totals.json']) {
    assert.ok(await fileExists(path.join(root, file)), file);
  }
  for (const directory of ['reports', 'raw', 'handoffs']) {
    const info = await stat(path.join(root, directory));
    assert.equal(info.isDirectory(), true, directory);
  }

  const { totals } = await store.getTotals();
  assert.equal(totals.failures, 0);
  assert.equal(totals.compressions, 0);
  assert.equal(totals.anomalies, 0);
  assert.equal(totals.savedTokens, 0);
  assert.equal(totals.currency, 'CNY');
  assert.deepEqual(totals.byRoute, {});
  assert.deepEqual(totals.byTool, {});
  assert.deepEqual(totals.byRule, {});
});

test('recordFailure appends one index line and aggregates one report', async (t) => {
  const { root, store } = await withStore(t);
  const entry = {
    fingerprint: 'abcdef123456',
    tool: 'pwsh',
    category: 'sandbox-denied',
    severity: 'high',
    route: 'deepseek/deepseek-flash',
    session: 'session-1',
    tokensRaw: 1000,
    tokensDigest: 200,
    raw: 'x'.repeat(500),
    error: 'sandbox: file access denied',
    hint: 'write inside the workspace',
    summary: 'denied',
  };

  const first = await store.recordFailure(entry);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.count, 1);
  assert.ok(first.id.startsWith('F-'));
  assert.equal(first.reportPath, path.join(root, 'reports', 'abcdef123456.md'));

  const index = await readJsonl(path.join(root, 'index.jsonl'));
  assert.equal(index.length, 1);
  assert.equal(index[0].fingerprint, 'abcdef123456');
  assert.equal(index[0].report, 'reports/abcdef123456.md');
  assert.equal(index[0].tokensSaved, 800);

  const report = await store.readReport('abcdef123456');
  assert.ok(report.text.includes('count: 1'));
  assert.ok(report.text.includes('tokens_saved: 800'));
  assert.ok(await fileExists(path.join(root, 'raw', `${first.id}.txt`)));

  const second = await store.recordFailure({ ...entry, tokensRaw: 500, tokensDigest: 100 });
  assert.equal(second.ok, true);
  assert.equal(second.count, 2);

  const reports = (await readdir(path.join(root, 'reports'))).filter((name) => name.endsWith('.md'));
  assert.deepEqual(reports, ['abcdef123456.md']);

  const aggregated = await store.readReport('abcdef123456');
  assert.match(aggregated.text, /count: 2/);
  assert.match(aggregated.text, /tokens_raw: 1500/);
  assert.match(aggregated.text, /tokens_digest: 300/);
  assert.match(aggregated.text, /tokens_saved: 1200/);

  const { totals } = await store.getTotals();
  assert.equal(totals.failures, 2);
  assert.equal(totals.byTool.pwsh.failures, 2);
  assert.equal(totals.byRoute['deepseek/deepseek-flash'].failures, 2);
  assert.equal((await readJsonl(path.join(root, 'index.jsonl'))).length, 2);
});

test('recordSavings and recordAnomaly update monotonic totals and append JSONL', async (t) => {
  const { root, store } = await withStore(t);

  const savings = await store.recordSavings({
    savedTokens: 800,
    rawTokens: 1000,
    digestTokens: 200,
    provider: 'deepseek',
    model: 'deepseek-flash',
    route: 'deepseek/deepseek-flash',
    tool: 'pwsh',
    fingerprint: 'fp-1',
    session: 'session-1',
  });
  assert.equal(savings.ok, true, savings.error);
  assert.equal(savings.savedTokens, 800);

  const anomaly = await store.recordAnomaly({
    ruleId: 'repeatFailure',
    count: 3,
    wastedTokens: 600,
    session: 'session-1',
    evidence: { fingerprint: 'fp-1' },
  });
  assert.equal(anomaly.ok, true, anomaly.error);

  const { totals } = await store.getTotals();
  assert.equal(totals.compressions, 1);
  assert.equal(totals.savedTokens, 800);
  assert.equal(totals.byRoute['deepseek/deepseek-flash'].savedTokens, 800);
  assert.equal(totals.byTool.pwsh.savedTokens, 800);
  assert.equal(totals.anomalies, 1);
  assert.equal(totals.anomalyWastedTokens, 600);
  assert.equal(totals.byRule.repeatFailure, 3);

  const savingsLines = await readJsonl(path.join(root, 'savings.jsonl'));
  assert.equal(savingsLines.length, 1);
  assert.equal(savingsLines[0].savedTokens, 800);
  const anomalyLines = await readJsonl(path.join(root, 'anomalies.jsonl'));
  assert.equal(anomalyLines.length, 1);
  assert.equal(anomalyLines[0].ruleId, 'repeatFailure');
});

test('concurrent failures are serialized without losing lines or counts', async (t) => {
  const { root, store } = await withStore(t);

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) => store.recordFailure({
      fingerprint: `fp-${index}`,
      tool: 'read',
      category: 'not-found',
      tokensRaw: 10,
      tokensDigest: 2,
    })),
  );
  assert.equal(results.every((result) => result.ok), true);

  const index = await readJsonl(path.join(root, 'index.jsonl'));
  assert.equal(index.length, 20);
  assert.equal(new Set(index.map((entry) => entry.fingerprint)).size, 20);
  const { totals } = await store.getTotals();
  assert.equal(totals.failures, 20);
  const reports = (await readdir(path.join(root, 'reports'))).filter((name) => name.endsWith('.md'));
  assert.equal(reports.length, 20);
});

test('JSONL rotation keeps every line across the active file and backups', async (t) => {
  const { root, store } = await withStore(t, { maxBytes: 250 });

  for (let index = 0; index < 8; index += 1) {
    const result = await store.recordFailure({
      fingerprint: `rot-${index}`,
      tool: 'x',
      category: 'unknown',
      summary: 'y'.repeat(80),
      tokensRaw: 10,
    });
    assert.equal(result.ok, true, result.error);
  }

  const names = await readdir(root);
  assert.ok(names.some((name) => name.startsWith('index.jsonl.') && name.endsWith('.bak')));
  const all = [];
  for (const name of names.filter((name) => name.startsWith('index.jsonl'))) {
    all.push(...await readJsonl(path.join(root, name)));
  }
  assert.equal(all.length, 8);
});

test('prune keeps old detail files under the size cap and never shrinks totals', async (t) => {
  const { root, store } = await withStore(t);
  await store.recordFailure({ fingerprint: 'old', tool: 'x', category: 'unknown' });
  await store.recordSavings({ savedTokens: 1234, route: 'deepseek/deepseek-flash' });

  const reportPath = path.join(root, 'reports', 'old.md');
  const old = new Date(FIXED.getTime() - 10 * 86_400_000);
  await utimes(reportPath, old, old);

  const result = await store.prune({ maxTotalBytes: 1024 * 1024 });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.removed, []);
  assert.ok(await fileExists(reportPath));

  const { totals } = await store.getTotals();
  assert.equal(totals.failures, 1);
  assert.equal(totals.savedTokens, 1234);
});

test('write failures return ok:false instead of throwing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-blocked-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const blocked = path.join(root, 'blocked');
  await writeFile(blocked, 'not a directory');

  const store = createStore({ root: blocked, now: () => FIXED });
  const result = await store.recordFailure({ fingerprint: 'fp' });
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
  await store.close();
});

test('the plugin log rotates at its own size limit', async (t) => {
  const { root, store } = await withStore(t, { logMaxBytes: 120 });
  await store.recordPluginError('first error '.repeat(5));
  await store.recordPluginError('second error '.repeat(5));

  const names = await readdir(root);
  assert.ok(names.some((name) => name.startsWith('_plugin.log.') && name.endsWith('.bak')));
  const current = await readFile(path.join(root, '_plugin.log'), 'utf8');
  assert.match(current, /second error/);
});

test('inbox, handoff, playbook, and raw writers stay inside the root', async (t) => {
  const { root, store } = await withStore(t);

  assert.equal((await store.writeInbox('# Inbox\n')).ok, true);
  assert.equal((await store.writeHandoff('session/../1', '# Handoff\n')).ok, true);
  assert.equal((await store.appendPlaybook({ fingerprint: 'fp', fix: 'done' })).ok, true);
  const raw = await store.writeRaw('id/../1', 'z'.repeat(100));
  assert.equal(raw.ok, true);

  assert.match(await readFile(path.join(root, 'INBOX.md'), 'utf8'), /# Inbox/);
  const handoffs = await readdir(path.join(root, 'handoffs'));
  assert.equal(handoffs.length, 1);
  assert.ok(!handoffs[0].includes('..'));
  const playbook = await readJsonl(path.join(root, 'playbook.jsonl'));
  assert.equal(playbook[0].fix, 'done');
  assert.ok((await readFile(raw.path, 'utf8')).length <= 32 * 1024);
});

test('listFailures filters by session and listAnomalies is bounded', async (t) => {
  const { store } = await withStore(t);
  await store.recordFailure({ fingerprint: 'a', session: 's1', tool: 'x', category: 'unknown' });
  await store.recordFailure({ fingerprint: 'b', session: 's2', tool: 'x', category: 'unknown' });
  await store.recordAnomaly({ ruleId: 'repeatFailure', count: 3 });

  const all = await store.listFailures({ limit: 10 });
  assert.equal(all.entries.length, 2);
  assert.equal(all.entries[0].session, 's2');

  const current = await store.listFailures({ limit: 10, scope: 'current', sessionId: 's1' });
  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0].session, 's1');

  const anomalies = await store.listAnomalies({ limit: 1 });
  assert.equal(anomalies.entries.length, 1);
  assert.equal(anomalies.entries[0].ruleId, 'repeatFailure');
});

test('corrupt totals are reported without throwing', async (t) => {
  const { root, store } = await withStore(t);
  await writeFile(path.join(root, 'totals.json'), '{not json');

  const result = await store.getTotals();
  assert.equal(result.ok, true);
  assert.equal(result.totals.failures, 0);
  const log = await readFile(path.join(root, '_plugin.log'), 'utf8');
  assert.ok(log.length > 0);
});

test('missing fingerprint and closed store are refused safely', async (t) => {
  const { store } = await withStore(t);
  const invalid = await store.recordFailure({});
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /fingerprint/i);

  await store.close();
  const closed = await store.recordFailure({ fingerprint: 'fp' });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /closed/i);
});

test('prune enforces the total detail-size cap without shrinking totals', async (t) => {
  const { store, root } = await withStore(t, { maxTotalBytes: 1024 * 1024 });
  await store.recordFailure({
    fingerprint: 'space-cap',
    tool: 'pwsh',
    category: 'unknown',
    severity: 'medium',
    raw: 'x'.repeat(5000),
  });
  const before = await store.getTotals();
  assert.equal(before.totals.failures, 1);

  const result = await store.prune({ maxTotalBytes: 1 });
  assert.equal(result.ok, true);
  assert.ok(result.removed.length > 0);
  assert.deepEqual(await readdir(path.join(root, 'reports')), []);
  assert.deepEqual(await readdir(path.join(root, 'raw')), []);
  const after = await store.getTotals();
  assert.equal(after.totals.failures, 1);
  assert.equal(after.totals.savedTokens, before.totals.savedTokens);
});

test('resolve deletes detail files, hides old occurrences, and keeps totals', async (t) => {
  const { root, store } = await withStore(t);
  await store.recordFailure({
    fingerprint: 'resolve-fp',
    tool: 'edit',
    category: 'unknown',
    raw: 'first raw',
  });
  await store.recordFailure({
    fingerprint: 'resolve-fp',
    tool: 'edit',
    category: 'unknown',
    raw: 'second raw',
  });
  const before = await store.getTotals();
  assert.equal(before.totals.failures, 2);

  const resolved = await store.resolveFailure({ id: 'resolve-fp', fix: 'read before edit' });
  assert.equal(resolved.ok, true, resolved.error);
  assert.ok(resolved.deleted.some((file) => file.endsWith('resolve-fp.md')));
  assert.equal(await fileExists(path.join(root, 'reports', 'resolve-fp.md')), null);
  assert.deepEqual(await readdir(path.join(root, 'raw')), []);

  const list = await store.listFailures({ limit: 10 });
  assert.equal(list.entries.some((entry) => entry.fingerprint === 'resolve-fp'), false);
  const after = await store.getTotals();
  assert.equal(after.totals.failures, 2);
  assert.equal(after.totals.savedTokens, before.totals.savedTokens);
  const playbook = await readJsonl(path.join(root, 'playbook.jsonl'));
  assert.equal(playbook.length, 1);
  assert.equal(playbook[0].fingerprint, 'resolve-fp');
});

test('parseFrontMatter reads the report header', () => {
  const parsed = parseFrontMatter('---\nschema: dsh-failure/1\ncount: 2\nid: "F-1"\n---\n# body');
  assert.equal(parsed.schema, 'dsh-failure/1');
  assert.equal(parsed.count, 2);
  assert.equal(parsed.id, 'F-1');
  assert.equal(parseFrontMatter('no front matter'), null);
});
