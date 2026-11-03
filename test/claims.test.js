import test from 'node:test';
import assert from 'node:assert/strict';

import { detectClaim, extractAssistantText, stripInjectedContext } from '../lib/claims.js';

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

test('does not read English section words as a completion claim inside Chinese text', () => {
  // Live defect (2026-11-03 23:48): the word "Done" in a handoff section
  // reference produced a false "unverified completion claim".
  assert.equal(
    detectClaim('修复后的逻辑已就绪：Goal 走 `stripInjectedContext`，Done 对 pwsh 优先取 `description`。').claim,
    false,
  );
  assert.equal(detectClaim('Goal 和 Done 两节都已写入。').claim, false);
  assert.equal(detectClaim('DAM 与 DSK 都处在“已完成/等待观察”状态').claim, false);
  assert.equal(detectClaim('All tests pass now.').claim, true);
});

test('stripInjectedContext drops DFL internal notices instead of using their tail', () => {
  const notice = [
    '[dsh-failure-ledger] pwsh failed · UNKNOWN',
    'Inspect the error before retrying; do not repeat the same call unchanged.',
    'Report: D:\\deepseek插件\\dsh-failure-ledger\\failure-reports\\reports\\af8212e408ce.md',
  ].join('\n');
  assert.equal(stripInjectedContext(notice), '');
  assert.equal(stripInjectedContext('[dsh-failure-ledger] 防复发提示（同错两次）：x'), '');
});

test('stripInjectedContext drops the whole system-reminder block, not just its tags', () => {
  const reminder = [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    '- `ds-mode`: pick a mode',
    '</available_skills>',
    '',
    'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool.',
    '</system-reminder>',
    '核对一下交接文件',
  ].join('\n');
  assert.equal(stripInjectedContext(reminder), '核对一下交接文件');
  assert.equal(stripInjectedContext('<system-reminder>\nA skill is reusable\n</system-reminder>'), '');
});

test('stripInjectedContext removes runner metadata from a user goal', () => {
  const goal = stripInjectedContext([
    'Time sampled while preparing turn 50, step 1: 2026-11-03T23:40:01+08:00',
    'Browser time zone for this request: Asia/Shanghai.',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '<available_skills>',
    '- ds-mode',
    '</available_skills>',
    'You are the Team Lead named "lead".',
    'Use list_agents({}) to find your teammates.',
    'To message another teammate, use send_message.',
    '换个对话',
  ].join('\n'));
  assert.equal(goal, '换个对话');
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
