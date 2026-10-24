/**
 * Token-waste observer for repeated successful tool calls.
 *
 * A repeated identical call is not blocked (A mode): the observer queues one
 * short hint for the next step. The hint queue already deduplicates by session
 * and turn and lets the model change course without another request.
 */

export const TOKEN_WASTE_GUARD = Object.freeze({
  id: 'token-waste-repeat',
  label: '重复调用浪费',
  action: 'hint',
  hint: 'An identical tool call was already executed recently. Reuse the previous result or change the arguments instead of repeating it.',
});

export const TOKEN_WASTE_WINDOW_MS = 120_000;

const IGNORED_TOOLS = new Set([
  'failure_inbox',
  'open_failure_ledger',
  'browser_auth',
]);

/**
 * Create a repeat-call observer.
 *
 * @param {{queue?: object, windowMs?: number, now?: () => number, ignoredTools?: string[]}} [options] - dependencies.
 * @returns {{observe: Function, stats: object, reset: Function}} observer.
 */
export function createTokenWasteGuard(options = {}) {
  const queue = options.queue ?? null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : TOKEN_WASTE_WINDOW_MS;
  const ignored = new Set([
    ...IGNORED_TOOLS,
    ...(Array.isArray(options.ignoredTools) ? options.ignoredTools : []),
  ]);
  const seen = new Map();
  const stats = { observed: 0, repeats: 0, hints: 0, skipped: 0 };

  function observe(input = {}) {
    const tool = input.tool == null ? '' : String(input.tool);
    const sessionId = input.sessionId == null ? '' : String(input.sessionId);
    if (!tool || !sessionId || ignored.has(tool)) {
      stats.skipped += 1;
      return false;
    }
    if (input.isError === true || input.decision?.kind === 'block' || input.decision?.kind === 'deny') {
      stats.skipped += 1;
      return false;
    }
    stats.observed += 1;
    const signature = `${tool}:${stableValue(input.args)}`;
    const key = `${sessionId}\u0000${signature}`;
    const at = now();
    const previous = seen.get(key);
    if (previous != null && at - previous <= windowMs) {
      stats.repeats += 1;
      if (queue?.push?.(sessionId, TOKEN_WASTE_GUARD)) stats.hints += 1;
      return true;
    }
    seen.set(key, at);
    if (seen.size > 1000) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }

  function reset() {
    seen.clear();
    stats.observed = 0;
    stats.repeats = 0;
    stats.hints = 0;
    stats.skipped = 0;
  }

  return { observe, stats, reset };
}

/**
 * Deterministic JSON for a tool-call argument object.
 *
 * @param {unknown} value - parsed arguments.
 * @returns {string} stable signature text.
 */
export function stableValue(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
}
