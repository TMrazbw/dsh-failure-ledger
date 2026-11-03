/**
 * DFL — "same failure twice" unstick hint.
 *
 * The hint is emitted once per (session, fingerprint) when the second persisted
 * failure arrives. It never blocks a tool and does not call a model.
 */

export const UNSTICK_GUARD = Object.freeze({
  id: 'unstick-repeat',
  label: '同错两次',
  action: 'hint',
  hint: 'Same failure twice: write the shared assumption, run one minimal probe, list 3 different mechanisms, then clean up and restart. Do not try a third variant. Full method: call ds_skill("unstick") if that tool exists.',
});

export const UNSTICK_MAX_TRACKED = 500;

/**
 * Create a small in-memory repeat tracker.
 *
 * @param {{max?: number}} [options] - bound.
 * @returns {{observe: Function, reset: Function, size: Function}} tracker.
 */
export function createUnstickTracker(options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : UNSTICK_MAX_TRACKED;
  const counts = new Map();
  const hinted = new Set();

  function observe(input = {}) {
    const session = input.session == null ? '' : String(input.session);
    const fingerprint = input.fingerprint == null ? '' : String(input.fingerprint);
    if (!session || !fingerprint) return false;
    const key = `${session}\u0000${fingerprint}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (counts.size > max) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    if (count === 2 && !hinted.has(key)) {
      hinted.add(key);
      if (hinted.size > max) {
        const oldest = hinted.values().next().value;
        if (oldest !== undefined) hinted.delete(oldest);
      }
      return true;
    }
    return false;
  }

  function reset() {
    counts.clear();
    hinted.clear();
  }

  function size() {
    return counts.size;
  }

  return { observe, reset, size };
}
