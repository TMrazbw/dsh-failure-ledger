/**
 * Pure fold of committed session events into failure/anomaly statistics.
 *
 * The fold is deterministic and replayable: every value it needs is present in
 * the log. Large-error digests carry a compact `Tokens: raw · digest · saved`
 * line, which lets a replayed projection recover the session's savings without
 * a side table.
 */

import { classifyError } from './classify.js';
import { fingerprint } from './fingerprint.js';
import { DFL_UI_COMMAND, OPEN_PANEL_TOOL_NAME } from './inbox.js';
import { evaluateRules } from './rules.js';
import { estimateTokens } from './savings.js';

export const ANOMALY_STATE_VERSION = 1;

const MAX_RECENT_FAILURES = 50;
const MAX_LARGE_ERRORS = 20;
const MAX_TOOL_NAMES = 500;
const MAX_RETRY_CODES = 5;

/**
 * Create the initial host-side state for one session.
 *
 * @param {{id?: string, origin?: string, parentSession?: string|null, createdAt?: number}} [header] - session header facts.
 * @returns {object} fresh state.
 */
export function createAnomalyState(header = {}) {
  return {
    version: ANOMALY_STATE_VERSION,
    sessionId: header.id ?? null,
    agentKind: header.origin === 'subagent' ? 'subagent' : 'root',
    parentSession: header.parentSession ?? null,
    createdAt: numberOrZero(header.createdAt),
    lastEventAt: 0,
    turns: 0,
    steps: 0,
    n1: 0,
    failuresByTool: {},
    failuresByCategory: {},
    recentFailures: [],
    savedTokens: 0,
    compressed: 0,
    turnN1: 0,
    turnSavedTokens: 0,
    turnCompressed: 0,
    retries: { attempts: 0, promptTokens: 0, codes: [] },
    largeErrors: [],
    lastRequest: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    },
    pressure: { projectedTokens: 0, contextWindow: 0 },
    turn: { number: null, reason: null, steps: 0 },
    lastFailureAt: 0,
    lastTurnEndAt: 0,
    idle: { stepsWithoutProgress: 0, tokens: 0 },
    toolNames: {},
    openCallIds: {},
    panelOpenSeq: 0,
    lastPanelRequestAt: 0,
    currentStepHadSuccess: true,
  };
}

/**
 * Fold one committed session event. Returns the same state reference for
 * events this unit does not consume.
 *
 * @param {object} state - prior state.
 * @param {{type: string, data?: object, time?: number}} event - committed event.
 * @returns {object} next state (or the same reference).
 */
export function applyAnomalyEvent(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state;
  const data = event.data ?? {};
  switch (event.type) {
    case 'turn/start':
      return onTurnStart(state, event, data);
    case 'step/start':
      return onStepStart(state, event, data);
    case 'user/message':
      return bump(state, event, {
        idle: { stepsWithoutProgress: 0, tokens: 0 },
        currentStepHadSuccess: true,
      });
    case 'tool/call':
      return onToolCall(state, event, data);
    case 'tool/result':
      return onToolResult(state, event, data);
    case 'command/run':
      return onCommandRun(state, event, data);
    case 'assistant/message':
      return onAssistantMessage(state, event, data);
    case 'request/header':
      return onRequestHeader(state, event, data);
    case 'request/context':
      return onRequestContext(state, event, data);
    case 'llm/retry':
      return onRetry(state, event, data);
    case 'turn/end':
      return onTurnEnd(state, event, data);
    default:
      return state;
  }
}

/**
 * Build the compact client-facing view (and the anomaly evaluation) for one
 * session state.
 *
 * @param {object} state - host state.
 * @param {{rules?: object}} [options] - rule config.
 * @returns {object} view payload.
 */
