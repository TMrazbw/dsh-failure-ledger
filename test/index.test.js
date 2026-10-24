import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Config, DEFAULT_REPORT_ROOT, apply } from '../index.js';

test('apply registers the listener, projection, and failure_inbox tool', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lfl-index-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const handlers = [];
  const cleanups = [];
  const warnings = [];
  const projections = [];
  const tools = [];
  const routes = [];
  const commands = [];
  const ctx = {
    on(name, listener) {
      handlers.push({ name, listener });
      return () => {};
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    inject(dependencies, callback) {
      const services = {
        sessionProjections: {
          register(definition) {
            projections.push(definition);
            return () => {};
          },
        },
        tools: {
          register(definition) {
            tools.push(definition);
            return () => {};
          },
        },
        connection: {
          fetch: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        },
        commands: {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        },
        settings: {
          async describe() { return []; },
          async mutate() {},
        },
        sessionQuery: {
          async listSessions() { return []; },
          async readTitleSnapshots(ids) {
            return ids.map((sessionId) => ({
              sessionId,
              status: 'fulfilled',
              value: { title: { title: `Title ${sessionId}` } },
            }));
          },
        },
        workspaceRegistry: {
          list() { return []; },
        },
        workspaceController: {
          async *follow() {
            yield { type: 'baseline', value: { archivedSessionIds: [] } };
          },
        },
      };
      const scope = {
        effect(callback) {
          const dispose = callback();
          return typeof dispose === 'function' ? dispose : () => {};
        },
      };
      for (const dependency of dependencies) scope[dependency] = services[dependency];
      callback(scope);
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  };

  apply(ctx, { reportRoot: root, digest: { maxInlineTokens: 10 } });

  assert.equal(handlers.length, 2);
  assert.equal(handlers[0].name, 'tools/post-execute');
  assert.equal(typeof handlers[0].listener, 'function');
  assert.equal(handlers[1].name, 'agent/pre-step');
  assert.equal(typeof handlers[1].listener, 'function');
  assert.equal(cleanups.length, 1);
  assert.equal(projections.length, 1);
  assert.equal(projections[0].key, 'failureLedger');
  assert.equal(projections[0].stateVersion, 1);
  assert.equal(typeof projections[0].wire.view, 'function');
  assert.equal(tools.length, 2);
  assert.equal(typeof Config, 'function');
  const inboxTool = tools.find((tool) => tool.name === 'failure_inbox');
  const openTool = tools.find((tool) => tool.name === 'open_failure_ledger');
  assert.ok(inboxTool);
  assert.ok(openTool);
  assert.deepEqual(inboxTool.parameters.properties.action.enum, ['list', 'unresolved', 'show', 'resolve', 'stats', 'playbook']);
  assert.match(openTool.description, /conversation anomaly statistics/i);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, '/api/failure-ledger.snapshot');
  assert.deepEqual(Array.from(routes[0].methods), ['GET']);
  assert.equal(routes[1].path, '/api/failure-ledger.admin');
  assert.deepEqual(Array.from(routes[1].methods), ['POST']);
  assert.match(DEFAULT_REPORT_ROOT, /failure-reports/);

  await cleanups[0]();
  assert.ok(warnings.every((warning) => warning.includes('Config schema unavailable')));
});
