/**
 * dsh-failure-ledger — Host half.
 *
 * Owns the global failure pipeline (post-execute digest + store), the
 * `failureLedger` session projection, the `failure_inbox` tool, the INBOX
 * refresh loop, and the authenticated panel snapshot route.
 *
 * The Client half registers the per-Turn reminder and the sidebar panel.
 */

import { cpSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAnomalyView } from './lib/anomaly.js';
import { createAdminRoute } from './lib/admin-route.js';
import {
  DEFAULT_REPORT_ROOT,
  normalizeHostConfig,
} from './lib/config-schema.js';
import { Config } from './lib/config-schema-host.js';
import { createDigestHandler } from './lib/digest.js';
import { createGuardHintListener, createHintQueue } from './lib/hints.js';
import {
  createFailureInboxTool,
  createOpenPanelTool,
  refreshInbox,
} from './lib/inbox.js';
import { PROJECTION_KEY, createFailureLedgerProjection } from './lib/projection.js';
import { createSnapshotRoute, buildSnapshot } from './lib/snapshot.js';
import { createStore } from './lib/store.js';
import { createTokenWasteGuard } from './lib/token-waste.js';
import { createSelfHealTracker } from './lib/self-heal.js';

export { Config, DEFAULT_REPORT_ROOT };

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveSettings(config) {
  const settings = normalizeHostConfig(config);
  settings.reportRoot = path.isAbsolute(settings.reportRoot)
    ? settings.reportRoot
    : path.resolve(PLUGIN_DIR, settings.reportRoot);
  return settings;
}

const LEGACY_REPORT_ROOT = path.join(path.dirname(PLUGIN_DIR), 'failure-reports');

/**
 * Move the pre-rename report directory into the plugin directory once.
 *
 * The Host process can write there even when the shell sandbox cannot. A
 * successful rename is preferred; if the directory is locked, a recursive
 * copy preserves the old data and leaves the original as a safety copy.
 *
 * @param {string} target - configured report root.
 * @param {string} legacy - historical report root.
 */
function migrateReportRoot(target, legacy) {
  if (!target || target === legacy || existsSync(target) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, target);
  } catch {
    try {
      cpSync(legacy, target, { recursive: true });
    } catch {
      // Keep the old directory; the store will start a fresh target.
    }
  }
}

