import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateAnomalyViews,
  applyAnomalyEvent,
  createAnomalyState,
  createAnomalyView,
  parseSavedTokens,
} from '../lib/anomaly.js';
import { DFL_UI_COMMAND, OPEN_PANEL_TOOL_NAME } from '../lib/inbox.js';
import {
  PROJECTION_KEY,
  aggregateSessionStats,
  createFailureLedgerProjection,
} from '../lib/projection.js';

const T = 1_800_000_000_000;

function ev(type, data, seq) {
  return { type, data, seq, time: T + seq * 1_000 };
}

function fold(header, events) {
  let state = createAnomalyState(header);
  for (const event of events) state = applyAnomalyEvent(state, event);
  return state;
}

function call(seq, callId, name = 'pwsh') {
  return ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' }, seq);
}

function failure(seq, callId, text = 'sandbox: file access denied', code = 'EACCES') {
  return ev('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      isError: true,
      toolCallId: callId,
      content: [{ type: 'text', text }],
    },
    error: { name: 'PermissionError', code },
  }, seq);
}

function threeFailures(retry = true) {
  const events = [
    ev('turn/start', { turn: 1 }, 1),
    ev('step/start', { turn: 1, step: 1 }, 2),
    call(3, 'c1'),
    failure(4, 'c1'),
    call(5, 'c2'),
    failure(6, 'c2'),
    call(7, 'c3'),
    failure(8, 'c3'),
  ];
  if (retry) events.push(ev('llm/retry', { failure: { code: 'RATE_LIMIT' } }, 9));
  events.push(
    ev('request/header', { header: { config: {} }, reason: 'change' }, 10),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: {},
      stream: [],
      usage: { inputTokens: 5_000, outputTokens: 100, cacheReadTokens: 0 },
    }, 11),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 12),
  );
  return events;
}

test('3 failures, 1 retry, and 1 cache miss produce the expected view', () => {
  const state = fold({ id: 's1', createdAt: T }, threeFailures());
  const view = createAnomalyView(state);

  assert.equal(view.n1, 3);
  assert.equal(view.n2, 2);
  assert.equal(view.byRule.repeatFailure, 1);
  assert.equal(view.byRule.cacheReset, 1);
  assert.equal(view.byRule.requestRetry, undefined);
  assert.equal(view.turns, 1);
  assert.equal(view.steps, 1);
  assert.equal(view.usage.inputTokens, 5_000);
  assert.equal(view.usage.outputTokens, 100);
  assert.equal(view.usage.requests, 1);
  assert.equal(view.retries.attempts, 1);
  assert.deepEqual(view.retries.codes, ['RATE_LIMIT']);
  assert.equal(view.turn.reason, 'completed');
  assert.equal(view.sessionId, 's1');
});

test('usage is also bucketed by local day', () => {
  const state = fold({ id: 's1' }, [
    ev('assistant/message', { usage: { inputTokens: 1_234, outputTokens: 56, cacheReadTokens: 7 } }, 1),
  ]);
  const view = createAnomalyView(state);
  const days = Object.values(view.usageDaily);
  assert.equal(days.length, 1);
  assert.equal(days[0].inputTokens, 1_234);
  assert.equal(days[0].outputTokens, 56);
  assert.equal(days[0].requests, 1);
});

test('context attribution is folded into the projection and contextJump rule', () => {
  const state = fold({ id: 's1', createdAt: T }, [
    ev('turn/start', { turn: 1 }, 1),
    ev('request/context', { contextWindow: 100_000 }, 2),
    ev('assistant/message', { usage: { inputTokens: 50_000, outputTokens: 100, cacheReadTokens: 1_000 } }, 3),
    ev('tool/call', { callId: 'c1', name: 'read' }, 4),
    ev('tool/result', { message: { toolCallId: 'c1', isError: false } }, 5),
    ev('assistant/message', { usage: { inputTokens: 65_000, outputTokens: 200, cacheReadTokens: 1_000 } }, 6),
  ]);
  const view = createAnomalyView(state);
  assert.equal(view.context.window, 100_000);
  assert.equal(view.context.series.length, 2);
  assert.equal(view.context.series.at(-1).source, 'tool');
  assert.equal(view.context.series.at(-1).tool, 'read');
  assert.equal(view.byRule.contextJump, 1);
  assert.equal(view.n2 >= 1, true);
});

