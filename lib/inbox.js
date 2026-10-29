/**
 * Failure INBOX rendering and the `failure_inbox` agent tool.
 *
 * Output is bounded: `list` ≤10 lines, `show` ≤60 report lines plus the report
 * path, `stats` ≤15 lines. Every action returns model-readable text; failures
 * are reported as text instead of thrown so one bad lookup cannot fail a turn.
 */

import { groupFailures } from './groups.js';
import { formatTokens, renderInbox } from './render.js';

export const FAILURE_INBOX_TOOL_NAME = 'failure_inbox';
export const OPEN_PANEL_TOOL_NAME = 'open_failure_ledger';
export const DFL_UI_COMMAND = 'dfl-ui';

/**
 * Build the `open_failure_ledger` ToolDefinition.
 *
 * The tool itself only returns a request acknowledgement; the projection folds
 * the call and a mounted Client bridge opens the panel. This keeps the model
 * able to satisfy a natural-language "open the panel" request without a
 * model-visible UI command.
 *
 * @returns {object} ToolDefinition-shaped object.
 */
export function createOpenPanelTool() {
  return {
    name: OPEN_PANEL_TOOL_NAME,
    description:
      'Open the Failure Ledger panel in the DSH web UI. Call this whenever the user asks to open, '
      + 'show, or view the failure ledger (对话异常统计) or conversation anomaly statistics (对话异常统计), '
      + 'failure statistics, anomalies, token savings, or the DFL-UI panel. '
      + 'The tool only opens the local panel; it does not change data.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional short summary of what the user asked to see.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute() {
      return 'Conversation Anomaly Stats panel requested.';
    },
  };
}

/**
 * Build the `failure_inbox` ToolDefinition.
 *
 * @param {{store: object, getSessionStats?: (agent: object|undefined) => object|null}} options - tool dependencies.
 * @returns {object} ToolDefinition-shaped object.
 */
export function createFailureInboxTool(options = {}) {
  const store = options.store;
  const getSessionStats = typeof options.getSessionStats === 'function' ? options.getSessionStats : null;
  return {
    name: FAILURE_INBOX_TOOL_NAME,
    description:
      'Read or update the local failure ledger after a failure or when optimizing recurring failures. '
      + 'Returns bounded summaries, not raw logs. Actions: list, unresolved, show, resolve, stats, playbook.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'unresolved', 'show', 'resolve', 'stats', 'playbook'],
          description: 'list recent failures, group unresolved fingerprints, show one report, resolve one failure, read totals, or retrieve resolved fixes.',
        },
        id: { type: 'string', description: 'Failure id or fingerprint for show/resolve.' },
        scope: {
          type: 'string',
          enum: ['current', 'all'],
          default: 'current',
          description: 'Current session only, or every session in the local ledger.',
        },
        limit: { type: 'integer', description: 'Maximum rows for list or playbook (1-8).' },
        fix: { type: 'string', description: 'Resolution note for resolve.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args = {}, exec) {
      const agent = exec?.agent;
      const sessionId = agent?.id ?? agent?.session?.id ?? null;
      const sessionStats = getSessionStats == null ? null : getSessionStats(agent);
      return runFailureInbox({ store, args, sessionId, sessionStats });
    },
  };
}

/**
 * Execute one `failure_inbox` action.
 *
 * @param {{store?: object, args?: object, sessionId?: string|null, sessionStats?: object|null}} input - action context.
 * @returns {Promise<string>} bounded text.
 */
