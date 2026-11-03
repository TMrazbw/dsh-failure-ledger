import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandoffRoute, HANDOFF_ROUTE, renderHandoff } from '../lib/handoff.js';

test('renderHandoff emits goal, done, open failures, and key facts', () => {
  const markdown = renderHandoff({
    sessionId: 'session-abcdef123456',
    now: 1_800_000_000_000,
    view: {
      handoff: {
        goal: '修复登录',
        successes: [
          { tool: 'edit', args: { file_path: 'a.js', old_string: 'SECRET OLD', new_string: 'SECRET NEW' }, at: 1_800_000_000_000 },
          { tool: 'pwsh', args: { command: 'SECRET COMMAND', description: 'Run tests' }, at: 1_800_000_000_000 },
        ],
      },
      context: { window: 100_000, lastInputTokens: 12_000, lastOutputTokens: 1_000 },
      usage: { requests: 3 },
      savedTokens: 500,
      claim: { lastClaimText: '已修复' },
    },
    failures: [
      { fingerprint: 'fp-a', tool: 'edit', category: 'edit-target' },
      { fingerprint: 'fp-a', tool: 'edit', category: 'edit-target' },
    ],
  });
  assert.match(markdown, /## Goal/);
  assert.match(markdown, /修复登录/);
  assert.match(markdown, /## Done/);
  assert.match(markdown, /edit/);
  assert.match(markdown, /a\.js/);
  assert.match(markdown, /Run tests/);
  assert.doesNotMatch(markdown, /SECRET OLD|SECRET NEW|SECRET COMMAND/);
  assert.match(markdown, /## Next \/ Open failures/);
  assert.match(markdown, /fp-a · edit\/edit-target · 2 次/);
  assert.match(markdown, /未验证完成声明/);
  assert.match(markdown, /13,000|13000/);
});

test('renderHandoff handles empty facts without throwing', () => {
  const markdown = renderHandoff({ sessionId: 's', now: 0 });
  assert.match(markdown, /（未记录）/);
  assert.match(markdown, /（无成功编辑\/验证记录）/);
  assert.match(markdown, /（无未解决失败）/);
});

test('handoff route is POST/JSON and rejects a missing session', async () => {
  assert.equal(HANDOFF_ROUTE, '/api/failure-ledger.handoff');
  const route = createHandoffRoute({ getHandoff: async (sessionId) => ({ ok: true, path: `${sessionId}.md` }) });
  assert.equal(route.methods[0], 'POST');
  const missing = await route.fetch(new Request('http://local/api', { method: 'POST', body: '{}' }));
  assert.equal(missing.status, 400);
  const ok = await route.fetch(new Request('http://local/api', { method: 'POST', body: JSON.stringify({ sessionId: 's1' }) }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, path: 's1.md' });
});
