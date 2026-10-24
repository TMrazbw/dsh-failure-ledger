import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDigestHandler } from '../lib/digest.js';
import { estimateTokens } from '../lib/savings.js';
import { createStore } from '../lib/store.js';

function fakeStore() {
  const failures = [];
  const savings = [];
  return {
    failures,
    savings,
    reportPathFor(fingerprint) {
      return `/tmp/reports/${fingerprint}.md`;
    },
    async recordFailure(entry) {
      failures.push(entry);
      return { ok: true };
    },
    async recordSavings(entry) {
      savings.push(entry);
      return { ok: true };
    },
  };
}

function makeExec(overrides = {}) {
  const session = {
    id: 'session-1',
    header: { parentSession: 'parent-1', origin: 'subagent' },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }),
  };
  return {
    name: 'pwsh',
    callId: 'call-1',
    rootCallId: 'call-1',
    arguments: { command: 'echo hi', apiKey: 'sk-abcdefghijklmnop' },
    agent: { id: 'session-1', session },
    ...overrides,
  };
}

function failureResult(text = 'sandbox: file access denied', overrides = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    error: {
      message: 'sandbox: file access denied under workspace-write mode',
      info: { code: 'EACCES', name: 'PermissionError' },
    },
    ...overrides,
  };
}

const accept = async () => ({ kind: 'accept' });

test('large text errors are replaced by a bounded digest and persisted once', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 50 } });
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), accept);

  assert.equal(decision.kind, 'accept');
  assert.equal(decision.content.length, 1);
  assert.match(decision.content[0].text, /^\[dsh-failure-ledger\] pwsh failed · SANDBOX-DENIED/);
  assert.ok(estimateTokens(decision.content[0].text) <= 200);
  assert.equal(decision.additionalContexts, undefined);
  assert.match(decision.content[0].text, /Report: \/tmp\/reports\/[0-9a-f]{12}\.md/);

  assert.equal(store.failures.length, 1);
  const entry = store.failures[0];
  assert.equal(entry.tool, 'pwsh');
  assert.equal(entry.category, 'sandbox-denied');
  assert.equal(entry.code, 'EACCES');
  assert.equal(entry.route, 'deepseek/deepseek-flash');
  assert.equal(entry.session, 'session-1');
  assert.equal(entry.parent, 'parent-1');
  assert.equal(entry.agentKind, 'subagent');
  assert.ok(entry.tokensRaw > 50);
  assert.equal(entry.tokensDigest, estimateTokens(decision.content[0].text));
  assert.match(entry.context, /\[REDACTED_TOKEN\]/);
  assert.doesNotMatch(entry.context, /sk-abcdefghijklmnop/);

  assert.equal(store.savings.length, 1);
  assert.equal(store.savings[0].savedTokens, entry.tokensRaw - entry.tokensDigest);
  assert.ok(store.savings[0].savedTokens > 0);
});

test('default content blocks are still compressed when unchanged', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 50 } });
  const result = failureResult('y'.repeat(4000));
  const decision = await handler.listener(
    makeExec({ callId: 'real-default' }),
    result,
    async () => ({ kind: 'accept', content: result.content }),
  );

  assert.match(decision.content[0].text, /^\[dsh-failure-ledger\] pwsh failed/);
  assert.equal(store.savings.length, 1);
  assert.ok(store.savings[0].savedTokens > 0);
});

test('shell non-zero exits are treated as failures and compressed', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 50 } });
  const content = [{ type: 'text', text: `${'Q'.repeat(4000)}\n[exit code: 1]\n` }];
  const result = { isError: false, value: content.map((block) => block.text).join(''), content };
  const decision = await handler.listener(
    makeExec({ callId: 'shell-nonzero' }),
    result,
    async () => ({ kind: 'accept', content: result.content }),
  );

  assert.match(decision.content[0].text, /^\[dsh-failure-ledger\] pwsh failed/);
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 1);
  assert.ok(store.savings[0].savedTokens > 0);
});

test('a zero exit shell result is not a failure', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 50 } });
  const result = { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] };
  const decision = await handler.listener(makeExec({ callId: 'shell-zero' }), result, accept);

  assert.deepEqual(decision, { kind: 'accept' });
  assert.equal(store.failures.length, 0);
  assert.equal(store.savings.length, 0);
});

test('small errors keep their content and gain one plugin hint', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 250 } });
  const decision = await handler.listener(makeExec({ callId: 'small' }), failureResult('boom', {
    content: [{ type: 'text', text: 'boom' }],
    error: { message: 'boom' },
  }), accept);

  assert.equal(decision.kind, 'accept');
  assert.equal(decision.content, undefined);
  assert.equal(decision.additionalContexts.length, 1);
  const context = decision.additionalContexts[0];
  assert.equal(context.role, 'user');
  assert.equal(context.source.kind, 'failure-ledger');
  assert.equal(context.source.form, 'notice');
  assert.match(context.content[0].text, /^\[dsh-failure-ledger\]/);
  assert.match(context.content[0].text, /Report: /);
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 0);
  assert.equal(handler.stats.hints, 1);
});

test('image-bearing errors are not replaced, only hinted', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 10 } });
  const result = {
    isError: true,
    content: [{ type: 'image', attachment: { attachmentId: 'a' } }, { type: 'text', text: 'screenshot' }],
    error: { message: 'browser failed' },
  };
  const decision = await handler.listener(makeExec({ callId: 'image' }), result, accept);

  assert.equal(decision.content, undefined);
  assert.equal(decision.additionalContexts.length, 1);
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 0);
});

