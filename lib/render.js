/**
 * Bounded, pure text renderers for the model-visible digest, durable report,
 * and INBOX entry. No I/O and no locale lookup: UI labels are supplied by the
 * Client layer, while these functions keep the on-disk contract stable.
 */

export const REPORT_SCHEMA = 'dsh-failure/1';
export const REPORT_MAX_CHARS = 4096;

/**
 * Normalize line endings and remove control characters that could corrupt a
 * terminal or a markdown report.
 *
 * @param {unknown} input - raw text.
 * @returns {string} cleaned text.
 */
export function cleanText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

/**
 * Keep the head and tail of a long string, with a middle ellipsis.
 *
 * @param {unknown} input - raw text.
 * @param {number} [maxChars] - maximum output length.
 * @returns {string} truncated text.
 */
export function truncateMiddle(input, maxChars = 240) {
  const value = cleanText(input);
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 240;
  if (value.length <= limit) return value;
  if (limit === 0) return '';
  if (limit === 1) return '…';
  const content = limit - 1;
  const head = Math.ceil(content / 2);
  const tail = Math.floor(content / 2);
  if (tail === 0) return `${value.slice(0, content)}…`;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/**
 * Compact human token counts (1.8k / 1.2M) for the digest and INBOX.
 *
 * @param {unknown} input - token count.
 * @returns {string} compact count.
 */
export function formatTokens(input) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${round1(value / 1_000_000)}M`;
  if (value >= 1_000) return `${round1(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * Render the model-visible digest for one compressed error.
 *
 * @param {{toolName?: string, tool?: string, category?: string, detail?: string, hint?: string, reportPath?: string}} fields - digest fields.
 * @param {{maxDetailChars?: number}} [options] - bound for the detail line.
 * @returns {string} digest text.
 */
export function renderDigest(fields = {}, options = {}) {
  const toolName = cleanText(fields.toolName ?? fields.tool ?? 'tool') || 'tool';
  const category = (cleanText(fields.category ?? 'unknown') || 'unknown').toUpperCase();
  const lines = [`[dsh-failure-ledger] ${toolName} failed · ${category}`];

  const hint = cleanText(fields.hint);
  if (hint) lines.push(hint);

  const detail = truncateMiddle(fields.detail, options.maxDetailChars ?? 200).replace(/\s+/g, ' ').trim();
  if (detail) lines.push(`Detail: ${detail}`);

  const rawTokens = Number(fields.rawTokens);
  const digestTokens = Number(fields.digestTokens);
  const savedTokens = Number(fields.savedTokens);
  if (Number.isFinite(rawTokens) && Number.isFinite(digestTokens) && Number.isFinite(savedTokens) && savedTokens > 0) {
    lines.push(`Tokens: ${Math.round(rawTokens)} raw · ${Math.round(digestTokens)} digest · ${Math.round(savedTokens)} saved`);
  }

  const reportPath = cleanText(fields.reportPath);
  if (reportPath) lines.push(`Report: ${reportPath}`);

  return lines.join('\n');
}

/**
 * Render one durable failure report (front matter + Chinese body).
 *
 * @param {object} fields - report fields; see PROJECT.md §2.6.
 * @param {{maxChars?: number, maxErrorChars?: number}} [options] - output bounds.
 * @returns {string} markdown report.
 */
export function renderReport(fields = {}, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(256, Math.floor(options.maxChars)) : REPORT_MAX_CHARS;
  const maxErrorChars = Number.isFinite(options.maxErrorChars) ? Math.max(64, Math.floor(options.maxErrorChars)) : 2400;
  const rawTokens = numberOrZero(fields.tokensRaw);
  const digestTokens = numberOrZero(fields.tokensDigest);
  const savedTokens = numberOrZero(fields.tokensSaved ?? Math.max(0, rawTokens - digestTokens));
  const id = cleanText(fields.id) || 'F-unknown';
  const fingerprint = cleanText(fields.fingerprint) || 'unknown';
  const created = fields.created instanceof Date ? fields.created.toISOString() : cleanText(fields.created) || new Date(0).toISOString();

  const front = [
    '---',
    `schema: ${REPORT_SCHEMA}`,
    `id: ${yamlValue(id)}`,
    `fingerprint: ${yamlValue(fingerprint)}`,
    `status: ${yamlValue(fields.status ?? 'new')}`,
    `severity: ${yamlValue(fields.severity ?? 'medium')}`,
    `category: ${yamlValue(fields.category ?? 'unknown')}`,
    `created: ${yamlValue(created)}`,
    `session: ${yamlValue(fields.session ?? null)}`,
    `parent: ${yamlValue(fields.parent ?? null)}`,
    `agentKind: ${yamlValue(fields.agentKind ?? 'root')}`,
    `tool: ${yamlValue(fields.tool ?? null)}`,
    `count: ${Math.max(1, Math.floor(numberOrZero(fields.count) || 1))}`,
    `tokens_raw: ${rawTokens}`,
    `tokens_digest: ${digestTokens}`,
    `tokens_saved: ${savedTokens}`,
    `route: ${yamlValue(fields.route ?? null)}`,
    '---',
  ].join('\n');

  const sections = [
    ['任务', plainSection(fields.task)],
    ['发生了什么', plainSection(fields.summary)],
    ['错误', codeSection(fields.error, maxErrorChars)],
    ['上下文', plainSection(fields.context)],
    ['判断与建议', plainSection(fields.advice)],
    ['证据', codeSection(fields.evidence, Math.min(maxErrorChars, 1200))],
    ['优化会话提示', plainSection(fields.sessionHint)],
    ['修复记录', plainSection(fields.fix)],
  ];

  const body = sections.map(([title, content]) => `## ${title}\n\n${content}`).join('\n\n');
  const report = `${front}\n\n# 失败报告 · ${id}\n\n${body}\n`;
  if (report.length <= maxChars) return report;
  return `${report.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n…(report truncated)\n`;
}

/**
 * Render the shared INBOX entry (bounded to `limit` rows).
 *
 * @param {{rows?: object[], newCount?: number, total?: number, savedTokens?: number, handoffPath?: string, limit?: number}} fields - inbox fields.
 * @returns {string} markdown inbox.
 */
export function renderInbox(fields = {}) {
  const limit = Number.isFinite(fields.limit) ? Math.max(0, Math.floor(fields.limit)) : 20;
  const rows = Array.isArray(fields.rows) ? fields.rows.slice(0, limit) : [];
  const total = Number.isFinite(fields.total) ? fields.total : rows.length;
  const newCount = Number.isFinite(fields.newCount) ? fields.newCount : 0;
  const savedTokens = Number.isFinite(fields.savedTokens) ? fields.savedTokens : 0;
  const lines = [`# Failure Inbox — ${newCount} new, ${total} total, est. ${formatTokens(savedTokens)} tokens saved`, ''];

  if (rows.length === 0) {
    lines.push('No failures recorded.', '');
  } else {
    lines.push('| id | sev | tool | category | count | last | report |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of rows) {
      lines.push(
        `| ${cell(row.id)} | ${cell(row.severity)} | ${cell(row.tool)} | ${cell(row.category)} | ${cell(row.count)} | ${cell(row.last)} | ${cell(row.report)} |`,
      );
    }
    lines.push('');
  }

  if (fields.handoffPath) lines.push(`Handoffs: ${cleanText(fields.handoffPath)}`);
  lines.push('Use: `read <report>` or `failure_inbox show id=...`');
  return lines.join('\n');
}

function plainSection(value) {
  const text = cleanText(value);
  return text || '—';
}

function codeSection(value, maxChars) {
  const text = truncateMiddle(value, maxChars);
  if (!text) return '```text\n—\n```';
  return `\`\`\`text\n${text.replace(/```/g, '` ` `')}\n\`\`\``;
}

function yamlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function cell(value) {
  const text = cleanText(value);
  return (text || '—').replace(/\|/g, '\\|');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
