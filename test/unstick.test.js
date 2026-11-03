import test from 'node:test';
import assert from 'node:assert/strict';

import { UNSTICK_GUARD, createUnstickTracker } from '../lib/unstick.js';

test('unstick fires on the second failure for one session/fingerprint only', () => {
  const tracker = createUnstickTracker();
  const input = { session: 's1', fingerprint: 'fp-a' };
  assert.equal(tracker.observe(input), false);
  assert.equal(tracker.observe(input), true);
  assert.equal(tracker.observe(input), false);
  assert.equal(UNSTICK_GUARD.action, 'hint');
  assert.match(UNSTICK_GUARD.hint, /Same failure twice/);
});

test('unstick keeps sessions and fingerprints separate', () => {
  const tracker = createUnstickTracker();
  tracker.observe({ session: 's1', fingerprint: 'fp-a' });
  assert.equal(tracker.observe({ session: 's2', fingerprint: 'fp-a' }), false);
  assert.equal(tracker.observe({ session: 's1', fingerprint: 'fp-b' }), false);
  assert.equal(tracker.observe({ session: 's2', fingerprint: 'fp-a' }), true);
});

test('unstick ignores missing inputs and bounds its map', () => {
  const tracker = createUnstickTracker({ max: 2 });
  assert.equal(tracker.observe({}), false);
  tracker.observe({ session: 's1', fingerprint: 'a' });
  tracker.observe({ session: 's1', fingerprint: 'b' });
  tracker.observe({ session: 's1', fingerprint: 'c' });
  assert.ok(tracker.size() <= 2);
});
