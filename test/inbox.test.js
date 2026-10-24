import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDigestHandler } from '../lib/digest.js';
import { createFailureInboxTool, refreshInbox, runFailureInbox } from '../lib/inbox.js';
import { createStore } from '../lib/store.js';

async function withStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-inbox-'));
  const store = createStore({ root });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await store.init();
  return { root, store };
}

async function seed(store) {
  const first = await store.recordFailure({
    fingerprint: 'fp-a',
    tool: 'pwsh',
    category: 'sandbox-denied',
    severity: 'high',
    session: 's1',
    tokensRaw: 1000,
    tokensDigest: 200,
    error: 'sandbox: file access denied',
    hint: 'write inside the workspace',
    summary: 'denied',
  });
  const second = await store.recordFailure({
    fingerprint: 'fp-b',
    tool: 'read',
    category: 'not-found',
    session: 's2',
    tokensRaw: 500,
    tokensDigest: 100,
    error: 'ENOENT',
    summary: 'missing',
  });
  const third = await store.recordFailure({
    fingerprint: 'fp-c',
    tool: 'pwsh',
    category: 'timeout',
    session: 's1',
    tokensRaw: 300,
    tokensDigest: 100,
    error: 'timed out',
    summary: 'timeout',
  });
  return { first, second, third };
}

