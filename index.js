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
import {
  DEFAULT_REPORT_ROOT,
  normalizeHostConfig,
} from './lib/config-schema.js';
import { Config } from './lib/config-schema-host.js';
import { createDigestHandler } from './lib/digest.js';
import {
  createFailureInboxTool,
  createOpenPanelTool,
  refreshInbox,
} from './lib/inbox.js';
import { PROJECTION_KEY, createFailureLedgerProjection } from './lib/projection.js';
import { createSnapshotRoute, buildSnapshot } from './lib/snapshot.js';
import { createStore } from './lib/store.js';

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

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register(createSnapshotRoute({
      getSnapshot: () => buildSnapshot({ store, config: resolveSettings(config) }),
    })));
  });

  const handler = createDigestHandler({
    store,
    config: {
      ...settings.digest,
      priceMode: settings.savings.priceMode,
      minSeverity: settings.minSeverity,
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

  ctx.effect(() => {
    const dispose = ctx.on('tools/post-execute', handler.listener);
    return () => {
      try {
        dispose();
      } catch {
        // Ignore double disposal.
      }
      return store.close();
    };
  });
}

