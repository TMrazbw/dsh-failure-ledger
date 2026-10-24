import test from 'node:test';
import assert from 'node:assert/strict';

import { TOKEN_WASTE_GUARD, createTokenWasteGuard, stableValue } from '../lib/token-waste.js';

function makeQueue() {
  const pushed = [];
  return {
    pushed,
    push(sessionId, guard) {
      pushed.push({ sessionId, id: guard.id });
      return true;
    },
  };
}

test('token-waste guard hints only on a repeated successful call', () => {
  let now = 1000;
  const queue = makeQueue();
  const guard = createTokenWasteGuard({ queue, now: () => now });
  const base = { sessionId: 's1', tool: 'read', args: { file_path: 'a.txt' } };
  assert.equal(guard.observe(base), false);
  assert.equal(queue.pushed.length, 0);
  now += 500;
  assert.equal(guard.observe(base), true);
  assert.deepEqual(queue.pushed, [{ sessionId: 's1', id: TOKEN_WASTE_GUARD.id }]);
  assert.equal(guard.stats.repeats, 1);
});

test('token-waste guard ignores different args, errors, plugins, and expiry', () => {
  let now = 0;
  const queue = makeQueue();
  const guard = createTokenWasteGuard({ queue, now: () => now, windowMs: 100 });
  const base = { sessionId: 's1', tool: 'grep', args: { pattern: 'x' } };
  guard.observe(base);
  assert.equal(guard.observe({ ...base, args: { pattern: 'y' } }), false);
  assert.equal(guard.observe({ ...base, isError: true }), false);
  assert.equal(guard.observe({ ...base, tool: 'failure_inbox' }), false);
  now = 200;
  assert.equal(guard.observe(base), false);
  assert.equal(queue.pushed.length, 0);
});

test('token-waste guard is scoped by session', () => {
  const queue = makeQueue();
  const guard = createTokenWasteGuard({ queue });
  const base = { tool: 'read', args: { file_path: 'a.txt' } };
  assert.equal(guard.observe({ ...base, sessionId: 's1' }), false);
  assert.equal(guard.observe({ ...base, sessionId: 's2' }), false);
  assert.equal(queue.pushed.length, 0);
});

test('stableValue is deterministic', () => {
  assert.equal(stableValue({ b: 1, a: [2, { d: 4, c: 3 }] }), stableValue({ a: [2, { c: 3, d: 4 }], b: 1 }));
});
