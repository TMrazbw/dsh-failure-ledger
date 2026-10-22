import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanText,
  formatTokens,
  renderDigest,
  renderInbox,
  renderReport,
  truncateMiddle,
} from '../lib/render.js';

test('truncateMiddle keeps head and tail within the limit', () => {
  const value = truncateMiddle('abcdefghij', 5);
  assert.equal(value.length, 5);
  assert.equal(value, 'ab…ij');
  assert.equal(truncateMiddle('abc', 10), 'abc');
  assert.equal(truncateMiddle('abcdef', 1), '…');
  assert.equal(truncateMiddle('abcdef', 0), '');
});

test('cleanText removes control characters and normalizes line endings', () => {
  assert.equal(cleanText('a\r\nb\u0000c'), 'a\nbc');
  assert.equal(cleanText(null), '');
});

test('formatTokens is compact', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1800), '1.8k');
  assert.equal(formatTokens(1_200_000), '1.2M');
});

test('renderDigest contains category, hint, and report path without unbounded detail', () => {
  const digest = renderDigest({
    toolName: 'pwsh',
    category: 'sandbox-denied',
    hint: 'Write inside the workspace.',
    detail: 'x'.repeat(5000),
    reportPath: 'reports/abcd.md',
  });
  assert.match(digest, /^\[dsh-failure-ledger\] pwsh failed · SANDBOX-DENIED/);
  assert.match(digest, /Write inside the workspace\./);
  assert.match(digest, /Report: reports\/abcd\.md/);
  assert.ok(digest.length < 500);
});

test('renderReport emits front matter, all sections, and bounds the output', () => {
  const report = renderReport({
    id: 'F-20261022-120000-abcd',
    fingerprint: 'abcdef123456',
    status: 'new',
    severity: 'high',
    category: 'sandbox-denied',
    created: '2026-10-22T12:00:00.000Z',
    session: 'session-1',
    parent: null,
    agentKind: 'root',
    tool: 'pwsh',
    count: 3,
    tokensRaw: 1000,
    tokensDigest: 200,
    route: 'deepseek/deepseek-flash',
    task: 'write a file',
    summary: 'denied twice',
    error: 'sandbox: file access denied',
    context: 'workspace-write',
    advice: 'write inside the workspace',
    evidence: 'tool/result seq 42',
    sessionHint: 'do not retry unchanged',
    fix: 'none yet',
  });

  assert.match(report, /^---\n/);
  assert.match(report, /schema: dsh-failure\/1/);
  assert.match(report, /id: "F-20261022-120000-abcd"/);
  assert.match(report, /tokens_saved: 800/);
  for (const heading of ['## 任务', '## 发生了什么', '## 错误', '## 上下文', '## 判断与建议', '## 证据', '## 优化会话提示', '## 修复记录']) {
    assert.ok(report.includes(heading), `missing ${heading}`);
  }
  assert.ok(report.length <= 4096);
});

test('renderReport truncates long reports and escapes front matter strings', () => {
  const report = renderReport(
    {
      id: 'F-"quoted"',
      fingerprint: 'fp',
      error: 'x'.repeat(10_000),
      summary: 'y'.repeat(10_000),
      task: 'z'.repeat(10_000),
    },
    { maxChars: 600, maxErrorChars: 200 },
  );
  assert.ok(report.length <= 600);
  assert.match(report, /…\(report truncated\)/);
  assert.match(report, /id: "F-\\"quoted\\""/);
});

test('renderReport defaults are safe', () => {
  const report = renderReport({});
  assert.match(report, /schema: dsh-failure\/1/);
  assert.match(report, /status: "new"/);
  assert.match(report, /severity: "medium"/);
  assert.match(report, /category: "unknown"/);
});

test('renderInbox bounds rows and formats totals', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `F-${index}`,
    severity: 'high',
    tool: 'pwsh',
    category: 'sandbox-denied',
    count: 1,
    last: '15:30',
    report: `reports/${index}.md`,
  }));
  const inbox = renderInbox({ rows, newCount: 3, total: 25, savedTokens: 41_000, handoffPath: 'handoffs/session-1.md' });
  assert.equal((inbox.match(/\| F-/g) ?? []).length, 20);
  assert.match(inbox, /est\. 41k tokens saved/);
  assert.match(inbox, /Handoffs: handoffs\/session-1\.md/);
});

test('renderInbox handles empty state and escapes pipes', () => {
  const empty = renderInbox({ rows: [], total: 0 });
  assert.match(empty, /No failures recorded\./);

  const escaped = renderInbox({
    rows: [{ id: 'a|b', severity: 'high', tool: 'x', category: 'unknown', count: 1, last: 'now', report: 'r' }],
  });
  assert.match(escaped, /a\\\|b/);
});
