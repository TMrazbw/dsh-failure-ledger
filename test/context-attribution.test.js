import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_SERIES_LIMIT,
  applyContextAttribution,
  createContextAttributionState,
  shouldFlagContextJump,
} from '../lib/context-attribution.js';

function assistant(inputTokens, outputTokens = 0, time = 1) {
  return {
    type: 'assistant/message',
    time,
    data: {
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
}

function toolCall(callId, name) {
  return { type: 'tool/call', time: 2, data: { callId, name } };
}

function toolResult(callId, isError = false) {
  return { type: 'tool/result', time: 3, data: { message: { toolCallId: callId, isError } } };
}

test('first request establishes a baseline without a jump', () => {
  const state = applyContextAttribution(createContextAttributionState(), assistant(50_000));
  assert.equal(state.series.length, 1);
  assert.equal(state.series[0].delta, 0);
  assert.equal(state.series[0].source, 'baseline');
  assert.equal(state.latestJump, null);
});

test('a tool result attributes the next request growth to that tool', () => {
  let state = createContextAttributionState();
  state = applyContextAttribution(state, { type: 'request/context', data: { contextWindow: 100_000 } });
  state = applyContextAttribution(state, assistant(50_000));
  state = applyContextAttribution(state, toolCall('call-1', 'read'));
  state = applyContextAttribution(state, toolResult('call-1'));
  state = applyContextAttribution(state, assistant(60_000, 200, 4));
  const entry = state.series.at(-1);
  assert.equal(entry.delta, 10_000);
  assert.equal(entry.source, 'tool');
  assert.equal(entry.tool, 'read');
  assert.equal(entry.callId, 'call-1');
  assert.equal(state.latestJump, entry);
});

test('user and system-cache sources are attributed', () => {
  let state = applyContextAttribution(createContextAttributionState(), assistant(10_000));
  state = applyContextAttribution(state, { type: 'user/message', time: 2, data: {} });
  state = applyContextAttribution(state, assistant(11_000, 0, 3));
  assert.equal(state.series.at(-1).source, 'user');
  state = applyContextAttribution(state, { type: 'request/header', time: 4, data: { reason: 'change' } });
  state = applyContextAttribution(state, assistant(12_000, 0, 5));
  assert.equal(state.series.at(-1).source, 'system-cache');
  assert.equal(state.series.at(-1).reason, 'change');
});

test('negative deltas are compaction, not jumps', () => {
  let state = applyContextAttribution(createContextAttributionState(), assistant(60_000));
  state = applyContextAttribution(state, assistant(50_000, 0, 2));
  assert.equal(state.compactionCount, 1);
  assert.equal(state.series.at(-1).compaction, true);
  assert.equal(state.series.at(-1).delta, -10_000);
  assert.equal(state.latestJump, null);
});

test('contextJump requires both the delta and window-ratio thresholds', () => {
  assert.equal(shouldFlagContextJump({ delta: 7_999, window: 80_000 }), false);
  assert.equal(shouldFlagContextJump({ delta: 8_000, window: 80_000 }), true);
  assert.equal(shouldFlagContextJump({ delta: 8_000, window: 100_000 }), false);
  assert.equal(shouldFlagContextJump({ delta: 8_000, window: 0 }), false);
  assert.equal(shouldFlagContextJump({ delta: 8_000, window: 80_000, compaction: true }), false);
});

test('an unknown window never fires contextJump', () => {
  let state = applyContextAttribution(createContextAttributionState(), assistant(10_000));
  state = applyContextAttribution(state, assistant(30_000, 0, 2));
  assert.equal(state.series.at(-1).window, 0);
  assert.equal(state.latestJump, null);
});

test('the context window is kept independently of attribution', () => {
  let state = applyContextAttribution(createContextAttributionState(), {
    type: 'request/context',
    data: { contextWindow: 128_000 },
  });
  state = applyContextAttribution(state, {
    type: 'request/context',
    data: { contextWindow: 0 },
  });
  assert.equal(state.window, 128_000);
});

test('non-usage messages do not change the series', () => {
  const initial = createContextAttributionState();
  const state = applyContextAttribution(initial, { type: 'assistant/message', data: {} });
  assert.deepEqual(state, initial);
});

test('the series is bounded', () => {
  let state = createContextAttributionState();
  for (let index = 0; index < CONTEXT_SERIES_LIMIT + 5; index += 1) {
    state = applyContextAttribution(state, assistant(10_000 + index, 0, index));
  }
  assert.equal(state.series.length, CONTEXT_SERIES_LIMIT);
  assert.equal(state.series[0].inputTokens, 10_000 + 5);
});

test('output and cache fields are retained for later cost work', () => {
  const state = applyContextAttribution(createContextAttributionState(), {
    type: 'assistant/message',
    time: 1,
    data: {
      usage: {
        inputTokens: 123,
        outputTokens: 45,
        cacheReadTokens: 6,
        cacheWriteTokens: 7,
      },
    },
  });
  const entry = state.series[0];
  assert.equal(entry.outputTokens, 45);
  assert.equal(entry.cacheReadTokens, 6);
  assert.equal(entry.cacheWriteTokens, 7);
});
