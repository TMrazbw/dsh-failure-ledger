import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, CLASSIFIER_VERSION, classifyError, describeCategory, errorTextOf } from '../lib/classify.js';

test('sandbox denial is high severity and not retryable', () => {
  const result = classifyError({ message: 'sandbox: file access denied under workspace-write mode', code: 'EACCES' });
  assert.equal(result.category, 'sandbox-denied');
  assert.equal(result.severity, 'high');
  assert.equal(result.retryable, false);
  assert.match(result.hint, /workspace/i);
  assert.equal(result.code, 'EACCES');
  assert.equal(result.version, CLASSIFIER_VERSION);
});

test('missing file is not-found and allows one retry', () => {
  const result = classifyError({ message: 'Cannot find path D:\\x\\y.txt because it does not exist.' });
  assert.equal(result.category, 'not-found');
  assert.equal(result.retryable, 'once');
  assert.equal(classifyError({ error: { info: { code: 'FS_NOT_FOUND' } } }).category, 'not-found');
});

test('stale write is retryable and carries the structured code', () => {
  const result = classifyError({ error: { message: 'write rejected', info: { code: 'FS_STALE_VERSION', name: 'StaleWrite' } } });
  assert.equal(result.category, 'stale-write');
  assert.equal(result.retryable, true);
  assert.equal(result.code, 'FS_STALE_VERSION');
});

test('edit target failures are classified together', () => {
  assert.equal(classifyError({ error: { info: { code: 'FS_NOT_OBSERVED' } } }).category, 'edit-target');
  assert.equal(classifyError({ message: 'FS_EDIT_NOT_FOUND: old_string not found' }).category, 'edit-target');
  assert.equal(classifyError({ message: 'FS_AMBIGUOUS_EDIT: multiple matches' }).category, 'edit-target');
});

test('search failures are not mistaken for missing paths', () => {
  assert.equal(classifyError({ error: { info: { code: 'SEARCH_FAILED' } } }).category, 'search-failed');
});

test('unknown command is classified as missing-command', () => {
  const result = classifyError({ content: [{ type: 'text', text: 'pwsh : 无法将“pwsh”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。' }] });
  assert.equal(result.category, 'missing-command');
  assert.equal(result.retryable, false);
});

test('invented tool names and missing runtime dependencies get their own hints', () => {
  const invented = classifyError({ message: 'unknown tool "session_search"', code: 'UNKNOWN_TOOL' });
  assert.equal(invented.category, 'unknown-tool');
  assert.equal(invented.retryable, false);
  assert.match(invented.hint, /tool does not exist/i);

  const dependency = classifyError({ message: 'ModuleNotFoundError: No module named zstandard' });
  assert.equal(dependency.category, 'dependency-missing');
  assert.equal(dependency.retryable, false);
  assert.match(dependency.hint, /dependency/i);
});

test('timeout, context overflow, and tool contract are distinct', () => {
  assert.equal(classifyError({ message: 'command timed out after 120000 ms' }).category, 'timeout');
  assert.equal(classifyError({ message: 'context length exceeded: maximum context 200000' }).category, 'context-overflow');
  assert.equal(classifyError({ message: 'invalid argument: required property "path" is missing' }).category, 'tool-contract');
});

test('401/403 are auth and 429 is rate-limit regardless of message text', () => {
  assert.equal(classifyError({ status: 401, message: 'sandbox denied' }).category, 'auth');
  assert.equal(classifyError({ status: 403, message: 'sandbox denied' }).category, 'auth');
  assert.equal(classifyError({ status: 429, message: 'sandbox denied' }).category, 'rate-limit');
  assert.equal(classifyError({ status: 429 }).retryable, true);
});

test('CAPTCHA stops automation', () => {
  const result = classifyError({ message: 'Cloudflare challenge detected: just a moment' });
  assert.equal(result.category, 'human-verification');
  assert.equal(result.retryable, false);
  assert.match(result.hint, /verification/i);
});

test('shell syntax errors do not invite an unchanged retry', () => {
  const result = classifyError({ message: 'ParserError: unexpected token, missing closing brace' });
  assert.equal(result.category, 'shell-syntax');
  assert.equal(result.retryable, false);
});

test('shell process init failures are high severity and not retryable', () => {
  const result = classifyError({ message: '(no output)\n[exit code: 3221225794]' });
  assert.equal(result.category, 'shell-runtime');
  assert.equal(result.severity, 'high');
  assert.equal(result.retryable, false);
});

test('aborted synthetic results are low severity', () => {
  const result = classifyError({ code: 'ABORTED_BEFORE_DISPATCH', message: 'tool call aborted before dispatch' });
  assert.equal(result.category, 'aborted');
  assert.equal(result.severity, 'low');
});

test('unknown failures remain inspectable', () => {
  const result = classifyError({ message: 'something unusual happened' });
  assert.equal(result.category, 'unknown');
  assert.equal(result.retryable, 'once');
  assert.ok(result.hint.length > 0);
});

test('category catalog and descriptions are stable', () => {
  assert.ok(CATEGORIES.includes('sandbox-denied'));
  assert.ok(CATEGORIES.includes('unknown'));
  const described = describeCategory('rate-limit');
  assert.equal(described.category, 'rate-limit');
  assert.equal(described.severity, 'medium');
  assert.equal(describeCategory('nope').category, 'unknown');
});

test('errorTextOf reads nested tool failure shapes', () => {
  const text = errorTextOf({
    message: 'outer',
    error: { message: 'inner', info: { code: 'EPERM', name: 'PermissionError', reason: 'denied' } },
    content: [{ type: 'text', text: 'block' }],
  });
  assert.match(text, /outer/);
  assert.match(text, /inner/);
  assert.match(text, /EPERM/);
  assert.match(text, /block/);
});
