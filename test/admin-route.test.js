import test from 'node:test';
import assert from 'node:assert/strict';

import { ADMIN_ROUTE, createAdminRoute } from '../lib/admin-route.js';

function makeRequest(body) {
  return new Request('http://localhost/api/failure-ledger.admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeStore() {
  const calls = [];
  return {
    calls,
    async listGuards() { return { ok: true, guards: [] }; },
    async saveGuard(guard) { calls.push(['save', guard]); return { ok: true, guard }; },
    async deleteGuard(id) {
      calls.push(['delete', id]);
      return id === 'built-in' ? { ok: false, error: 'built-in guards can only be disabled' } : { ok: true };
    },
  };
}

test('admin route updates only allowlisted config paths', async () => {
  const calls = [];
  const settings = {
    async describe() { return [{ ns: 'include:failure-ledger', revision: 4 }]; },
    async mutate(ns, ops, revision) { calls.push({ ns, ops, revision }); },
  };
  const route = createAdminRoute({
    store: makeStore(),
    getSettings: () => settings,
  });
  const response = await route.fetch(makeRequest({
    action: 'config',
    ops: [{ op: 'set', path: ['digest', 'maxInlineTokens'], value: 120 }],
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    ns: 'include:failure-ledger',
    ops: [{ op: 'set', path: ['digest', 'maxInlineTokens'], value: 120 }],
    revision: 4,
  }]);

  const blocked = await route.fetch(makeRequest({
    action: 'config',
    ops: [{ op: 'set', path: ['reportRoot'], value: 'C:\\tmp' }],
  }));
  assert.equal(blocked.status, 400);
  assert.equal(calls.length, 1);
});

test('admin route saves a custom guard and refuses invalid ids', async () => {
  const store = makeStore();
  const route = createAdminRoute({ store });
  const ok = await route.fetch(makeRequest({
    action: 'saveGuard',
    guard: {
      id: 'custom-path', label: 'Path check', tool: 'read', category: 'not-found', hint: 'Check path.',
    },
  }));
  assert.equal(ok.status, 200);
  assert.deepEqual(store.calls[0][1], {
    id: 'custom-path',
    label: 'Path check',
    tool: 'read',
    category: 'not-found',
    code: null,
    hint: 'Check path.',
    action: 'hint',
    mode: 'observe',
    scope: 'global',
    enabled: true,
  });

  const bad = await route.fetch(makeRequest({
    action: 'saveGuard',
    guard: { id: 'Bad ID', label: 'x', tool: 'read' },
  }));
  assert.equal(bad.status, 400);
});

test('admin route exposes delete and rejects built-in deletion', async () => {
  const route = createAdminRoute({ store: makeStore() });
  const custom = await route.fetch(makeRequest({ action: 'deleteGuard', id: 'custom-path' }));
  assert.equal(custom.status, 200);
  const builtIn = await route.fetch(makeRequest({ action: 'deleteGuard', id: 'built-in' }));
  assert.equal(builtIn.status, 400);
});

test('admin route is POST/JSON only', async () => {
  const route = createAdminRoute({ store: makeStore() });
  assert.equal(route.path, ADMIN_ROUTE);
  const get = await route.fetch(new Request('http://localhost/api/failure-ledger.admin'));
  assert.equal(get.status, 405);
  const text = await route.fetch(new Request('http://localhost/api/failure-ledger.admin', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  }));
  assert.equal(text.status, 415);
});
