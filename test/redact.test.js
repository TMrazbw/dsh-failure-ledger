import test from 'node:test';
import assert from 'node:assert/strict';

import { REDACTION_RULES, redact, redactWithStats } from '../lib/redact.js';

test('authorization headers and bearer tokens are removed', () => {
  const result = redactWithStats('Authorization: Bearer abc.def.ghi\nproxy-authorization: token1234');
  assert.ok(!result.text.includes('abc.def.ghi'));
  assert.ok(!result.text.includes('token1234'));
  assert.ok(result.text.includes('[REDACTED]'));
  assert.ok(result.total >= 1);
});

test('common token prefixes, JWTs, and key/value secrets are removed', () => {
  const result = redactWithStats(
    'key=sk-abcdefghijklmnop password=hunter2 token: "secretvalue" jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
  );
  assert.ok(!result.text.includes('sk-abcdefghijklmnop'));
  assert.ok(!result.text.includes('hunter2'));
  assert.ok(!result.text.includes('secretvalue'));
  assert.ok(!result.text.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.match(result.text, /REDACTED/);
});

test('GitHub and AWS credentials are removed', () => {
  const result = redactWithStats('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AKIAIOSFODNN7EXAMPLE');
  assert.ok(!result.text.includes('ghp_'));
  assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(result.text.split('[REDACTED_TOKEN]').length - 1, 2);
});

test('user paths and email addresses are privacy-redacted', () => {
  const result = redactWithStats('C:\\Users\\alice\\project\\a.txt /home/bob/x.txt alice@example.com');
  assert.ok(result.text.includes('C:\\Users\\<user>\\project\\a.txt'));
  assert.ok(result.text.includes('/home/<user>/x.txt'));
  assert.ok(result.text.includes('<email>'));
  assert.ok(result.counts['windows-user-path'] >= 1);
  assert.ok(result.counts['posix-user-path'] >= 1);
  assert.ok(result.counts.email >= 1);
});

test('redaction options can keep email and paths', () => {
  const result = redact('alice@example.com C:\\Users\\alice\\x', { redactEmails: false, redactUserPaths: false });
  assert.ok(result.includes('alice@example.com'));
  assert.ok(result.includes('C:\\Users\\alice\\x'));
});

test('redaction is safe for empty input and idempotent', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(''), '');
  const once = redact('Authorization: Bearer abcdefghijklmnop');
  assert.equal(redact(once), once);
});

test('redaction rule ids are exported for diagnostics', () => {
  assert.ok(REDACTION_RULES.includes('authorization'));
  assert.ok(REDACTION_RULES.includes('email'));
});
