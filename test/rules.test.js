import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RULES,
  RULE_IDS,
  evaluateRules,
  normalizeRules,
  summarizeHits,
} from '../lib/rules.js';

const NOW = 1_800_000_000_000;

test('defaults enable every rule with conservative thresholds', () => {
  const rules = normalizeRules();
  assert.deepEqual(Object.keys(rules), [...RULE_IDS]);
  for (const id of RULE_IDS) assert.equal(rules[id].enabled, true);
  assert.equal(rules.repeatFailure.threshold, 3);
  assert.equal(rules.contextPressure.ratio, 0.8);
  assert.equal(rules.contextJump.minDeltaTokens, 8000);
  assert.equal(rules.contextJump.minWindowRatio, 0.1);
  assert.equal(rules.idleLoop.minStepsWithoutProgress, 4);
  assert.equal(DEFAULT_RULES.repeatFailure.windowMinutes, 10);
});

test('partial config overrides thresholds without losing defaults', () => {
  const rules = normalizeRules({ repeatFailure: { threshold: 5 } });
  assert.equal(rules.repeatFailure.threshold, 5);
  assert.equal(rules.repeatFailure.windowMinutes, 10);
  assert.equal(rules.repeatFailure.enabled, true);
});

test('repeatFailure groups fingerprints inside the window', () => {
  const result = evaluateRules(
    {
      now: NOW,
      recentFailures: [
        { fingerprint: 'fp-a', tool: 'pwsh', category: 'sandbox-denied', time: NOW - 1_000, tokens: 100 },
        { fingerprint: 'fp-a', tool: 'pwsh', category: 'sandbox-denied', time: NOW - 2_000, tokens: 100 },
        { fingerprint: 'fp-a', tool: 'pwsh', category: 'sandbox-denied', time: NOW - 3_000, tokens: 100 },
        { fingerprint: 'fp-b', tool: 'read', category: 'not-found', time: NOW - 4_000, tokens: 10 },
      ],
    },
    {},
  );
  assert.equal(result.byRule.repeatFailure.length, 1);
  assert.equal(result.byRule.repeatFailure[0].count, 3);
  assert.equal(result.byRule.repeatFailure[0].wastedTokens, 200);
  assert.equal(result.byRule.repeatFailure[0].evidence.fingerprint, 'fp-a');
  assert.equal(result.wastedTokens, 200);
});

test('repeatFailure ignores failures outside the window', () => {
  const result = evaluateRules(
    {
      now: NOW,
      recentFailures: [
        { fingerprint: 'fp', time: NOW - 1_000 },
        { fingerprint: 'fp', time: NOW - 11 * 60_000 },
        { fingerprint: 'fp', time: NOW - 12 * 60_000 },
      ],
    },
    {},
  );
  assert.equal(result.byRule.repeatFailure, undefined);
});

test('largeErrorResend counts later steps only', () => {
  const hit = evaluateRules({ largeErrors: [{ tokens: 300, stepsAfter: 2, tool: 'pwsh', category: 'not-found' }] }, {});
  assert.equal(hit.byRule.largeErrorResend[0].wastedTokens, 600);

  const below = evaluateRules({ largeErrors: [{ tokens: 250, stepsAfter: 2 }] }, {});
  assert.equal(below.byRule.largeErrorResend, undefined);

  const noLaterStep = evaluateRules({ largeErrors: [{ tokens: 300, stepsAfter: 0 }] }, {});
  assert.equal(noLaterStep.byRule.largeErrorResend, undefined);
});

test('requestRetry alerts only after the configured retry count', () => {
  const hit = evaluateRules({ retries: { attempts: 2, promptTokens: 1_000, codes: ['429'] } }, {});
  assert.equal(hit.byRule.requestRetry[0].wastedTokens, 2_000);
  assert.equal(hit.byRule.requestRetry[0].evidence.attempts, 2);
  assert.deepEqual(hit.byRule.requestRetry[0].evidence.codes, ['429']);

  const quiet = evaluateRules({ retries: { attempts: 1, promptTokens: 1_000 } }, {});
  assert.equal(quiet.byRule.requestRetry, undefined);
});

test('cacheReset detects header resets and cold large prompts', () => {
  const header = evaluateRules({ lastRequest: { reason: 'change', inputTokens: 1_000, cacheReadTokens: 900 } }, {});
  assert.equal(header.byRule.cacheReset[0].evidence.headerReset, true);

  const cold = evaluateRules({ lastRequest: { reason: 'initial', inputTokens: 5_000, cacheReadTokens: 0 } }, {});
  assert.equal(cold.byRule.cacheReset[0].evidence.cacheCold, true);

  const small = evaluateRules({ lastRequest: { reason: 'initial', inputTokens: 1_000, cacheReadTokens: 0 } }, {});
  assert.equal(small.byRule.cacheReset, undefined);
});

