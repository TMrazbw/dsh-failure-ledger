/**
 * V2 failure-immunity guard catalog.
 *
 * Phase 2.0 Step 1 is deliberately observation-only: matching a failure records
 * a guard hit; it never changes the tool decision. `action` and `mode` are kept
 * as metadata for the later hint/verification phases.
 */

export const GUARDS_SCHEMA = 'dsh-failure-guards/1';

export const DEFAULT_GUARDS = Object.freeze([
  {
    id: 'edit-read-first',
    label: '编辑前读取',
    tool: 'edit',
    category: 'edit-target',
    action: 'hint',
    hint: 'Read the current file before editing, use an exact unique old_string, and re-read after a stale or write conflict.',
  },
  {
    id: 'search-asar',
    label: '避免 asar 搜索',
    tool: 'grep',
    category: 'search-failed',
    action: 'hint',
    hint: 'Use read/glob for workspace files; native search tools cannot read app.asar paths.',
  },
  {
    id: 'unknown-tool',
    label: '未知工具名',
    category: 'unknown-tool',
    action: 'hint',
    hint: 'That tool does not exist in this session. Use only tools present in the current schema (read/glob/grep/failure_inbox); do not retry the invented name.',
  },
  {
    id: 'dependency-missing',
    label: '依赖缺失',
    category: 'dependency-missing',
    action: 'hint',
    hint: 'A required runtime dependency is missing. Install it or use the bundled tool; do not retry the same unchanged command.',
  },
  {
    id: 'path-check',
    label: '路径先检查',
    category: 'not-found',
    action: 'hint',
    hint: 'Confirm the path, case, and separators with glob/list before retrying.',
  },
  {
    id: 'command-path',
    label: '命令绝对路径',
    category: 'missing-command',
    action: 'hint',
    hint: 'Check PATH or use an absolute executable path; do not repeat the missing command.',
  },
  {
    id: 'timeout-scope',
    label: '超时缩小范围',
    category: 'timeout',
    action: 'hint',
    hint: 'Narrow the scope, run in the background, or reduce output before one retry.',
  },
  {
    id: 'sandbox-boundary',
    label: '工作区边界',
    category: 'sandbox-denied',
    action: 'hint',
    hint: 'Stay inside the workspace or ask the user to widen access; the same call will fail again.',
  },
  {
    id: 'stale-rebase',
    label: '过期写重读',
    category: 'stale-write',
    action: 'hint',
    hint: 'Read the file again, rebase the change on current content, then edit.',
  },
  {
    id: 'shell-runtime',
    label: 'PWSh 进程启动失败',
    tool: 'pwsh',
    category: 'shell-runtime',
    action: 'hint',
    hint: 'PowerShell failed to initialize (0xC0000142). Do not retry the same command; restart DSH/Windows session and use read/glob instead.',
  },
  {
    id: 'human-verification',
    label: '人工验证',
    category: 'human-verification',
    action: 'hint',
    hint: 'Stop automated actions and ask the user to complete verification in the browser window.',
  },
  {
    id: 'browser-download',
    label: '下载不要导航',
    tool: 'browser_open',
    code: 'BROWSER_NAVIGATION_FAILED',
    action: 'hint',
    hint: 'Do not navigate to a file download URL; use the download path or a normal page navigation.',
  },
  {
    id: 'browser-auth',
    label: '浏览器授权',
    tool: 'browser_auth',
    action: 'hint',
    hint: 'Start or restore the browser session before retrying the authenticated action.',
  },
].map((guard) => Object.freeze({
  enabled: true,
  mode: 'observe',
  scope: 'global',
  ...guard,
})));

/**
 * Merge persisted guards over the built-in defaults.
 *
 * @param {unknown} input - array or `{guards: []}` from `guards.json`.
 * @returns {object[]} normalized guards with runtime counters.
 */
export function normalizeGuards(input) {
  const values = Array.isArray(input)
    ? input
    : Array.isArray(input?.guards) ? input.guards : [];
  const byId = new Map();
  for (const guard of DEFAULT_GUARDS) byId.set(guard.id, { ...guard });
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' ? value.id : '';
    if (!id) continue;
    const base = byId.get(id) ?? {
      id,
      label: id,
      action: 'hint',
      enabled: true,
      mode: 'observe',
      scope: 'global',
    };
    byId.set(id, {
      ...base,
      ...value,
      id,
      enabled: value.enabled !== false,
      mode: value.mode === 'enforce' ? 'enforce' : 'observe',
      action: value.action === 'observe' ? 'observe' : 'hint',
      hits: nonNegative(value.hits),
      lastHitAt: typeof value.lastHitAt === 'string' ? value.lastHitAt : null,
      lastFingerprint: typeof value.lastFingerprint === 'string' ? value.lastFingerprint : null,
    });
  }
  return [...byId.values()].map((guard) => ({
    ...guard,
    hits: nonNegative(guard.hits),
    lastHitAt: typeof guard.lastHitAt === 'string' ? guard.lastHitAt : null,
    lastFingerprint: typeof guard.lastFingerprint === 'string' ? guard.lastFingerprint : null,
  }));
}

/**
 * Find the most specific enabled guard for one failure.
 *
 * @param {object[]} guards - normalized guard list.
 * @param {{tool?: string, category?: string, code?: string|null}} failure - failure classification.
 * @returns {object|null} matched guard.
 */
export function matchGuard(guards, failure = {}) {
  let best = null;
  let bestScore = -1;
  for (const guard of guards) {
    if (!guard || guard.enabled === false) continue;
    if (guard.tool != null && guard.tool !== failure.tool) continue;
    if (guard.category != null && guard.category !== failure.category) continue;
    if (guard.code != null && guard.code !== failure.code) continue;
    if (guard.fingerprint != null && guard.fingerprint !== failure.fingerprint) continue;
    const score = (guard.fingerprint != null ? 8 : 0)
      + (guard.code != null ? 4 : 0)
      + (guard.category != null ? 2 : 0)
      + (guard.tool != null ? 1 : 0);
    if (score > bestScore) {
      best = guard;
      bestScore = score;
    }
  }
  return best;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
