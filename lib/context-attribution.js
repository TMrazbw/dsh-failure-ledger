/**
 * DFL context-attribution pure functions.
 *
 * This module is deliberately independent of the projection and the client:
 * it folds already-known session events into a small, bounded series so a
 * later step can expose "which step grew the context" without changing model
 * behaviour or compressing anything.
 *
 * Sources are approximate. DSH currently exposes `contextWindow` but not a
 * breakdown of system prompt / tool schemas / history, so attribution uses the
 * nearest preceding context-changing event.
 */

export const CONTEXT_SERIES_LIMIT = 50;
export const CONTEXT_TOOL_NAMES_LIMIT = 50;
export const DEFAULT_CONTEXT_JUMP = Object.freeze({
  minDeltaTokens: 8000,
  minWindowRatio: 0.1,
});

/**
 * Create an empty attribution state.
 *
 * @returns {object} state.
 */
export function createContextAttributionState() {
  return {
    window: 0,
    prevInputTokens: null,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    series: [],
    compactionCount: 0,
    lastSource: null,
    latestJump: null,
    turn: null,
    step: null,
    pendingSource: null,
    toolNames: {},
  };
}

/**
 * Fold one session event into the attribution state.
 *
 * @param {object} state - current state; a fresh state is used when absent.
 * @param {object} event - session event `{type, data, time}`.
 * @returns {object} new state (never mutates the input).
 */
export function applyContextAttribution(state, event) {
  const current = state && typeof state === 'object' ? state : createContextAttributionState();
  if (!event || typeof event.type !== 'string') return current;
  const data = event.data ?? {};
  const at = numberOrNull(event.time);

  switch (event.type) {
    case 'turn/start':
      return { ...current, turn: numberOrNull(data.turn) ?? current.turn };
    case 'step/start':
      return {
        ...current,
        turn: numberOrNull(data.turn) ?? current.turn,
        step: numberOrNull(data.step) ?? current.step,
      };
    case 'tool/call':
      return onToolCall(current, data);
    case 'tool/result':
      return onToolResult(current, event, data, at);
    case 'user/message':
      return {
        ...current,
        pendingSource: {
          source: 'user',
          at,
        },
      };
    case 'request/header':
      return {
        ...current,
        pendingSource: {
          source: 'system-cache',
          reason: data.reason == null ? null : String(data.reason),
          at,
        },
      };
    case 'request/context': {
      const window = numberOrNull(data.contextWindow);
      if (window == null || window <= 0) return current;
      return { ...current, window };
    }
    case 'assistant/message':
      return onAssistantMessage(current, event, data, at);
    default:
      return current;
  }
}

/**
 * Whether one attribution entry should become a `contextJump` anomaly.
 *
 * This is a pure predicate only; Step 12 does not register the rule yet.
 *
 * @param {object} entry - series entry from {@link applyContextAttribution}.
 * @param {{minDeltaTokens?: number, minWindowRatio?: number}} [options] - thresholds.
 * @returns {boolean} true when both thresholds are met.
 */
export function shouldFlagContextJump(entry, options = {}) {
  if (!entry || entry.compaction === true) return false;
  const delta = numberOrNull(entry.delta);
  const window = numberOrNull(entry.window);
  if (delta == null || delta <= 0 || window == null || window <= 0) return false;
  const minDelta = numberOrNull(options.minDeltaTokens) ?? DEFAULT_CONTEXT_JUMP.minDeltaTokens;
  const ratio = numberOrNull(options.minWindowRatio) ?? DEFAULT_CONTEXT_JUMP.minWindowRatio;
  return delta >= minDelta && delta / window >= ratio;
}

function onToolCall(state, data) {
  const callId = data.callId == null ? null : String(data.callId);
  if (callId == null) return state;
  const toolNames = { ...state.toolNames, [callId]: String(data.name ?? 'tool') };
  const keys = Object.keys(toolNames);
  if (keys.length > CONTEXT_TOOL_NAMES_LIMIT) {
    for (const key of keys.slice(0, keys.length - CONTEXT_TOOL_NAMES_LIMIT)) delete toolNames[key];
  }
  return { ...state, toolNames };
}

function onToolResult(state, event, data, at) {
  const message = data.message ?? {};
  const callId = message.toolCallId == null ? null : String(message.toolCallId);
  const tool = callId == null ? null : (state.toolNames[callId] ?? null);
  return {
    ...state,
    pendingSource: {
      source: 'tool',
      tool,
      callId,
      isError: message.isError === true,
      at,
    },
  };
}

function onAssistantMessage(state, event, data, at) {
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') return state;
  const inputTokens = numberOrNull(usage.inputTokens);
  const outputTokens = numberOrNull(usage.outputTokens) ?? 0;
  if (inputTokens == null) return state;

  const previous = numberOrNull(state.prevInputTokens);
  const baseline = previous == null;
  const rawDelta = baseline ? 0 : inputTokens - previous;
  const compaction = rawDelta < 0;
  const source = compaction
    ? { source: 'compaction' }
    : (state.pendingSource ?? { source: baseline ? 'baseline' : 'unknown' });
  const entry = {
    at,
    inputTokens,
    outputTokens,
    cacheReadTokens: numberOrNull(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: numberOrNull(usage.cacheWriteTokens) ?? 0,
    delta: rawDelta,
    window: numberOrNull(state.window) ?? 0,
    source: source.source,
    tool: source.tool ?? null,
    callId: source.callId ?? null,
    reason: source.reason ?? null,
    isError: source.isError === true,
    compaction,
    turn: state.turn,
    step: state.step,
  };
  const series = [...state.series, entry].slice(-CONTEXT_SERIES_LIMIT);
  const latestJump = shouldFlagContextJump(entry) ? entry : state.latestJump;
  return {
    ...state,
    prevInputTokens: inputTokens,
    lastInputTokens: inputTokens,
    lastOutputTokens: outputTokens,
    series,
    compactionCount: state.compactionCount + (compaction ? 1 : 0),
    lastSource: entry.source,
    latestJump,
    pendingSource: null,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