test('contextPressure fires at the configured ratio', () => {
  const hit = evaluateRules({ pressure: { projectedTokens: 8_000, contextWindow: 10_000 } }, {});
  assert.equal(hit.byRule.contextPressure[0].evidence.ratio, 0.8);

  const quiet = evaluateRules({ pressure: { projectedTokens: 7_999, contextWindow: 10_000 } }, {});
  assert.equal(quiet.byRule.contextPressure, undefined);
});

test('contextJump fires only for large attributed growth', () => {
  const series = [
    { at: 1, turn: 1, step: 1, source: 'tool', tool: 'read', callId: 'c1', delta: 12_000, window: 100_000 },
    { at: 2, turn: 1, step: 2, source: 'user', tool: null, callId: null, delta: 7_999, window: 100_000 },
    { at: 3, turn: 1, step: 3, source: 'tool', tool: 'grep', callId: 'c2', delta: 8_000, window: 100_000 },
  ];
  const hit = evaluateRules({ context: { series } }, {});
  assert.equal(hit.byRule.contextJump.length, 1);
  assert.equal(hit.byRule.contextJump[0].evidence.delta, 12_000);
  assert.equal(hit.byRule.contextJump[0].evidence.source, 'tool');

  const wide = evaluateRules({ context: { series: [{ ...series[0], delta: 8_000, window: 100_000 }] } }, {});
  assert.equal(wide.byRule.contextJump, undefined);
});

test('contextJump is bounded per session and ignores compaction', () => {
  const series = [1, 2, 3, 4].map((turn) => ({
    at: turn,
    turn,
    step: 1,
    source: 'tool',
    tool: 'read',
    callId: `c${turn}`,
    delta: 10_000,
    window: 50_000,
  }));
  series.push({ at: 9, turn: 9, step: 9, source: 'compaction', delta: -20_000, window: 50_000, compaction: true });
  const hit = evaluateRules({ context: { series } }, { contextJump: { maxHitsPerSession: 3 } });
  assert.equal(hit.byRule.contextJump.length, 3);
  assert.equal(hit.hits.some((entry) => entry.evidence.source === 'compaction'), false);
});

test('maxTokens and abortedTurn read turn/end reasons', () => {
  assert.equal(evaluateRules({ turn: { reason: { kind: 'max-tokens' } } }, {}).byRule.maxTokens.length, 1);
  assert.equal(evaluateRules({ turn: { reason: { kind: 'completed' } } }, {}).byRule.maxTokens, undefined);
  assert.equal(evaluateRules({ turn: { reason: { kind: 'aborted' } } }, {}).byRule.abortedTurn.length, 1);
  assert.equal(evaluateRules({ turn: { reason: { kind: 'interrupted' } } }, {}).byRule.abortedTurn.length, 1);
  assert.equal(evaluateRules({ turn: { reason: { kind: 'completed' } } }, {}).byRule.abortedTurn, undefined);
});

test('subagentFailure counts failed children', () => {
  const result = evaluateRules(
    { subagents: [{ ok: false, childSession: 's-1', tokens: 40 }, { ok: true, childSession: 's-2' }] },
    {},
  );
  assert.equal(result.byRule.subagentFailure[0].count, 1);
  assert.equal(result.byRule.subagentFailure[0].wastedTokens, 40);
  assert.equal(result.byRule.subagentFailure[0].evidence.children[0].childSession, 's-1');
});

test('idleLoop fires at the configured step count', () => {
  const hit = evaluateRules({ idle: { stepsWithoutProgress: 4, tokens: 1_200 } }, {});
  assert.equal(hit.byRule.idleLoop[0].wastedTokens, 1_200);
  const quiet = evaluateRules({ idle: { stepsWithoutProgress: 3, tokens: 1_200 } }, {});
  assert.equal(quiet.byRule.idleLoop, undefined);
});

test('disabled rules are skipped while other defaults keep running', () => {
  const stats = {
    now: NOW,
    recentFailures: [
      { fingerprint: 'fp', time: NOW - 1_000 },
      { fingerprint: 'fp', time: NOW - 2_000 },
      { fingerprint: 'fp', time: NOW - 3_000 },
    ],
    pressure: { projectedTokens: 9_000, contextWindow: 10_000 },
  };
  const result = evaluateRules(stats, { repeatFailure: { enabled: false } });
  assert.equal(result.byRule.repeatFailure, undefined);
  assert.equal(result.byRule.contextPressure.length, 1);
});

test('empty stats produce no hits', () => {
  const result = evaluateRules();
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.byRule, {});
  assert.equal(result.wastedTokens, 0);
});

test('summarizeHits aggregates counts and wasted tokens', () => {
  assert.deepEqual(summarizeHits([{ count: 3, wastedTokens: 200 }, { count: 1, wastedTokens: 50 }]), {
    count: 2,
    totalCount: 4,
    wastedTokens: 250,
  });
  assert.deepEqual(summarizeHits(null), { count: 0, totalCount: 0, wastedTokens: 0 });
});