test('a downstream block decision is preserved untouched', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store });
  const block = { kind: 'block', feedback: [{ type: 'text', text: 'denied by policy' }] };
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), async () => block);

  assert.equal(decision, block);
  assert.equal(store.failures.length, 0);
  assert.equal(handler.stats.skipped, 1);
});

test('downstream content replacements are not overwritten', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 10 } });
  const custom = { kind: 'accept', content: [{ type: 'text', text: 'already rewritten' }] };
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), async () => custom);

  assert.equal(decision, custom);
  assert.equal(decision.content[0].text, 'already rewritten');
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 0);
});

test('tool-result callback observes both successes and failures', async () => {
  const observed = [];
  const handler = createDigestHandler({
    onToolResult: (exec, result) => observed.push({ name: exec.name, isError: result.isError === true }),
  });
  await handler.listener(makeExec(), { isError: false, content: [{ type: 'text', text: 'ok' }] }, accept);
  await handler.listener(makeExec({ callId: 'bad' }), failureResult(), accept);
  assert.deepEqual(observed, [
    { name: 'pwsh', isError: false },
    { name: 'pwsh', isError: true },
  ]);
});

test('successful results and synthetic aborted results are ignored', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store });

  const success = await handler.listener(makeExec(), { isError: false, content: [{ type: 'text', text: 'ok' }] }, accept);
  assert.equal(success.kind, 'accept');

  const aborted = await handler.listener(makeExec({ callId: 'aborted' }), {
    isError: true,
    content: [{ type: 'text', text: 'aborted before dispatch' }],
    error: { message: 'tool call aborted before dispatch', info: { code: 'ABORTED_BEFORE_DISPATCH', name: 'Aborted' } },
  }, accept);
  assert.equal(aborted.kind, 'accept');

  assert.equal(store.failures.length, 0);
});

test('duplicate call ids are processed once', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store });
  const exec = makeExec({ callId: 'dup' });
  const result = failureResult('boom', { content: [{ type: 'text', text: 'boom' }], error: { message: 'boom' } });

  const first = await handler.listener(exec, result, accept);
  const second = await handler.listener(exec, result, accept);

  assert.equal(first.additionalContexts.length, 1);
  assert.equal(second.additionalContexts, undefined);
  assert.equal(store.failures.length, 1);
  assert.equal(handler.stats.duplicate, 1);
});

test('existing additional contexts are preserved', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store });
  const existing = { id: 'existing', role: 'user', content: [{ type: 'text', text: 'existing' }], source: { kind: 'user' } };
  const decision = await handler.listener(makeExec({ callId: 'context' }), failureResult('boom', {
    content: [{ type: 'text', text: 'boom' }],
    error: { message: 'boom' },
  }), async () => ({ kind: 'accept', additionalContexts: [existing] }));

  assert.equal(decision.additionalContexts.length, 2);
  assert.equal(decision.additionalContexts[0], existing);
  assert.equal(decision.additionalContexts[1].source.kind, 'failure-ledger');
});

test('disabled digest still records failures but changes nothing visible', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { enabled: false } });
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), accept);

  assert.equal(decision.content, undefined);
  assert.equal(decision.additionalContexts, undefined);
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 0);
  assert.equal(handler.stats.compressed, 0);
});

test('persistence errors do not escape or hide the digest', async () => {
  const store = fakeStore();
  store.recordFailure = async () => {
    throw new Error('disk full');
  };
  const errors = [];
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 10 }, onError: (error) => errors.push(error) });
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), accept);

  assert.equal(decision.content.length, 1);
  assert.equal(errors.length >= 1, true);
  assert.match(errors[0].message, /disk full/);
});

test('minSeverity suppresses digest and hint for lower-severity failures', async () => {
  const store = fakeStore();
  const handler = createDigestHandler({ store, config: { maxInlineTokens: 10, minSeverity: 'high' } });
  const result = failureResult('x'.repeat(4000), {
    error: { message: 'ENOENT: no such file or directory', info: { code: 'ENOENT', name: 'NotFound' } },
  });
  const decision = await handler.listener(makeExec(), result, accept);

  assert.equal(decision.content, undefined);
  assert.equal(decision.additionalContexts, undefined);
  assert.equal(store.failures.length, 1);
  assert.equal(store.savings.length, 0);
  assert.equal(handler.stats.compressed, 0);
});

test('a real store receives the failure, report, and savings end to end', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-digest-'));
  const store = createStore({ root });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await store.init();

  const guardHits = [];
  const handler = createDigestHandler({
    store,
    config: { maxInlineTokens: 50 },
    onGuardHit: (hit) => guardHits.push(hit),
  });
  const decision = await handler.listener(makeExec(), failureResult('x'.repeat(4000)), accept);
  assert.equal(decision.content.length, 1);
  assert.equal(guardHits.length, 1);
  assert.equal(guardHits[0].guard.id, 'sandbox-boundary');

  const paths = store.getPaths();
  const index = (await readFile(paths.index, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(index.length, 1);
  assert.match(index[0].fingerprint, /^[0-9a-f]{12}$/);

  const reportPath = path.join(root, index[0].report);
  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /^---\n/);
  assert.match(report, /count: 1/);
  assert.match(report, /tokens_saved: \d+/);

  const totals = (await store.getTotals()).totals;
  assert.equal(totals.failures, 1);
  assert.ok(totals.savedTokens > 0);

  const savings = (await readFile(paths.savings, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(savings.length, 1);
  assert.ok(savings[0].savedTokens > 0);

  const guardHit = JSON.parse((await readFile(paths.guardHits, 'utf8')).trim());
  assert.equal(guardHit.guardId, 'sandbox-boundary');
  assert.equal(guardHit.fingerprint, index[0].fingerprint);
});
