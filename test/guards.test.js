import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GUARDS, matchGuard, normalizeGuards } from '../lib/guards.js';

test('default guards cover the V1 failure classes', () => {
  const ids = new Set(DEFAULT_GUARDS.map((guard) => guard.id));
  for (const id of [
    'edit-read-first',
    'search-asar',
    'path-check',
    'command-path',
    'timeout-scope',
    'sandbox-boundary',
    'stale-rebase',
    'shell-runtime',
    'human-verification',
    'browser-download',
    'browser-auth',
  ]) assert.ok(ids.has(id), id);
  assert.ok(DEFAULT_GUARDS.every((guard) => guard.mode === 'observe' && guard.enabled === true));
});

test('normalizeGuards merges runtime counters without dropping defaults', () => {
  const guards = normalizeGuards({
    guards: [
      { id: 'edit-read-first', hits: 3, lastHitAt: '2026-10-22T00:00:00.000Z', enabled: false },
      { id: 'custom', tool: 'foo', category: 'bar', hits: -2 },
    ],
  });
  assert.equal(guards.find((guard) => guard.id === 'edit-read-first').hits, 3);
  assert.equal(guards.find((guard) => guard.id === 'edit-read-first').enabled, false);
  assert.equal(guards.find((guard) => guard.id === 'custom').hits, 0);
  assert.ok(guards.find((guard) => guard.id === 'path-check'));
});

test('matching prefers the most specific enabled guard', () => {
  const custom = normalizeGuards([
    { id: 'tool-only', tool: 'edit' },
    { id: 'category-only', category: 'edit-target' },
    { id: 'specific', tool: 'edit', category: 'edit-target', code: 'FS_NOT_OBSERVED' },
    { id: 'disabled', tool: 'edit', category: 'edit-target', code: 'FS_NOT_OBSERVED', enabled: false },
  ]);
  const match = matchGuard(custom, { tool: 'edit', category: 'edit-target', code: 'FS_NOT_OBSERVED' });
  assert.equal(match.id, 'specific');
  assert.equal(matchGuard(custom, { tool: 'edit', category: 'edit-target' }).id, 'edit-read-first');
  assert.equal(matchGuard(custom, { tool: 'read', category: 'not-found' }).id, 'path-check');
  assert.equal(matchGuard(custom, { tool: 'edit', category: 'unknown' }).id, 'tool-only');
  assert.equal(matchGuard(custom, { tool: 'browser_open', category: 'unknown', code: 'BROWSER_NAVIGATION_FAILED' }).id, 'browser-download');
});