export function createAnomalyView(state, options = {}) {
  const evaluation = evaluateRules({
    now: state.lastEventAt || state.createdAt || 0,
    recentFailures: state.recentFailures,
    largeErrors: state.largeErrors,
    retries: state.retries,
    lastRequest: state.lastRequest,
    pressure: state.pressure,
    turn: { reason: state.turn.reason },
    subagents: [],
    idle: state.idle,
  }, options.rules ?? {});

  const byRule = {};
  for (const [ruleId, hits] of Object.entries(evaluation.byRule)) byRule[ruleId] = hits.length;

  return {
    version: 1,
    sessionId: state.sessionId,
    agentKind: state.agentKind,
    parentSession: state.parentSession,
    n1: state.n1,
    n2: evaluation.hits.length,
    byRule,
    anomalies: evaluation.hits.slice(0, 5).map((hit) => ({
      ruleId: hit.ruleId,
      count: hit.count,
      wastedTokens: hit.wastedTokens,
    })),
    anomalyWastedTokens: evaluation.wastedTokens,
    savedTokens: state.savedTokens,
    compressed: state.compressed,
    turnN1: numberOrZero(state.turnN1),
    turnSavedTokens: numberOrZero(state.turnSavedTokens),
    turnCompressed: numberOrZero(state.turnCompressed),
    turns: state.turns,
    steps: state.steps,
    usage: { ...state.usage },
    retries: { attempts: state.retries.attempts, codes: [...state.retries.codes] },
    lastFailureAt: state.lastFailureAt,
    lastTurnEndAt: state.lastTurnEndAt,
    panelOpenSeq: state.panelOpenSeq,
    lastPanelRequestAt: state.lastPanelRequestAt,
    turn: { number: state.turn.number, reason: state.turn.reason },
    updatedAt: state.lastEventAt,
  };
}

/**
 * Sum views across sessions (parent + subagents), counting each session id once.
 *
 * @param {object[]} views - views from {@link createAnomalyView}.
 * @returns {object} aggregate.
 */
export function aggregateAnomalyViews(views = []) {
  const seen = new Set();
  const total = {
    sessions: 0,
    rootSessions: 0,
    subagentSessions: 0,
    n1: 0,
    n2: 0,
    savedTokens: 0,
    compressed: 0,
    anomalyWastedTokens: 0,
    byRule: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requests: 0,
    },
  };

  for (const view of Array.isArray(views) ? views : []) {
    if (!view || typeof view !== 'object') continue;
    const id = view.sessionId == null ? `unknown-${total.sessions}` : String(view.sessionId);
    if (seen.has(id)) continue;
    seen.add(id);
    total.sessions += 1;
    if (view.agentKind === 'subagent') total.subagentSessions += 1;
    else total.rootSessions += 1;
    total.n1 += numberOrZero(view.n1);
    total.n2 += numberOrZero(view.n2);
    total.savedTokens += numberOrZero(view.savedTokens);
    total.compressed += numberOrZero(view.compressed);
    total.anomalyWastedTokens += numberOrZero(view.anomalyWastedTokens);
    for (const [ruleId, count] of Object.entries(view.byRule ?? {})) {
      total.byRule[ruleId] = (total.byRule[ruleId] ?? 0) + numberOrZero(count);
    }
    for (const key of Object.keys(total.usage)) {
      total.usage[key] += numberOrZero(view.usage?.[key]);
    }
  }

  return total;
}

/**
 * Parse the compact savings marker emitted by `renderDigest`.
 *
 * @param {unknown} value - tool result text.
 * @returns {number} saved tokens, or 0.
 */
export function parseSavedTokens(value) {
  const text = String(value ?? '');
  const marker = /Tokens: (\d+) raw \u00b7 (\d+) digest \u00b7 (\d+) saved/.exec(text);
  if (marker) return numberOrZero(marker[3]);
  const legacy = /(?:^|\n)Saved: (\d+) tokens/.exec(text);
  return legacy ? numberOrZero(legacy[1]) : 0;
}

function onTurnStart(state, event, data) {
  return bump(state, event, {
    turns: state.turns + 1,
    turn: { number: numberOrZero(data.turn), reason: null, steps: 0 },
    turnN1: 0,
    turnSavedTokens: 0,
    turnCompressed: 0,
    idle: { stepsWithoutProgress: 0, tokens: 0 },
    currentStepHadSuccess: true,
  });
}