test('the projection state is pure and replays identically', () => {
  const header = { id: 's1', createdAt: T };
  const first = fold(header, threeFailures());
  const second = fold(header, threeFailures());
  assert.deepEqual(first, second);
  assert.deepEqual(createAnomalyView(first), createAnomalyView(second));
});

test('digest savings are recovered from the logged marker and replay', () => {
  const digest = [
    '[dsh-failure-ledger] pwsh failed · SANDBOX-DENIED',
    'The target is outside the workspace.',
    'Detail: sandbox: file access denied',
    'Tokens: 2840 raw · 112 digest · 2712 saved',
    'Report: /tmp/reports/abc.md',
  ].join('\n');
  const events = [
    ev('turn/start', { turn: 1 }, 1),
    ev('step/start', { turn: 1, step: 1 }, 2),
    call(3, 'c1'),
    failure(4, 'c1', digest),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ];

  const state = fold({ id: 's1' }, events);
  const view = createAnomalyView(state);
  assert.equal(view.n1, 1);
  assert.equal(view.savedTokens, 2712);
  assert.equal(view.compressed, 1);
  assert.equal(state.largeErrors.length, 0);

  const replay = fold({ id: 's1' }, events);
  assert.deepEqual(state, replay);
  assert.deepEqual(view, createAnomalyView(replay));
});

test('parseSavedTokens supports the marker, legacy text, and absence', () => {
  assert.equal(parseSavedTokens('x\nTokens: 100 raw · 20 digest · 80 saved\ny'), 80);
  assert.equal(parseSavedTokens('Saved: 123 tokens'), 123);
  assert.equal(parseSavedTokens('no marker'), 0);
  assert.equal(parseSavedTokens(null), 0);
});

test('unrelated events keep the state reference', () => {
  const state = createAnomalyState({ id: 's1' });
  assert.equal(applyAnomalyEvent(state, ev('step/end', { turn: 1, step: 1 }, 1)), state);
  assert.equal(applyAnomalyEvent(state, ev('assistant/attempt', { turn: 1, step: 1, stream: [] }, 2)), state);
});

test('failed turns count as one failure with a classified category', () => {
  const state = fold({ id: 's1' }, [
    ev('turn/start', { turn: 1 }, 1),
    ev('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 too many requests' } },
    }, 2),
  ]);
  const view = createAnomalyView(state);
  assert.equal(view.n1, 1);
  assert.equal(state.failuresByCategory['rate-limit'], 1);
  assert.equal(state.failuresByTool.turn, 1);
});

test('turn counters reset at the next turn while cumulative counters remain', () => {
  let state = fold({ id: 's1' }, [
    ev('turn/start', { turn: 1 }, 1),
    ev('step/start', { turn: 1, step: 1 }, 2),
    call(3, 'c1'),
    failure(4, 'c1'),
  ]);
  let view = createAnomalyView(state);
  assert.equal(view.turnN1, 1);
  assert.equal(view.n1, 1);

  state = applyAnomalyEvent(state, ev('turn/start', { turn: 2 }, 5));
  view = createAnomalyView(state);
  assert.equal(view.turnN1, 0);
  assert.equal(view.n1, 1);
});

