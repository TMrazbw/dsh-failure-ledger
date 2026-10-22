/**
 * Durable local storage for the failure ledger.
 *
 * Layout (PROJECT.md §2.6):
 *   <root>/index.jsonl       one line per failure
 *   <root>/savings.jsonl     one line per compressed error
 *   <root>/anomalies.jsonl   one line per anomaly hit
 *   <root>/totals.json       monotonic global counters (never shrink on prune)
 *   <root>/playbook.jsonl    resolved fingerprints -> fixes
 *   <root>/reports/<fp>.md   aggregated failure report
 *   <root>/raw/<id>.txt      bounded raw error text
 *   <root>/handoffs/<id>.md  per-session handoff
 *   <root>/INBOX.md          rendered by the inbox step
 *   <root>/_plugin.log       plugin's own errors, rotated at 1 MiB
 *
 * All writes are serialized through one promise queue. Public operations never
 * throw to the caller: a failure returns `{ok:false, error}` and is appended to
 * `_plugin.log` when that is possible.
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderReport, truncateMiddle } from './render.js';

export const STORE_SCHEMA = 1;

export const DEFAULT_STORE_OPTIONS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  rawMaxBytes: 32 * 1024,
  logMaxBytes: 1024 * 1024,
  currency: 'CNY',
});

const JSONL_FILES = Object.freeze(['index.jsonl', 'savings.jsonl', 'anomalies.jsonl', 'playbook.jsonl']);

/**
 * Create a store. Call {@link Store#init} once before writes.
 *
 * @param {{root: string, maxBytes?: number, maxTotalBytes?: number, rawMaxBytes?: number, logMaxBytes?: number, currency?: string, now?: () => Date|number}} options - store options.
 * @returns {Store} store instance.
 */
export function createStore(options = {}) {
  return new Store(options);
}

