import test from 'node:test';
import assert from 'node:assert/strict';

import { detectClaim, extractAssistantText } from '../lib/claims.js';

test('detects positive completion claims', () => {
  assert.equal(detectClaim('已修复登录问题。').claim, true);
  assert.equal(detectClaim('All tests pass now.').claim, true);
  assert.equal(detectClaim('The bug is fixed').claim, true);
});

test('ignores negations, questions, and code blocks', () => {
  assert.equal(detectClaim('尚未完成，还需要验证。').claim, false);
  assert.equal(detectClaim('Not fixed yet.').claim, false);
  assert.equal(detectClaim('```js\n// fixed\n```').claim, false);
});

test('extracts text blocks from an assistant message', () => {
  assert.equal(extractAssistantText({
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'reasoning', text: 'hidden' },
    ],
  }), 'first\nsecond');
  assert.equal(extractAssistantText({ text: 'plain' }), 'plain');
});