function onStepStart(state, event, data) {
  const idle = state.steps > 0 && state.currentStepHadSuccess === false
    ? {
      stepsWithoutProgress: state.idle.stepsWithoutProgress + 1,
      tokens: state.idle.tokens + numberOrZero(state.lastRequest?.inputTokens),
    }
    : state.idle;
  const turnNumber = numberOrZero(data.turn);
  const largeErrors = state.largeErrors.map((entry) => (
    entry.turn === turnNumber ? { ...entry, stepsAfter: entry.stepsAfter + 1 } : entry
  ));
  return bump(state, event, {
    steps: state.steps + 1,
    turn: { ...state.turn, steps: state.turn.steps + 1 },
    idle,
    largeErrors,
    currentStepHadSuccess: false,
  });
}

function onToolCall(state, event, data) {
  const callId = data.callId == null ? null : String(data.callId);
  if (callId == null) return state;
  const toolNames = { ...state.toolNames, [callId]: String(data.name ?? 'tool') };
  const keys = Object.keys(toolNames);
  if (keys.length > MAX_TOOL_NAMES) {
    for (const key of keys.slice(0, keys.length - MAX_TOOL_NAMES)) delete toolNames[key];
  }
  let openCallIds = state.openCallIds;
  if (data.name === OPEN_PANEL_TOOL_NAME) {
    openCallIds = { ...state.openCallIds, [callId]: true };
    const openKeys = Object.keys(openCallIds);
    if (openKeys.length > 200) {
      for (const key of openKeys.slice(0, openKeys.length - 200)) delete openCallIds[key];
    }
  }
  return bump(state, event, { toolNames, openCallIds });
}

function onToolResult(state, event, data) {
  const message = data.message ?? {};
  const callId = message.toolCallId == null ? null : String(message.toolCallId);
  const openRequested = callId != null && state.openCallIds?.[callId] === true;
  if (!message.isError) {
    const nextOpen = openRequested ? withoutKey(state.openCallIds, callId) : state.openCallIds;
    const changes = {
      currentStepHadSuccess: true,
      idle: { stepsWithoutProgress: 0, tokens: 0 },
      openCallIds: nextOpen,
    };
    if (openRequested) {
      changes.panelOpenSeq = state.panelOpenSeq + 1;
      changes.lastPanelRequestAt = event.time ?? state.lastEventAt;
    }
    return bump(state, event, changes);
  }

  const tool = callId != null ? state.toolNames[callId] ?? 'tool' : 'tool';
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const error = data.error ?? {};
  const classification = classifyError({
    message: error.reason ?? error.name ?? '',
    code: error.code,
    error,
    content: blocks,
  });
  const fp = fingerprint({
    tool,
    category: classification.category,
    code: classification.code,
    message: text || error.reason || '',
  });
  const tokens = estimateTokens(text);
  const saved = parseSavedTokens(text);
  const isDigest = saved > 0 || /^\[dsh-failure-ledger\]/.test(text);
  const time = event.time ?? state.lastEventAt;

  const recentFailures = [...state.recentFailures, {
    fingerprint: fp,
    tool,
    category: classification.category,
    time,
    tokens,
  }].slice(-MAX_RECENT_FAILURES);
  const failuresByTool = {
    ...state.failuresByTool,
    [tool]: numberOrZero(state.failuresByTool[tool]) + 1,
  };
  const failuresByCategory = {
    ...state.failuresByCategory,
    [classification.category]: numberOrZero(state.failuresByCategory[classification.category]) + 1,
  };
  let largeErrors = state.largeErrors;
  if (!isDigest && tokens > 0) {
    largeErrors = [...state.largeErrors, {
      fingerprint: fp,
      tool,
      category: classification.category,
      tokens,
      stepsAfter: 0,
      turn: numberOrZero(data.turn),
    }].slice(-MAX_LARGE_ERRORS);
  }

  return bump(state, event, {
    n1: state.n1 + 1,
    turnN1: numberOrZero(state.turnN1) + 1,
    failuresByTool,
    failuresByCategory,
    recentFailures,
    largeErrors,
    savedTokens: state.savedTokens + saved,
    turnSavedTokens: numberOrZero(state.turnSavedTokens) + saved,
    compressed: state.compressed + (isDigest ? 1 : 0),
    turnCompressed: numberOrZero(state.turnCompressed) + (isDigest ? 1 : 0),
    lastFailureAt: time,
    openCallIds: openRequested ? withoutKey(state.openCallIds, callId) : state.openCallIds,
    currentStepHadSuccess: false,
  });
}