test('aggregateSessionStats sums parent and child sessions once each', () => {
  const parent = createAnomalyView(fold({ id: 'parent', createdAt: T }, [
    ev('turn/start', { turn: 1 }, 1),
    ev('step/start', { turn: 1, step: 1 }, 2),
    call(3, 'p1'),
    failure(4, 'p1', 'first failure'),
    call(5, 'p2'),
    failure(6, 'p2', 'second failure'),
  ]));
  const child = createAnomalyView(fold({ id: 'child', origin: 'subagent', parentSession: 'parent' }, threeFailures()));

  const aggregate = aggregateSessionStats([parent, child, child]);
  assert.equal(aggregate.sessions, 2);
  assert.equal(aggregate.rootSessions, 1);
  assert.equal(aggregate.subagentSessions, 1);
  assert.equal(aggregate.n1, 5);
  assert.equal(aggregate.n2, 2);
  assert.equal(aggregate.byRule.repeatFailure, 1);
  assert.deepEqual(aggregateSessionStats([]), {
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
  });
});

test('the dfl-ui command requests the panel', () => {
  const state = fold({ id: 's1' }, [
    ev('command/run', { commandId: 'cmd-1', name: DFL_UI_COMMAND, args: '', source: { kind: 'user' } }, 1),
  ]);
  const view = createAnomalyView(state);
  assert.equal(view.panelOpenSeq, 1);
  assert.equal(view.lastPanelRequestAt, T + 1_000);
});

test('the open_failure_ledger tool requests the panel only on success', () => {
  const success = fold({ id: 's1' }, [
    ev('tool/call', { turn: 1, step: 1, callId: 'open-1', name: OPEN_PANEL_TOOL_NAME, arguments: '{}' }, 1),
    ev('tool/result', {
      turn: 1,
      step: 1,
      message: { isError: false, toolCallId: 'open-1', content: [{ type: 'text', text: 'requested' }] },
    }, 2),
  ]);
  assert.equal(createAnomalyView(success).panelOpenSeq, 1);
  assert.equal(success.n1, 0);

  const failed = fold({ id: 's1' }, [
    ev('tool/call', { turn: 1, step: 1, callId: 'open-2', name: OPEN_PANEL_TOOL_NAME, arguments: '{}' }, 1),
    ev('tool/result', {
      turn: 1,
      step: 1,
      message: { isError: true, toolCallId: 'open-2', content: [{ type: 'text', text: 'denied' }] },
      error: { name: 'Denied', code: 'DENIED' },
    }, 2),
  ]);
  const failedView = createAnomalyView(failed);
  assert.equal(failedView.panelOpenSeq, 0);
  assert.equal(failed.n1, 1);
});

test('the projection definition exposes the expected wire contract', () => {
  const definition = createFailureLedgerProjection({ rules: { repeatFailure: { threshold: 2 } } });
  assert.equal(definition.key, PROJECTION_KEY);
  assert.equal(definition.stateVersion, 1);
  assert.equal(typeof definition.init, 'function');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(typeof definition.wire.view, 'function');

  const state = definition.init({ id: 's1', origin: 'subagent', parentSession: 'p1', createdAt: T });
  const view = definition.wire.view(state);
  assert.equal(view.sessionId, 's1');
  assert.equal(view.agentKind, 'subagent');
  assert.equal(view.parentSession, 'p1');
  assert.equal(view.n1, 0);
  assert.equal(definition.stateSchema.parse(state), state);
  assert.equal(definition.wire.viewSchema.parse(view), view);
  assert.doesNotThrow(() => JSON.stringify(view));
});

test('aggregate keeps per-rule counts across sessions', () => {
  const parent = createAnomalyView(fold({ id: 'p' }, threeFailures()));
  const child = createAnomalyView(fold({ id: 'c', origin: 'subagent', parentSession: 'p' }, threeFailures()));
  const aggregate = aggregateAnomalyViews([parent, child]);
  assert.equal(aggregate.byRule.repeatFailure, 2);
  assert.equal(aggregate.byRule.cacheReset, 2);
  assert.equal(aggregate.usage.inputTokens, 10_000);
});