test('refreshInbox writes a bounded INBOX.md with the ledger summary', async (t) => {
  const { store } = await withStore(t);
  await seed(store);
  await store.recordSavings({ savedTokens: 800, route: 'deepseek/deepseek-flash' });

  const result = await refreshInbox(store);
  assert.equal(result.ok, true, result.error);
  const text = await readFile(store.getPaths().inbox, 'utf8');
  assert.match(text, /^# Failure Inbox — 3 new, 3 total, est\. 800 tokens saved/m);
  assert.match(text, /\| F-/);
  assert.match(text, /sandbox-denied/);

  const rows = text.split('\n').filter((line) => line.startsWith('| F-'));
  assert.equal(rows.length, 3);
});

test('list filters by current session and all sessions within its line budget', async (t) => {
  const { store } = await withStore(t);
  const { first, second } = await seed(store);

  const current = await runFailureInbox({ store, sessionId: 's1', args: { action: 'list', scope: 'current', limit: 5 } });
  assert.match(current, new RegExp(first.id));
  assert.doesNotMatch(current, new RegExp(second.id));
  assert.ok(current.split('\n').length <= 10);

  const all = await runFailureInbox({ store, sessionId: 's1', args: { action: 'list', scope: 'all', limit: 8 } });
  assert.match(all, new RegExp(first.id));
  assert.match(all, new RegExp(second.id));
  assert.ok(all.split('\n').length <= 10);

  const noSession = await runFailureInbox({ store, sessionId: null, args: { action: 'list', scope: 'current' } });
  assert.match(noSession, /scope="all"/);
});

test('show returns at most 60 report lines plus the report path', async (t) => {
  const { store } = await withStore(t);
  const { first } = await seed(store);

  const shown = await runFailureInbox({ store, args: { action: 'show', id: first.id, scope: 'all' } });
  assert.match(shown, /^---\n/);
  assert.match(shown, /count: 1/);
  assert.match(shown, /Report: reports\//);
  const lines = shown.split('\n');
  assert.ok(lines.length <= 61);

  const missing = await runFailureInbox({ store, args: { action: 'show', id: 'missing-id', scope: 'all' } });
  assert.match(missing, /not found/i);

  const noId = await runFailureInbox({ store, args: { action: 'show', scope: 'all' } });
  assert.match(noId, /requires id/i);
});

test('resolve deletes detail files, writes the playbook, and refreshes INBOX', async (t) => {
  const { store } = await withStore(t);
  const { first } = await seed(store);

  const resolved = await runFailureInbox({
    store,
    args: { action: 'resolve', id: first.id, fix: 'write inside the workspace', scope: 'all' },
  });
  assert.match(resolved, /^Resolved F-/);
  assert.match(resolved, /Guard learned-fp-a/);
  assert.match(resolved, /regression regressions\/fp-a\.md/);

  const report = await store.readReport('fp-a');
  assert.equal(report.text, null);
  const playbook = await readFile(store.getPaths().playbook, 'utf8');
  assert.match(playbook, /write inside the workspace/);
  assert.match(playbook, /fp-a/);

  const inbox = await readFile(store.getPaths().inbox, 'utf8');
  assert.match(inbox, /Failure Inbox/);

  const shown = await runFailureInbox({ store, args: { action: 'show', id: first.id, scope: 'all' } });
  assert.match(shown, /\(report missing\)/);
});

test('resolve validates id and fix', async (t) => {
  const { store } = await withStore(t);
  const { first } = await seed(store);
  assert.match(await runFailureInbox({ store, args: { action: 'resolve', scope: 'all' } }), /requires id/i);
  assert.match(await runFailureInbox({ store, args: { action: 'resolve', id: first.id, scope: 'all' } }), /requires a non-empty fix/i);
});

test('stats stays within 15 lines and includes session numbers', async (t) => {
  const { store } = await withStore(t);
  await seed(store);
  await store.recordSavings({ savedTokens: 900, route: 'deepseek/deepseek-flash', tool: 'pwsh' });
  await store.recordAnomaly({ ruleId: 'repeatFailure', count: 3, wastedTokens: 600 });

  const stats = await runFailureInbox({
    store,
    args: { action: 'stats' },
    sessionStats: { n1: 2, n2: 1, savedTokens: 50 },
  });
  assert.match(stats, /failures: 3/);
  assert.match(stats, /anomalies: 1/);
  assert.match(stats, /saved tokens: 900/);
  assert.match(stats, /session: n1=2 n2=1 saved=50/);
  assert.ok(stats.split('\n').length <= 15);
});

test('playbook returns bounded resolved fixes', async (t) => {
  const { store } = await withStore(t);
  const { first } = await seed(store);
  const resolved = await runFailureInbox({
    store,
    args: { action: 'resolve', id: first.id, fix: 'write inside the workspace', scope: 'all' },
  });
  assert.match(resolved, /^Resolved F-/);

  const playbook = await runFailureInbox({ store, args: { action: 'playbook', limit: 5 } });
  assert.match(playbook, /^Playbook — 1 recent resolved fixes/);
  assert.match(playbook, /fp-a/);
  assert.match(playbook, /learned-fp-a/);
  assert.match(playbook, /write inside the workspace/);
  assert.ok(playbook.split('\n').length <= 10);
});

test('unresolved groups open fingerprints and stays bounded', async (t) => {
  const { store } = await withStore(t);
  const { first } = await seed(store);
  await runFailureInbox({
    store,
    args: { action: 'resolve', id: first.id, fix: 'fixed', scope: 'all' },
  });

  const text = await runFailureInbox({ store, args: { action: 'unresolved', limit: 8 } });
  assert.match(text, /^Unresolved — 2 fingerprints, 2 entries/);
  assert.doesNotMatch(text, /fp-a/);
  assert.match(text, /fp-b/);
  assert.ok(text.split('\n').length <= 10);
});

test('the failure_inbox tool has the expected schema and executes with the session', async (t) => {
  const { store } = await withStore(t);
  const { first, second } = await seed(store);
  const tool = createFailureInboxTool({
    store,
    getSessionStats: () => ({ n1: 2, n2: 1, savedTokens: 10 }),
  });

  assert.equal(tool.name, 'failure_inbox');
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'unresolved', 'show', 'resolve', 'stats', 'playbook']);
  assert.equal(tool.parameters.required[0], 'action');
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(typeof tool.execute, 'function');

  const agent = { id: 's1', session: { id: 's1' } };
  const list = await tool.execute({ action: 'list', scope: 'current' }, { agent });
  assert.match(list, new RegExp(first.id));
  assert.doesNotMatch(list, new RegExp(second.id));

  const stats = await tool.execute({ action: 'stats' }, { agent });
  assert.match(stats, /session: n1=2 n2=1 saved=10/);
});

test('digest persistence triggers an INBOX refresh when wired', async (t) => {
  const { store } = await withStore(t);
  const handler = createDigestHandler({
    store,
    onPersisted: () => refreshInbox(store),
  });
  const exec = {
    name: 'pwsh',
    callId: 'call-1',
    rootCallId: 'call-1',
    arguments: {},
    agent: {
      id: 'session-1',
      session: {
        id: 'session-1',
        header: {},
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }),
      },
    },
  };
  const result = {
    isError: true,
    content: [{ type: 'text', text: 'sandbox: file access denied' }],
    error: { message: 'sandbox: file access denied', info: { code: 'EACCES', name: 'PermissionError' } },
  };

  const decision = await handler.listener(exec, result, async () => ({ kind: 'accept' }));
  assert.equal(decision.kind, 'accept');
  const inbox = await readFile(store.getPaths().inbox, 'utf8');
  assert.match(inbox, /Failure Inbox/);
  assert.match(inbox, /\| F-/);
});