function onAssistantMessage(state, event, data) {
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') return state;
  const input = numberOrZero(usage.inputTokens);
  const output = numberOrZero(usage.outputTokens);
  const nextUsage = {
    inputTokens: state.usage.inputTokens + input,
    outputTokens: state.usage.outputTokens + output,
    cacheReadTokens: state.usage.cacheReadTokens + numberOrZero(usage.cacheReadTokens),
    cacheWriteTokens: state.usage.cacheWriteTokens + numberOrZero(usage.cacheWriteTokens),
    reasoningTokens: state.usage.reasoningTokens + numberOrZero(usage.reasoningTokens),
    requests: state.usage.requests + 1,
  };
  const lastRequest = {
    ...(state.lastRequest ?? { inputTokens: 0, cacheReadTokens: 0 }),
    inputTokens: input,
    cacheReadTokens: numberOrZero(usage.cacheReadTokens),
  };
  return bump(state, event, {
    usage: nextUsage,
    lastRequest,
    pressure: { ...state.pressure, projectedTokens: input + output },
  });
}

function onRequestHeader(state, event, data) {
  return bump(state, event, {
    lastRequest: {
      ...(state.lastRequest ?? { inputTokens: 0, cacheReadTokens: 0 }),
      reason: data.reason == null ? null : String(data.reason),
    },
  });
}

function onRequestContext(state, event, data) {
  const contextWindow = numberOrZero(data.contextWindow);
  if (contextWindow === 0) return state;
  return bump(state, event, {
    pressure: { ...state.pressure, contextWindow },
  });
}

function onRetry(state, event, data) {
  const failure = data.failure ?? {};
  const code = failure.code ?? failure.failure?.code ?? null;
  const codes = code == null
    ? state.retries.codes
    : [...state.retries.codes, String(code)].slice(-MAX_RETRY_CODES);
  return bump(state, event, {
    retries: {
      attempts: state.retries.attempts + 1,
      promptTokens: state.lastRequest?.inputTokens || state.usage.inputTokens,
      codes,
    },
  });
}

function onCommandRun(state, event, data) {
  if (data.name !== DFL_UI_COMMAND) return state;
  return bump(state, event, {
    panelOpenSeq: state.panelOpenSeq + 1,
    lastPanelRequestAt: event.time ?? state.lastEventAt,
  });
}

function onTurnEnd(state, event, data) {
  const reason = data.reason ?? {};
  const kind = typeof reason === 'string' ? reason : reason.kind ?? null;
  const time = event.time ?? state.lastEventAt;
  let next = bump(state, event, {
    turn: { ...state.turn, reason: kind },
    lastTurnEndAt: time,
  });

  if (kind === 'error') {
    const error = reason.error ?? {};
    const classification = classifyError({
      message: error.message,
      code: error.code,
      status: error.status,
      error,
    });
    const fp = fingerprint({
      tool: 'turn',
      category: classification.category,
      code: classification.code,
      message: error.message ?? '',
    });
    const recentFailures = [...next.recentFailures, {
      fingerprint: fp,
      tool: 'turn',
      category: classification.category,
      time,
      tokens: 0,
    }].slice(-MAX_RECENT_FAILURES);
    next = {
      ...next,
      n1: next.n1 + 1,
      recentFailures,
      failuresByTool: {
        ...next.failuresByTool,
        turn: numberOrZero(next.failuresByTool.turn) + 1,
      },
      failuresByCategory: {
        ...next.failuresByCategory,
        [classification.category]: numberOrZero(next.failuresByCategory[classification.category]) + 1,
      },
      lastFailureAt: time,
    };
  }

  return next;
}

function bump(state, event, changes) {
  return { ...state, ...changes, lastEventAt: event.time ?? state.lastEventAt };
}

function withoutKey(value, key) {
  if (!value || key == null || value[key] !== true) return value;
  const next = { ...value };
  delete next[key];
  return next;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
