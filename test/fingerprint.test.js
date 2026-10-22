import test from 'node:test';
import assert from 'node:assert/strict';

import { fingerprint, normalizeErrorText } from '../lib/fingerprint.js';

test('volatile paths, dates, GUIDs, and ids do not change the fingerprint', () => {
  const left = fingerprint({
    tool: 'pwsh',
    category: 'not-found',
    code: 'ENOENT',
    message: 'Cannot find path D:\\a\\b.txt at 2026-10-22T12:00:00Z id 1234 request 550e8400-e29b-41d4-a716-446655440000',
  });
  const right = fingerprint({
    tool: 'pwsh',
    category: 'not-found',
    code: 'ENOENT',
    message: 'Cannot find path C:\\x\\y.txt at 2027-01-02T03:04:05Z id 99999 request 11111111-2222-3333-4444-555555555555',
  });
  assert.equal(left, right);
});

test('tool, category, and code participate in the fingerprint', () => {
  const base = { tool: 'pwsh', category: 'timeout', code: 'ETIMEDOUT', message: 'timed out' };
  assert.notEqual(fingerprint(base), fingerprint({ ...base, tool: 'bash' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, category: 'unknown' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, code: 'TIMEOUT' }));
});

test('fingerprint is deterministic, lowercase, and 12 hex characters', () => {
  const value = fingerprint({ tool: 'read', category: 'not-found', code: 'ENOENT', message: 'no such file' });
  assert.match(value, /^[0-9a-f]{12}$/);
  assert.equal(value, fingerprint({ tool: 'read', category: 'not-found', code: 'ENOENT', message: 'no such file' }));
});

test('normalization removes ANSI, URLs, and user-specific paths', () => {
  const normalized = normalizeErrorText('\u001b[31mfailed\u001b[0m at https://example.com/x C:\\Users\\alice\\a.txt');
  assert.ok(!normalized.includes('\u001b'));
  assert.ok(normalized.includes('<url>'));
  assert.ok(normalized.includes('<path>'));
});

test('POSIX paths, urls, guids, and dates are normalized', () => {
  assert.equal(normalizeErrorText('/home/alice/project/file.txt'), '<path>');
  assert.equal(normalizeErrorText('https://api.example.com/v1/models'), '<url>');
  assert.equal(normalizeErrorText('id 550e8400-e29b-41d4-a716-446655440000'), 'id <guid>');
  assert.equal(normalizeErrorText('at 2026-10-22'), 'at <date>');
});

test('long messages are bounded before hashing', () => {
  const normalized = normalizeErrorText('word '.repeat(10_000));
  assert.ok(normalized.length <= 4000);
  assert.ok(fingerprint({ message: 'word '.repeat(10_000) }).length === 12);
});

test('empty and non-string inputs are handled', () => {
  assert.equal(fingerprint().length, 12);
  assert.equal(fingerprint({ message: null }).length, 12);
  assert.equal(normalizeErrorText(null), '');
});