/**
 * Host plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - validated row config (defaults are merged here too).
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const hintQueue = createHintQueue();
  const tokenWaste = createTokenWasteGuard({ queue: hintQueue });
  const turnBySession = new Map();
  const selfHeal = createSelfHealTracker({
    windowMs: settings.selfHeal.windowSeconds * 1000,
  });
  let handler = null;
  migrateReportRoot(settings.reportRoot, LEGACY_REPORT_ROOT);
  const store = createStore({
    root: settings.reportRoot,
    maxTotalBytes: settings.report.maxTotalMB * 1024 * 1024,
    rawMaxBytes: settings.report.rawMaxBytes,
    logMaxBytes: settings.report.logMaxBytes,
    currency: 'CNY',
  });
  void store.init().then(() => refreshInbox(store)).catch(() => {});

  if (settings.projection.enabled) {
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.effect(() => projectionCtx.sessionProjections.register(createFailureLedgerProjection({
        rules: settings.rules,
      })));
    });
  }

  const getSessionStats = (agent) => {
    try {
      const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
      const session = agent?.session;
      if (!projections || typeof projections.stateOf !== 'function' || !session) return null;
      const state = projections.stateOf(session, PROJECTION_KEY);
      return state == null ? null : createAnomalyView(state, { rules: settings.rules });
    } catch {
      return null;
    }
  };

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = [
        toolCtx.tools.register(createFailureInboxTool({ store, getSessionStats })),
        toolCtx.tools.register(createOpenPanelTool()),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // Ignore double disposal.
          }
        }
      };
    });
  });

  ctx.inject(['connection', 'settings', 'sessionQuery', 'workspaceRegistry', 'workspaceController'], (connectionCtx) => {
    const readConfig = async () => {
      try {
        const descriptors = await connectionCtx.settings.describe();
        const entry = Array.isArray(descriptors)
          ? descriptors.find((item) => String(item.ns).endsWith('failure-ledger'))
          : null;
        return entry?.value && typeof entry.value === 'object'
          ? { ...config, ...entry.value }
          : config;
      } catch {
        return config;
      }
    };

    const readSessionTitles = async (sessionIds) => {
      try {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) return {};
        const results = await connectionCtx.sessionQuery.readTitleSnapshots(sessionIds);
        const titles = {};
        for (const result of results ?? []) {
          if (result?.status === 'fulfilled') {
            const title = result.value?.title?.title;
            if (typeof title === 'string' && title.trim() !== '') {
              titles[String(result.sessionId)] = title.trim();
            }
          }
        }
        return titles;
      } catch {
        return {};
      }
    };

    const readArchivedSessionIds = async () => {
      const controller = new AbortController();
      try {
        const stream = connectionCtx.workspaceController.follow(controller.signal);
        for await (const frame of stream) {
          if (frame?.type === 'baseline') {
            return new Set((frame.value?.archivedSessionIds ?? []).map((id) => String(id)));
          }
          break;
        }
      } catch {
        // An unavailable workspace stream should not hide the catalog.
      } finally {
        controller.abort();
      }
      return new Set();
    };

    const readCatalog = async () => {
      const archived = await readArchivedSessionIds();
      const children = new Set();
      let records = [];
      try {
        records = await connectionCtx.sessionQuery.listSessions();
        for (const record of Array.isArray(records) ? records : []) {
          if (record?.header?.parentSession) children.add(String(record.header.id));
        }
      } catch {
        records = [];
      }
      const seen = new Set();
      try {
        for (const workspace of connectionCtx.workspaceRegistry.list()) {
          for (const sessionId of workspace?.sessionIds ?? []) {
            const id = String(sessionId ?? '');
            if (id && !archived.has(id) && !children.has(id)) seen.add(id);
          }
        }
      } catch {
        // Fall through to the query-backed catalog.
      }
      if (seen.size > 0) return [...seen].map((sessionId) => ({ sessionId }));
      return (Array.isArray(records) ? records : [])
        .filter((record) => !record?.header?.parentSession)
        .map((record) => String(record?.header?.id ?? ''))
        .filter((id) => id && !archived.has(id))
        .map((sessionId) => ({ sessionId }));
    };

    connectionCtx.effect(() => {
      const disposeSnapshot = connectionCtx.connection.fetch.register(createSnapshotRoute({
        getSnapshot: async () => {
          const catalog = await readCatalog();
          const stats = await store.getSessionStats();
          const ids = [...new Set([
            ...catalog.map((row) => row.sessionId),
            ...(stats?.sessions ?? []).map((row) => row.sessionId),
          ])];
          const titles = await readSessionTitles(ids);
          const titled = catalog.filter((row) => {
            const title = titles[String(row.sessionId)];
            return typeof title === 'string' && title.trim() !== '';
          });
          const visibleCatalog = Object.keys(titles).length > 0 ? titled : catalog;
          return buildSnapshot({
            store,
            config: resolveSettings(await readConfig()),
            sessionTitles: titles,
            sessionCatalog: visibleCatalog,
          });
        },
      }));
      const disposeAdmin = connectionCtx.connection.fetch.register(createAdminRoute({
        store,
        getSettings: () => connectionCtx.settings ?? null,
        onConfigChanged: (value) => {
          const next = resolveSettings({ ...config, ...value });
          Object.assign(settings, next);
          if (handler) {
            Object.assign(handler.config, {
              ...next.digest,
              priceMode: next.savings.priceMode,
              minSeverity: next.minSeverity,
              guardObserve: next.guards.enabled,
            });
          }
        },
      }));
      return () => {
        disposeSnapshot();
        disposeAdmin();
      };
    });
  });

  handler = createDigestHandler({
    store,
    config: {
      ...settings.digest,
      priceMode: settings.savings.priceMode,
      minSeverity: settings.minSeverity,
      guardObserve: settings.guards.enabled,
    },
    onGuardHit: ({ session, guard }) => {
      if (settings.guards.hint !== false && guard?.action !== 'observe') {
        hintQueue.push(session, guard);
      }
    },
    onUnresolved: (entry) => {
      if (settings.guards.hint === false || settings.guards.autoHint === false || !entry?.session) return;
      const code = entry.code ? `/${entry.code}` : '';
      hintQueue.push(entry.session, {
        id: 'unresolved-failure',
        label: '未解决失败',
        action: 'hint',
        hint: `[未解决失败] ${entry.tool}/${entry.category}${code}: ${entry.hint || 'Inspect the failure and correct the call.'}`,
      });
    },
    onFailurePersisted: (entry, exec) => {
      if (settings.selfHeal.enabled === false) return;
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;
      if (!sessionId) return;
      selfHeal.noteFailure({
        sessionId,
        tool: exec?.name,
        turn: turnBySession.get(String(sessionId)),
        fingerprint: entry.fingerprint,
        failureId: entry.id,
        hint: entry.hint,
        args: exec?.arguments,
      });
    },
    onToolResult: (exec, result, decision) => {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;
      if (settings.guards.tokenWaste !== false) {
        tokenWaste.observe({
          sessionId,
          tool: exec?.name,
          args: exec?.arguments,
          isError: result?.isError === true,
          decision,
        });
      }
      if (settings.selfHeal.enabled === false || result?.isError === true) return;
      const heal = selfHeal.noteSuccess({
        sessionId,
        tool: exec?.name,
        turn: turnBySession.get(String(sessionId)),
        args: exec?.arguments,
      });
      if (!heal) return;
      hintQueue.clear(sessionId);
      const id = heal.failure.failureId ?? heal.failure.fingerprint;
      if (!id) return;
      const fix = `自动自愈：${heal.failure.hint || '失败后同工具修正调用成功。'}`;
      void store.resolveFailure({ id, fix, scope: 'all', learn: true })
        .then((resolved) => {
          if (resolved?.ok) void refreshInbox(store);
        })
        .catch(() => {});
    },
    onPersisted: () => refreshInbox(store),
    onError: (error) => {
      try {
        ctx.logger?.warn?.(`[dsh-failure-ledger] ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // Logging must never affect tool execution.
      }
    },
  });

  const guardHintListener = createGuardHintListener({
    queue: hintQueue,
    enabled: settings.guards.hint !== false,
  });

  const turnListener = async (payload, next) => {
    const sessionId = payload?.agent?.id ?? payload?.agent?.session?.id ?? null;
    if (sessionId != null) {
      turnBySession.set(String(sessionId), payload?.turn ?? null);
      if (turnBySession.size > 500) {
        const oldest = turnBySession.keys().next().value;
        if (oldest !== undefined) turnBySession.delete(oldest);
      }
    }
    return next();
  };

  ctx.effect(() => {
    const disposeTool = ctx.on('tools/post-execute', handler.listener);
    const disposeHint = ctx.on('agent/pre-step', guardHintListener);
    const disposeTurn = ctx.on('agent/pre-step', turnListener);
    return () => {
      try {
        disposeTool();
      } catch {
        // Ignore double disposal.
      }
      try {
        disposeHint();
      } catch {
        // Ignore double disposal.
      }
      try {
        disposeTurn();
      } catch {
        // Ignore double disposal.
      }
      return store.close();
    };
  });
}