export async function runFailureInbox(input = {}) {
  const store = input.store;
  if (!store) return 'failure_inbox unavailable: the ledger store is not ready.';
  const args = input.args ?? {};
  const action = String(args.action ?? '');
  const scope = args.scope === 'all' ? 'all' : 'current';
  const sessionId = input.sessionId == null ? null : String(input.sessionId);

  try {
    if (action === 'list') return await listAction(store, args, scope, sessionId);
    if (action === 'unresolved') return await unresolvedAction(store, args);
    if (action === 'show') return await showAction(store, args, scope, sessionId);
    if (action === 'resolve') return await resolveAction(store, args, scope, sessionId);
    if (action === 'stats') return await statsAction(store, input.sessionStats);
    if (action === 'playbook') return await playbookAction(store, args);
    return `Unknown failure_inbox action: ${action || '(missing)'}. Use list, show, resolve, stats, or playbook.`;
  } catch (error) {
    return `failure_inbox ${action || 'action'} failed: ${errorMessage(error)}`;
  }
}

/**
 * Rebuild `INBOX.md` from the newest failures and monotonic totals.
 *
 * @param {object} store - store instance.
 * @param {{limit?: number}} [options] - row limit (max 20).
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function refreshInbox(store, options = {}) {
  if (!store || typeof store.listFailures !== 'function' || typeof store.getTotals !== 'function') {
    return { ok: false, error: 'store unavailable' };
  }
  const limit = clamp(options.limit ?? 20, 1, 20);
  const [list, totals] = await Promise.all([
    store.listFailures({ limit, scope: 'all' }),
    store.getTotals(),
  ]);
  if (!list.ok) return { ok: false, error: list.error };
  if (!totals.ok) return { ok: false, error: totals.error };

  const rows = list.entries.map(rowFromEntry);
  const markdown = renderInbox({
    rows,
    newCount: rows.length,
    total: totals.totals.failures,
    savedTokens: totals.totals.savedTokens,
    limit: 20,
  });
  return store.writeInbox(markdown);
}

async function unresolvedAction(store, args) {
  const limit = Math.min(8, Math.max(1, Number(args.limit) || 8));
  const result = await store.listFailures({ limit: 500, scope: 'all' });
  if (!result.ok) return `failure_inbox unresolved failed: ${result.error ?? 'unknown error'}`;
  const groups = groupFailures(result.entries);
  const lines = [`Unresolved — ${groups.length} fingerprints, ${result.entries.length} entries`];
  for (const group of groups.slice(0, limit)) {
    lines.push(`${group.fingerprint} | ${group.tool}/${group.category} | ${group.count} | ${shortTime(group.lastSeen)} | ${group.report ?? '—'}`);
  }
  if (groups.length === 0) lines.push('No unresolved failures.');
  return lines.slice(0, 10).join('\n');
}

async function listAction(store, args, scope, sessionId) {
  if (scope === 'current' && sessionId == null) {
    return 'Current session is unavailable; use scope="all".';
  }
  const limit = clamp(args.limit ?? 5, 1, 8);
  const list = await store.listFailures({ limit, scope, sessionId });
  if (!list.ok) return `failure_inbox list failed: ${list.error ?? 'unknown error'}`;
  const totals = await store.getTotals();
  const total = totals.ok ? totals.totals.failures : 0;
  const saved = totals.ok ? totals.totals.savedTokens : 0;
  const rows = list.entries;
  const lines = [`Failure inbox — ${rows.length} recent, ${total} total, est. ${formatTokens(saved)} tokens saved`];
  if (rows.length === 0) {
    lines.push('No failures recorded.');
  } else {
    for (const entry of rows) {
      lines.push([
        entry.id,
        entry.severity ?? 'medium',
        entry.tool ?? 'tool',
        entry.category ?? 'unknown',
        shortTime(entry.time),
        entry.report ?? '',
      ].join(' | '));
    }
    lines.push('Use failure_inbox show id=... for the bounded report.');
  }
  return lines.slice(0, 10).join('\n');
}

async function showAction(store, args, scope, sessionId) {
  const id = String(args.id ?? '').trim();
  if (!id) return 'failure_inbox show requires id (failure id or fingerprint).';
  if (scope === 'current' && sessionId == null) {
    return 'Current session is unavailable; use scope="all".';
  }
  const found = await store.findFailure({ id, scope, sessionId });
  if (!found.ok) return `failure_inbox show failed: ${found.error ?? 'unknown error'}`;
  if (!found.entry) return `Failure not found: ${id}`;
  const report = await store.readReport(found.entry.fingerprint);
  if (!report.ok) return `failure_inbox show failed: ${report.error ?? 'unknown error'}`;
  const text = report.text == null ? '(report missing)' : report.text;
  const lines = text.split('\n').slice(0, 60).join('\n');
  return `${lines}\nReport: ${found.entry.report}`;
}

async function resolveAction(store, args, scope, sessionId) {
  const id = String(args.id ?? '').trim();
  const fix = String(args.fix ?? '').trim().slice(0, 2000);
  if (!id) return 'failure_inbox resolve requires id.';
  if (!fix) return 'failure_inbox resolve requires a non-empty fix.';
  if (scope === 'current' && sessionId == null) {
    return 'Current session is unavailable; use scope="all".';
  }
  const resolved = await store.resolveFailure({ id, fix, scope, sessionId });
  if (!resolved.ok) return `failure_inbox resolve failed: ${resolved.error ?? 'unknown error'}`;
  await refreshInbox(store);
  const learned = resolved.guardId
    ? ` · Guard ${resolved.guardId}${resolved.regression ? ` · regression ${resolved.regression}` : ''}`
    : '';
  return `Resolved ${resolved.entry.id} (${resolved.entry.fingerprint})${learned}: ${fix}`;
}

async function statsAction(store, sessionStats) {
  const totals = await store.getTotals();
  if (!totals.ok) return `failure_inbox stats failed: ${totals.error ?? 'unknown error'}`;
  const value = totals.totals;
  const lines = [
    'Failure ledger stats',
    `failures: ${value.failures} | anomalies: ${value.anomalies} | compressions: ${value.compressions}`,
    `saved tokens: ${value.savedTokens} | anomaly wasted: ${value.anomalyWastedTokens}`,
    `routes: ${Object.keys(value.byRoute ?? {}).length} | tools: ${Object.keys(value.byTool ?? {}).length} | rules: ${Object.keys(value.byRule ?? {}).length}`,
    `top tools: ${topEntries(value.byTool, (entry) => entry.failures ?? entry.savedTokens)}`,
    `top rules: ${topEntries(value.byRule)}`,
  ];
  if (sessionStats) {
    lines.push(`session: n1=${sessionStats.n1 ?? 0} n2=${sessionStats.n2 ?? 0} saved=${sessionStats.savedTokens ?? 0}`);
  }
  return lines.slice(0, 15).join('\n');
}

async function playbookAction(store, args) {
  const limit = Math.min(8, Math.max(1, Number(args.limit) || 5));
  const result = await store.listPlaybook({ limit });
  if (!result.ok) return `failure_inbox playbook failed: ${result.error ?? 'unknown error'}`;
  const lines = [`Playbook — ${result.entries.length} recent resolved fixes`];
  for (const entry of result.entries) {
    const fix = String(entry.fix ?? '').replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`${entry.fingerprint ?? '?'} | ${entry.guardId ?? 'unguarded'} | ${shortTime(entry.resolvedAt)} | ${fix || '—'}`);
  }
  if (result.entries.length === 0) lines.push('No resolved fixes yet.');
  return lines.slice(0, 10).join('\n');
}

function rowFromEntry(entry) {
  return {
    id: entry.id,
    severity: entry.severity ?? 'medium',
    tool: entry.tool ?? 'tool',
    category: entry.category ?? 'unknown',
    count: entry.count ?? 1,
    last: shortTime(entry.time),
    report: entry.report ?? '',
  };
}

function topEntries(map, pick = (value) => value) {
  const entries = Object.entries(map ?? {})
    .map(([key, value]) => [key, Number(pick(value)) || 0])
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, value]) => `${key}:${value}`);
  return entries.length === 0 ? '—' : entries.join(', ');
}

function shortTime(value) {
  if (typeof value === 'string' && value.length >= 16) return value.slice(11, 16);
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) : '';
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
