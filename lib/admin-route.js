/**
 * Authenticated admin route for the failure-ledger panel.
 *
 * The panel does not depend on the optional `configForms` Client service:
 * settings are written through the Host `settings` Service, while Guards are
 * stored atomically in `guards.json`. Actions are intentionally narrow:
 *
 * - `config`: `{ ops: SettingsPathOp[], revision? }`
 * - `saveGuard`: `{ guard: {...} }`
 * - `deleteGuard`: `{ id: string }`
 *
 * The route never exposes raw reports or arbitrary filesystem writes.
 */

const CONFIG_ACTION = 'config';
const SAVE_GUARD = 'saveGuard';
const DELETE_GUARD = 'deleteGuard';
const MAX_GUARDS = 100;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ADMIN_ROUTE = '/api/failure-ledger.admin';

/**
 * Build the POST admin route.
 *
 * @param {{store: object, getSettings?: Function, ns?: string, onConfigChanged?: Function}} options - dependencies.
 * @returns {object} ConnectionFetchRoute.
 */
export function createAdminRoute(options = {}) {
  const store = options.store;
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => null;
  const configuredNs = typeof options.ns === 'string' ? options.ns : '';
  const onConfigChanged = typeof options.onConfigChanged === 'function' ? options.onConfigChanged : null;

  return {
    path: ADMIN_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request?.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      const contentType = request.headers?.get?.('content-type') ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return json({ ok: false, error: 'unsupported_media_type' }, 415);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid_json' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ ok: false, error: 'invalid_body' }, 400);
      }

      try {
        if (body.action === CONFIG_ACTION) {
          const settings = getSettings();
          if (!settings || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
            return json({ ok: false, error: 'settings_unavailable' }, 503);
          }
          const descriptors = await settings.describe();
          const scoped = pickDescriptor(descriptors, configuredNs);
          if (!scoped) return json({ ok: false, error: 'settings_entry_not_found' }, 404);
          const ops = normalizeOps(body.ops);
          if (!ops) return json({ ok: false, error: 'invalid_ops' }, 400);
          const revision = Number.isInteger(body.revision) ? body.revision : scoped.revision;
          await settings.mutate(scoped.ns, ops, revision);
          if (onConfigChanged) {
            try {
              const updated = await settings.describe();
              const entry = pickDescriptor(updated, configuredNs);
              if (entry?.value) onConfigChanged(entry.value);
            } catch {
              // The save succeeded; a stale snapshot is preferable to a false error.
            }
          }
          return json({ ok: true, revision: revision + 1 });
        }

        if (body.action === SAVE_GUARD) {
          const guard = normalizeGuard(body.guard);
          if (!guard) return json({ ok: false, error: 'invalid_guard' }, 400);
          const existing = await store.listGuards();
          if (existing.ok && existing.guards.length >= MAX_GUARDS
            && !existing.guards.some((row) => row.id === guard.id)) {
            return json({ ok: false, error: 'too_many_guards' }, 400);
          }
          const saved = await store.saveGuard(guard);
          if (!saved.ok) return json({ ok: false, error: saved.error ?? 'save_failed' }, 500);
          return json({ ok: true, guard: saved.guard });
        }

        if (body.action === DELETE_GUARD) {
          const deleted = await store.deleteGuard(body.id);
          if (!deleted.ok) return json({ ok: false, error: deleted.error ?? 'delete_failed' }, 400);
          return json({ ok: true });
        }

        return json({ ok: false, error: 'unknown_action' }, 400);
      } catch (error) {
        return json({
          ok: false,
          error: 'admin_failed',
          message: error instanceof Error ? error.message : String(error),
        }, 500);
      }
    },
  };
}

function pickDescriptor(descriptors, configuredNs) {
  if (!Array.isArray(descriptors)) return null;
  if (configuredNs) {
    const exact = descriptors.find((entry) => String(entry.ns) === configuredNs);
    if (exact) return exact;
    const suffix = descriptors.find((entry) => String(entry.ns).endsWith(configuredNs));
    if (suffix) return suffix;
  }
  return descriptors.find((entry) => String(entry.ns).endsWith('failure-ledger')) ?? null;
}

function normalizeOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 80) return null;
  const normalized = [];
  for (const op of ops) {
    if (!op || op.op !== 'set' || !Array.isArray(op.path) || op.path.length === 0) return null;
    const path = op.path.map((part) => String(part));
    if (!isAllowedPath(path)) return null;
    normalized.push({ op: 'set', path, value: op.value });
  }
  return normalized;
}

function isAllowedPath(path) {
  const [root, second, third] = path;
  if (path.length === 1 && root === 'minSeverity') return true;
  if (root === 'digest' && path.length === 2) return ['enabled', 'maxInlineTokens', 'maxDetailChars'].includes(second);
  if (root === 'savings' && path.length === 2) return ['priceMode', 'customUnitPricePerMTokens'].includes(second);
  if (root === 'report' && path.length === 2) return ['maxTotalMB', 'rawMaxBytes', 'logMaxBytes'].includes(second);
  if (root === 'guards' && path.length === 2) return ['enabled', 'hint'].includes(second);
  if (root === 'rules' && path.length === 3) {
    return second.length <= 64 && ['enabled', 'threshold', 'windowMinutes', 'minRawTokens',
      'alertAfter', 'minInputTokens', 'ratio', 'minStepsWithoutProgress'].includes(third);
  }
  return false;
}

function normalizeGuard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = text(input.id, 64);
  if (!ID_PATTERN.test(id)) return null;
  const label = text(input.label, 80) || id;
  const tool = text(input.tool, 80) || null;
  const category = text(input.category, 80) || null;
  const code = text(input.code, 100) || null;
  const hint = text(input.hint, 320);
  if (!tool && !category && !code) return null;
  return {
    id,
    label,
    tool,
    category,
    code,
    hint,
    action: input.action === 'observe' ? 'observe' : 'hint',
    mode: 'observe',
    scope: 'global',
    enabled: input.enabled !== false,
  };
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
