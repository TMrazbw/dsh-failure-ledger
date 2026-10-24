import test from 'node:test';
import assert from 'node:assert/strict';

import { HINT_TTL_MS, createGuardHintListener, createHintMessage, createHintQueue } from '../lib/hints.js';

const guard = {
  id: 'edit-read-first',
  label: '编辑前读取',
  action: 'hint',
  hint: 'Read the current file before editing.',
};

test('hint queue delivers once and ignores the same turn', () => {
  let now = 1000;
  const queue = createHintQueue({ now: () => now });
  assert.equal(queue.push('s1', guard), true);
  const first = queue.take('s1', 2);
  assert.equal(first.guard.id, 'edit-read-first');
  assert.match(first.text, /Read the current file/);
  assert.equal(queue.take('s1', 2), null);

  queue.push('s1', guard);
  assert.equal(queue.take('s1', 2), null);
  queue.clear('s1');
  assert.equal(queue.take('s1', 3), null);
});

test('hint queue expires and bounds the hint text', () => {
  let now = 0;
  const queue = createHintQueue({ ttlMs: 100, now: () => now });
  queue.push('s2', { ...guard, hint: 'x'.repeat(600) });
  now = 101;
  assert.equal(queue.take('s2', 1), null);

  queue.push('s3', { ...guard, hint: 'x'.repeat(600) });
  const hit = queue.take('s3', 1);
  assert.equal(hit.text.length, 320);
  assert.ok(hit.text.endsWith('…'));
});

test('hint message is compact and identifies the guard', () => {
  const message = createHintMessage({ guard, text: guard.hint });
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'failure-ledger');
  assert.equal(message.source.form, 'guard-hint');
  assert.match(message.content[0].text, /防复发提示/);
  assert.match(message.content[0].text, /编辑前读取/);
});

test('pre-step listener injects one hint only on an entering decision', async () => {
  const queue = createHintQueue({ now: () => 0 });
  const listener = createGuardHintListener({ queue });
  queue.push('s1', guard);
  const entered = await listener(
    { agent: { id: 's1' }, turn: 2 },
    async () => ({ kind: 'enter', messages: [{ role: 'user', id: 'old' }] }),
  );
  assert.equal(entered.kind, 'enter');
  assert.equal(entered.messages.length, 2);
  assert.match(entered.messages[1].content[0].text, /防复发提示/);

  queue.push('s1', guard);
  const rejected = await listener(
    { agent: { id: 's1' }, turn: 3 },
    async () => ({ kind: 'reject' }),
  );
  assert.deepEqual(rejected, { kind: 'reject' });

  queue.push('s2', guard);
  const disabled = await createGuardHintListener({ queue, enabled: false })(
    { agent: { id: 's2' }, turn: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.deepEqual(disabled.messages, []);
});

test('default TTL is bounded', () => {
  assert.equal(HINT_TTL_MS, 60_000);
});