export class Store {
  constructor(options = {}) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new TypeError('createStore requires a non-empty root path');
    }
    this.root = path.resolve(options.root);
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.maxBytes = positiveNumber(options.maxBytes, DEFAULT_STORE_OPTIONS.maxBytes);
    this.maxTotalBytes = positiveNumber(options.maxTotalBytes, DEFAULT_STORE_OPTIONS.maxTotalBytes);
    this.rawMaxBytes = positiveNumber(options.rawMaxBytes, DEFAULT_STORE_OPTIONS.rawMaxBytes);
    this.logMaxBytes = positiveNumber(options.logMaxBytes, DEFAULT_STORE_OPTIONS.logMaxBytes);
    this.currency = String(options.currency ?? DEFAULT_STORE_OPTIONS.currency);

    this.paths = Object.freeze({
      root: this.root,
      index: path.join(this.root, 'index.jsonl'),
      savings: path.join(this.root, 'savings.jsonl'),
      anomalies: path.join(this.root, 'anomalies.jsonl'),
      totals: path.join(this.root, 'totals.json'),
      playbook: path.join(this.root, 'playbook.jsonl'),
      inbox: path.join(this.root, 'INBOX.md'),
      log: path.join(this.root, '_plugin.log'),
      reports: path.join(this.root, 'reports'),
      raw: path.join(this.root, 'raw'),
      handoffs: path.join(this.root, 'handoffs'),
    });

    this._tail = Promise.resolve();
    this._closed = false;
    this._tmpCounter = 0;
    this._idCounter = 0;
    this._spaceWrites = 0;
    this._writeErrors = 0;
  }

  /** @returns {object} immutable path table. */
  getPaths() {
    return this.paths;
  }

  /**
   * Deterministic report path for one fingerprint (no I/O).
   *
   * @param {string} fingerprint - failure fingerprint.
   * @returns {string} absolute report path.
   */
  reportPathFor(fingerprint) {
    return this._reportPath(fingerprint);
  }

  /** @returns {number} number of write failures observed by this instance. */
  get writeErrors() {
    return this._writeErrors;
  }

  /**
   * Create the directory tree and seed files. Safe to call more than once.
   *
   * @returns {Promise<{ok: boolean, paths?: object, error?: string}>}
   */
  init() {
    return this._safe(async () => {
      await this._ensureLayout();
      await this._enforceSpaceLimit();
      return { paths: this.paths };
    });
  }

  /**
   * Record one failure: append the index line, aggregate the report, update
   * monotonic totals, and optionally write bounded raw text.
   *
   * @param {object} entry - failure fields; `fingerprint` is required.
   * @returns {Promise<{ok: boolean, id?: string, count?: number, reportPath?: string, error?: string}>}
   */
  recordFailure(entry = {}) {
    return this._safe(async () => {
      const fingerprint = String(entry.fingerprint ?? '').trim();
      if (!fingerprint) throw new Error('recordFailure requires a fingerprint');
      await this._ensureLayout();

      const now = this._nowDate();
      const time = toIso(entry.time, now);
      const id = entry.id == null
        ? `F-${compactTime(now)}-${safeSegment(fingerprint).slice(0, 12)}-${String(++this._idCounter).padStart(3, '0')}`
        : String(entry.id);
      const tool = entry.tool == null ? 'unknown' : String(entry.tool);
      const category = entry.category == null ? 'unknown' : String(entry.category);
      const route = entry.route == null
        ? `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`
        : String(entry.route);
      const tokensRaw = numberOrZero(entry.tokensRaw);
      const tokensDigest = numberOrZero(entry.tokensDigest);

      const indexEntry = {
        schema: 'dsh-failure-index/1',
        id,
        fingerprint,
        time,
        session: entry.session ?? null,
        parent: entry.parent ?? null,
        agentKind: entry.agentKind ?? 'root',
        tool,
        category,
        severity: entry.severity ?? 'medium',
        code: entry.code ?? null,
        tokensRaw,
        tokensDigest,
        tokensSaved: Math.max(0, tokensRaw - tokensDigest),
        route,
        report: path.relative(this.root, this._reportPath(fingerprint)).split(path.sep).join('/'),
      };
      if (entry.raw != null) {
        await this._writeRaw(id, entry.raw);
      }

      const report = await this._updateReport({ ...entry, id, fingerprint, time, tool, category, route, tokensRaw, tokensDigest });
      indexEntry.count = report.count;
      await this._appendJsonl(this.paths.index, indexEntry);

      const totals = await this._readTotals();
      totals.failures += 1;
      totals.byTool[tool] ??= { failures: 0, savedTokens: 0 };
      totals.byTool[tool].failures += 1;
      totals.byRoute[route] ??= { failures: 0, savedTokens: 0 };
      totals.byRoute[route].failures += 1;
      totals.byCategory[category] = numberOrZero(totals.byCategory[category]) + 1;
      const sessionKey = entry.session == null ? 'unknown' : String(entry.session);
      totals.bySession[sessionKey] = numberOrZero(totals.bySession[sessionKey]) + 1;
      await this._writeTotals(totals);
      await this._maybeEnforceSpace();

      return { id, count: report.count, reportPath: report.reportPath, fingerprint };
    });
  }

  /**
   * Record one compressed error.
   *
   * @param {object} entry - `{savedTokens, provider?, model?, route?, tool?, fingerprint?, ...}`.
   * @returns {Promise<{ok: boolean, savedTokens?: number, route?: string, error?: string}>}
   */
  recordSavings(entry = {}) {
    return this._safe(async () => {
      await this._ensureLayout();
      const now = this._nowDate();
      const route = entry.route == null
        ? `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`
        : String(entry.route);
      const savedTokens = numberOrZero(entry.savedTokens);
      const value = {
        schema: 'dsh-failure-savings/1',
        time: toIso(entry.time, now),
        session: entry.session ?? null,
        tool: entry.tool ?? null,
        category: entry.category ?? null,
        fingerprint: entry.fingerprint ?? null,
        rawTokens: numberOrZero(entry.rawTokens),
        digestTokens: numberOrZero(entry.digestTokens),
        savedTokens,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        route,
        mode: entry.mode ?? null,
      };
      await this._appendJsonl(this.paths.savings, value);

      const totals = await this._readTotals();
      totals.compressions += 1;
      totals.savedTokens += savedTokens;
      totals.byRoute[route] ??= { failures: 0, savedTokens: 0 };
      totals.byRoute[route].savedTokens += savedTokens;
      if (entry.tool != null) {
        const tool = String(entry.tool);
        totals.byTool[tool] ??= { failures: 0, savedTokens: 0 };
        totals.byTool[tool].savedTokens += savedTokens;
      }
      await this._writeTotals(totals);
      await this._maybeEnforceSpace();

      return { savedTokens, route };
    });
  }

  /**
   * Record one anomaly hit.
   *
   * @param {object} entry - `{ruleId, count, wastedTokens, evidence, session?, time?}`.
   * @returns {Promise<{ok: boolean, ruleId?: string, error?: string}>}
   */
  recordAnomaly(entry = {}) {
    return this._safe(async () => {
      await this._ensureLayout();
      const ruleId = String(entry.ruleId ?? '').trim();
      if (!ruleId) throw new Error('recordAnomaly requires a ruleId');
      const now = this._nowDate();
      const count = Math.max(1, Math.floor(numberOrZero(entry.count) || 1));
      const wastedTokens = Math.max(0, Math.floor(numberOrZero(entry.wastedTokens)));
      const value = {
        schema: 'dsh-failure-anomaly/1',
        time: toIso(entry.time, now),
        ruleId,
        count,
        wastedTokens,
        session: entry.session ?? null,
        turn: entry.turn ?? null,
        evidence: entry.evidence ?? null,
      };
      await this._appendJsonl(this.paths.anomalies, value);

      const totals = await this._readTotals();
      totals.anomalies += 1;
      totals.anomalyWastedTokens += wastedTokens;
      totals.byRule[ruleId] = (totals.byRule[ruleId] ?? 0) + count;
      await this._writeTotals(totals);
      await this._maybeEnforceSpace();

      return { ruleId };
    });
  }

  /**
   * Read the monotonic totals after pending writes settle.
   *
   * @returns {Promise<{ok: true, totals: object}>}
   */
  async getTotals() {
    await this.flush();
    try {
      return { ok: true, totals: await this._readTotals() };
    } catch (error) {
      await this._logError(error);
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Read recent failure index entries (newest first).
   *
   * @param {{limit?: number, sessionId?: string|null, scope?: 'all'|'current'}} [options] - filter.
   * @returns {Promise<{ok: true, entries: object[]}>}
   */
  async listFailures(options = {}) {
    await this.flush();
    const entries = await this._readJsonl(this.paths.index);
    const playbook = await this._readJsonl(this.paths.playbook);
    const resolvedUntil = new Map();
    for (const row of playbook) {
      if (typeof row?.fingerprint !== 'string') continue;
      const at = Date.parse(row.resolvedAt ?? '');
      if (!Number.isFinite(at)) continue;
      const previous = resolvedUntil.get(row.fingerprint) ?? 0;
      if (at > previous) resolvedUntil.set(row.fingerprint, at);
    }
    const scope = options.scope === 'current' ? 'current' : 'all';
    const sessionId = options.sessionId == null ? null : String(options.sessionId);
    const limit = Math.max(0, Math.floor(numberOrZero(options.limit) || 10));
    const filtered = entries.filter((entry) => {
      const until = resolvedUntil.get(entry.fingerprint);
      if (until !== undefined && Date.parse(entry.time ?? '') <= until) return false;
      if (scope === 'current' && sessionId != null && entry.session !== sessionId) return false;
      return true;
    });
    return { ok: true, entries: filtered.slice(-limit).reverse() };
  }

  /**
   * Read recent anomaly entries (newest first).
   *
   * @param {{limit?: number}} [options] - limit.
   * @returns {Promise<{ok: true, entries: object[]}>}
   */
  async listAnomalies(options = {}) {
    await this.flush();
    const entries = await this._readJsonl(this.paths.anomalies);
    const limit = Math.max(0, Math.floor(numberOrZero(options.limit) || 20));
    return { ok: true, entries: entries.slice(-limit).reverse() };
  }

  /**
   * Read one aggregated report.
   *
   * @param {string} fingerprint - report fingerprint.
   * @returns {Promise<{ok: true, text: string|null, path: string}>}
   */
  async readReport(fingerprint) {
    await this.flush();
    const reportPath = this._reportPath(fingerprint);
    return { ok: true, text: await readTextOrNull(reportPath), path: reportPath };
  }

  /**
   * Find one failure index entry by id or fingerprint.
   *
   * @param {{id: string, scope?: 'all'|'current', sessionId?: string|null}} options - lookup.
   * @returns {Promise<{ok: true, entry: object|null, reportPath: string|null}>}
   */
  async findFailure(options = {}) {
    await this.flush();
    const entry = await this._findFailureNow(options);
    return {
      ok: true,
      entry,
      reportPath: entry == null ? null : path.join(this.root, entry.report),
    };
  }

  /**
   * Mark one failure fingerprint resolved, append the playbook, and delete its
   * detail files (report/raw). The index and totals stay untouched, so the
   * monotonic statistics do not decrease.
   *
   * @param {{id: string, fix: string, scope?: 'all'|'current', sessionId?: string|null}} options - resolution.
   * @returns {Promise<{ok: boolean, entry?: object, reportPath?: string, deleted?: string[], error?: string}>}
   */
  resolveFailure(options = {}) {
    return this._safe(async () => {
      await this._ensureLayout();
      const entry = await this._findFailureNow(options);
      if (entry == null) throw new Error(`failure not found: ${String(options.id ?? '')}`);
      const reportPath = path.join(this.root, entry.report);
      await this._appendJsonl(this.paths.playbook, {
        schema: 'dsh-failure-playbook/1',
        id: entry.id,
        fingerprint: entry.fingerprint,
        fix: String(options.fix ?? ''),
        resolvedAt: this._nowDate().toISOString(),
      });

      const deleted = [];
      const related = (await this._readJsonl(this.paths.index))
        .filter((row) => row?.fingerprint === entry.fingerprint);
      for (const row of related) {
        const rawPath = path.join(this.paths.raw, `${safeSegment(row.id, 'raw')}.txt`);
        try {
          await unlink(rawPath);
          deleted.push(rawPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      try {
        await unlink(reportPath);
        deleted.push(reportPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return { entry, reportPath, deleted };
    });
  }

  /**
   * Write the rendered INBOX entry.
   *
   * @param {string} markdown - rendered inbox.
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  writeInbox(markdown) {
    return this._safe(async () => {
      await this._ensureLayout();
      await this._writeAtomic(this.paths.inbox, String(markdown ?? ''));
      return { path: this.paths.inbox };
    });
  }

  /**
   * Write one session handoff.
   *
   * @param {string} sessionId - session identity.
   * @param {string} markdown - rendered handoff.
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  writeHandoff(sessionId, markdown) {
    return this._safe(async () => {
      await this._ensureLayout();
      const target = path.join(this.paths.handoffs, `${safeSegment(sessionId, 'session')}.md`);
      await this._writeAtomic(target, String(markdown ?? ''));
      return { path: target };
    });
  }

  /**
   * Append one playbook record.
   *
   * @param {object} entry - resolved fingerprint and fix.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  appendPlaybook(entry = {}) {
    return this._safe(async () => {
      await this._ensureLayout();
      await this._appendJsonl(this.paths.playbook, { schema: 'dsh-failure-playbook/1', ...entry });
      return {};
    });
  }

  /**
   * Write bounded raw error text.
   *
   * @param {string} id - failure id.
   * @param {unknown} text - raw text.
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  writeRaw(id, text) {
    return this._safe(async () => {
      await this._ensureLayout();
      const target = await this._writeRaw(id, text);
      return { path: target };
    });
  }

  /**
   * Append one plugin error line; rotates `_plugin.log` at the configured size.
   *
   * @param {unknown} error - error or message.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  recordPluginError(error) {
    return this._safe(async () => {
      await this._logError(error);
      return {};
    });
  }

  /**
   * Enforce the detail-size cap. Age-based cleanup is intentionally not part
   * of V1: only the 100 MB cap and the 200-write trigger are used.
   *
   * @param {{maxTotalBytes?: number}} [options] - size-cap override.
   * @returns {Promise<{ok: boolean, removed: string[], error?: string}>}
   */
  prune(options = {}) {
    return this._safe(async () => {
      await this._ensureLayout();
      const removed = await this._enforceSpaceLimit(
        positiveNumber(options.maxTotalBytes, this.maxTotalBytes),
      );
      return { removed };
    });
  }

  /**
   * Enforce the total size cap over detail files (reports/raw/handoffs).
   * Oldest files are removed first; ledger totals and index lines are never
   * rewritten, so cleanup cannot shrink the monotonic statistics.
   *
   * @param {number} [maxBytes] - total detail-byte cap.
   * @returns {Promise<string[]>} removed paths.
   */
  async _enforceSpaceLimit(maxBytes = this.maxTotalBytes) {
    const limit = positiveNumber(maxBytes, this.maxTotalBytes);
    const files = [];
    let total = 0;
    for (const directory of [this.paths.reports, this.paths.raw, this.paths.handoffs]) {
      for (const name of await readdirOrEmpty(directory)) {
        const target = path.join(directory, name);
        const info = await statOrNull(target);
        if (!info || !info.isFile()) continue;
        total += info.size;
        files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    if (total <= limit) return [];

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const removed = [];
    for (const file of files) {
      if (total <= limit) break;
      try {
        await unlink(file.path);
        total -= file.size;
        removed.push(file.path);
      } catch {
        // A concurrent prune or a locked file is skipped; next run retries.
      }
    }
    return removed;
  }

  async _maybeEnforceSpace() {
    this._spaceWrites += 1;
    if (this._spaceWrites < 200) return;
    this._spaceWrites = 0;
    await this._enforceSpaceLimit();
  }

  /** Wait for every queued write to settle. */
  async flush() {
    await this._tail;
  }

  /** Flush and refuse later writes. */
  async close() {
    await this.flush();
    this._closed = true;
  }

  // ---- internals -------------------------------------------------------

  _safe(operation) {
    return this._enqueue(async () => {
      try {
        const value = await operation();
        if (value && typeof value === 'object' && 'ok' in value) return value;
        return { ok: true, ...(value ?? {}) };
      } catch (error) {
        this._writeErrors += 1;
        await this._logError(error);
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  _enqueue(task) {
    if (this._closed) return Promise.resolve({ ok: false, error: 'store is closed' });
    const run = this._tail.then(task, task);
    this._tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async _ensureLayout() {
    await mkdir(this.paths.root, { recursive: true });
    await mkdir(this.paths.reports, { recursive: true });
    await mkdir(this.paths.raw, { recursive: true });
    await mkdir(this.paths.handoffs, { recursive: true });
    for (const file of JSONL_FILES) {
      await ensureFile(path.join(this.root, file));
    }
    if (!(await statOrNull(this.paths.totals))) {
      await this._writeTotals(this._defaultTotals());
    }
  }

  async _updateReport(entry) {
    const reportPath = this._reportPath(entry.fingerprint);
    const previous = parseFrontMatter(await readTextOrNull(reportPath));
    const increment = Math.max(1, Math.floor(numberOrZero(entry.count) || 1));
    const previousCount = numberOrZero(previous?.count);
    const previousRaw = numberOrZero(previous?.tokens_raw);
    const previousDigest = numberOrZero(previous?.tokens_digest);
    const tokensRaw = previousRaw + numberOrZero(entry.tokensRaw);
    const tokensDigest = previousDigest + numberOrZero(entry.tokensDigest);
    const now = this._nowDate();
    const status = deriveStatus(previous, now.getTime());

    const report = renderReport({
      id: previous?.id ?? entry.id,
      fingerprint: entry.fingerprint,
      status,
      severity: entry.severity ?? previous?.severity ?? 'medium',
      category: entry.category,
      created: previous?.created ?? entry.time,
      session: entry.session ?? previous?.session ?? null,
      parent: entry.parent ?? previous?.parent ?? null,
      agentKind: entry.agentKind ?? previous?.agentKind ?? 'root',
      tool: entry.tool,
      count: previousCount + increment,
      tokensRaw,
      tokensDigest,
      tokensSaved: Math.max(0, tokensRaw - tokensDigest),
      route: entry.route,
      task: entry.task ?? previous?.task,
      summary: entry.summary ?? `${entry.tool} failed · ${entry.category}`,
      error: entry.error ?? entry.detail ?? '',
      context: entry.context ?? '',
      advice: entry.advice ?? entry.hint ?? '',
      evidence: entry.evidence ?? `index.jsonl id=${entry.id}`,
      sessionHint: entry.sessionHint ?? '',
      fix: entry.fix ?? (previous?.status === 'resolved' ? '见 playbook.jsonl' : ''),
    });
    await this._writeAtomic(reportPath, report);
    return { count: previousCount + increment, reportPath };
  }

  _reportPath(fingerprint) {
    return path.join(this.paths.reports, `${safeSegment(fingerprint, 'unknown')}.md`);
  }

  async _findFailureNow(options = {}) {
    const wanted = String(options.id ?? '').trim();
    if (!wanted) return null;
    const scope = options.scope === 'current' ? 'current' : 'all';
    const sessionId = options.sessionId == null ? null : String(options.sessionId);
    if (scope === 'current' && sessionId == null) return null;
    const entries = await this._readJsonl(this.paths.index);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.id !== wanted && entry.fingerprint !== wanted) continue;
      if (scope === 'current' && entry.session !== sessionId) continue;
      return entry;
    }
    return null;
  }

  async _writeRaw(id, text) {
    const target = path.join(this.paths.raw, `${safeSegment(id, 'raw')}.txt`);
    const bounded = truncateMiddle(text, this.rawMaxBytes);
    await this._writeAtomic(target, bounded);
    return target;
  }

  async _writeAtomic(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${++this._tmpCounter}`;
    await writeFile(temp, String(content), 'utf8');
    try {
      await rename(temp, filePath);
    } catch (error) {
      if (error && ['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
        await rm(filePath, { force: true });
        await rename(temp, filePath);
      } else {
        await rm(temp, { force: true });
        throw error;
      }
    }
  }

  async _appendJsonl(filePath, value) {
    await this._appendLine(filePath, `${JSON.stringify(value)}\n`);
  }

  async _appendLine(filePath, line, maxBytes = this.maxBytes) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const info = await statOrNull(filePath);
    if (info && info.size + Buffer.byteLength(line, 'utf8') > maxBytes) {
      const rotated = `${filePath}.${safeStamp(this._nowDate())}-${++this._tmpCounter}.bak`;
      await rename(filePath, rotated);
    }
    await appendFile(filePath, line, 'utf8');
  }

  async _readJsonl(filePath) {
    const text = await readTextOrNull(filePath);
    if (!text) return [];
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A corrupt line is skipped; the plugin log records the file error.
      }
    }
    return entries;
  }

  async _readTotals() {
    const text = await readTextOrNull(this.paths.totals);
    if (!text) return this._defaultTotals();
    try {
      return normalizeTotals(JSON.parse(text), this.currency, this._nowDate());
    } catch (error) {
      await this._logError(error);
      return this._defaultTotals();
    }
  }

  async _writeTotals(totals) {
    const next = {
      ...totals,
      schema: 'dsh-failure-totals/1',
      updated: this._nowDate().toISOString(),
      currency: this.currency,
    };
    await this._writeAtomic(this.paths.totals, `${JSON.stringify(next, null, 2)}\n`);
  }

  _defaultTotals() {
    return {
      schema: 'dsh-failure-totals/1',
      since: this._nowDate().toISOString(),
      updated: this._nowDate().toISOString(),
      currency: this.currency,
      failures: 0,
      compressions: 0,
      anomalies: 0,
      savedTokens: 0,
      anomalyWastedTokens: 0,
      byRoute: {},
      byTool: {},
      byCategory: {},
      bySession: {},
      byRule: {},
    };
  }

  async _logError(error) {
    try {
      await mkdir(this.paths.root, { recursive: true });
      const line = `${JSON.stringify({
        time: this._nowDate().toISOString(),
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack ?? null : null,
      })}\n`;
      await this._appendLine(this.paths.log, line, this.logMaxBytes);
    } catch {
      // Logging must never throw into the caller.
    }
  }

  _nowDate() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
}

/**
 * Parse the simple YAML-ish front matter emitted by `renderReport`.
 *
 * @param {string|null} text - report text.
 * @returns {Record<string, unknown>|null} parsed keys.
 */
export function parseFrontMatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const separator = line.indexOf(': ');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 2).trim();
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  }
  return data;
}

function normalizeTotals(raw, currency, now) {
  const base = {
    schema: 'dsh-failure-totals/1',
    since: now.toISOString(),
    updated: now.toISOString(),
    currency,
    failures: 0,
    compressions: 0,
    anomalies: 0,
    savedTokens: 0,
    anomalyWastedTokens: 0,
    byRoute: {},
    byTool: {},
    byCategory: {},
    bySession: {},
    byRule: {},
  };
  if (!raw || typeof raw !== 'object') return base;
  const totals = {
    ...base,
    ...raw,
    since: typeof raw.since === 'string' ? raw.since : base.since,
    currency: typeof raw.currency === 'string' ? raw.currency : currency,
  };
  for (const key of ['failures', 'compressions', 'anomalies', 'savedTokens', 'anomalyWastedTokens']) {
    totals[key] = Math.max(0, numberOrZero(raw[key]));
  }
  totals.byRoute = normalizeBuckets(raw.byRoute, ['failures', 'savedTokens']);
  totals.byTool = normalizeBuckets(raw.byTool, ['failures', 'savedTokens']);
  totals.byCategory = normalizeCounts(raw.byCategory);
  totals.bySession = normalizeCounts(raw.bySession);
  totals.byRule = normalizeCounts(raw.byRule);
  return totals;
}

function normalizeBuckets(value, keys) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [name, bucket] of Object.entries(value)) {
    if (!bucket || typeof bucket !== 'object') continue;
    out[name] = {};
    for (const key of keys) out[name][key] = Math.max(0, numberOrZero(bucket[key]));
  }
  return out;
}

function normalizeCounts(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, count] of Object.entries(value)) out[key] = Math.max(0, numberOrZero(count));
  return out;
}

function deriveStatus(previous, nowMs) {
  const status = typeof previous?.status === 'string' ? previous.status : 'new';
  if (status !== 'resolved') return status;
  const created = Date.parse(previous?.created ?? '');
  if (Number.isFinite(created) && nowMs - created <= 7 * 86_400_000) return 'reopened';
  return 'new';
}

function markResolved(text, fix) {
  const cleanFix = String(fix ?? '').trim() || '—';
  const updated = text.replace(/^status: .*$/m, 'status: "resolved"');
  const marker = '## 修复记录';
  const start = updated.indexOf(marker);
  if (start < 0) return `${updated.trimEnd()}\n\n${marker}\n\n${cleanFix}\n`;
  const bodyStart = updated.indexOf('\n\n', start);
  if (bodyStart < 0) return `${updated.trimEnd()}\n\n${cleanFix}\n`;
  const contentStart = bodyStart + 2;
  const nextHeading = updated.indexOf('\n## ', contentStart);
  const contentEnd = nextHeading < 0 ? updated.length : nextHeading;
  return `${updated.slice(0, contentStart)}${cleanFix}\n${updated.slice(contentEnd)}`;
}

async function ensureFile(filePath) {
  if (await statOrNull(filePath)) return;
  try {
    await writeFile(filePath, '', { flag: 'wx' });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
}

async function readTextOrNull(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readdirOrEmpty(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function toIso(value, fallbackDate) {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined && value !== null) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallbackDate.toISOString();
}

function compactTime(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function safeStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeSegment(value, fallback = 'unknown') {
  const segment = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 120);
  return segment || fallback;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
