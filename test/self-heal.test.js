import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelfHealTracker } from '../lib/self-heal.js';

const failure = {
  sessionId: 's1',
  tool: 'edit',
  turn: 2,
  fingerprint: 'fp',
  failureId: 'F-1',
  hint: 'Read before edit.',
  args: { file_path: 'a.txt', old: 'x' },
};

test('self-heal matches a corrected successful call in the same turn', () => {
  let now = 1000;
  const tracker = createSelfHealTracker({ now: () => now });
  assert.equal(tracker.noteFailure(failure), true);
  now += 500;
  const hit = tracker.noteSuccess({
    sessionId: 's1',
    tool: 'edit',
    turn: 2,
    args: { file_path: 'a.txt', old: 'y' },
  });
  assert.ok(hit);
  assert.equal(hit.failure.failureId, 'F-1');
  assert.equal(tracker.size(), 0);
});

test('self-heal ignores same args, different turn, different tool, and expiry', () => {
  let now = 0;
  const tracker = createSelfHealTracker({ now: () => now, windowMs: 100 });
  tracker.noteFailure(failure);
  assert.equal(tracker.noteSuccess({ ...failure, args: failure.args }), null);
  assert.equal(tracker.noteSuccess({ ...failure, turn: 3, args: { file_path: 'a.txt', old: 'z' } }), null);
  assert.equal(tracker.noteSuccess({ ...failure, tool: 'read', args: { file_path: 'a.txt' } }), null);
  now = 101;
  assert.equal(tracker.noteSuccess({ ...failure, args: { file_path: 'a.txt', old: 'q' } }), null);
  assert.equal(tracker.size(), 0);
});

test('self-heal clear drops the pending failure', () => {
  const tracker = createSelfHealTracker();
  tracker.noteFailure(failure);
  tracker.clear('s1');
  assert.equal(tracker.noteSuccess({ ...failure, args: { file_path: 'a.txt', old: 'z' } }), null);
});
