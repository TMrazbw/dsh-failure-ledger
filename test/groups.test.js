import test from 'node:test';
import assert from 'node:assert/strict';

import { groupFailures } from '../lib/groups.js';

test('groupFailures aggregates counts and latest metadata by fingerprint', () => {
  const groups = groupFailures([
    { fingerprint: 'fp-a', time: '2026-10-22T10:00:00.000Z', tool: 'edit', category: 'edit-target', count: 1 },
    { fingerprint: 'fp-b', time: '2026-10-22T11:00:00.000Z', tool: 'read', category: 'not-found' },
    { fingerprint: 'fp-a', time: '2026-10-22T12:00:00.000Z', tool: 'edit', category: 'edit-target', severity: 'high', report: 'reports/a.md' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fingerprint, 'fp-a');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].firstSeen, '2026-10-22T10:00:00.000Z');
  assert.equal(groups[0].lastSeen, '2026-10-22T12:00:00.000Z');
  assert.equal(groups[0].severity, 'high');
  assert.equal(groups[0].report, 'reports/a.md');
});

test('groupFailures ignores rows without a fingerprint', () => {
  assert.deepEqual(groupFailures([{ time: 'x' }, null]), []);
});
