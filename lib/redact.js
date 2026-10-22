/**
 * Local secret redaction for reports, digests, and logs.
 *
 * Redaction happens before data leaves the in-memory event path. It is
 * intentionally local and deterministic: no model call, no network, no
 * external service. Patterns cover authorization headers, common API-token
 * prefixes, JWTs, key/value secrets, user-home paths, and email addresses.
 */

const RULES = [
  {
    id: 'authorization',
    pattern: /(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;"']+/gi,
    replacement: '$1: [REDACTED]',
  },
  {
    id: 'bearer',
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    id: 'token-prefix',
    pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    id: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    id: 'aws-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    id: 'key-value',
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|cookie)\b(\s*[:=]\s*)(["']?)[^\s"'`,;]{4,}\3/gi,
    replacement: '$1$2[REDACTED]',
  },
  {
    id: 'windows-user-path',
    pattern: /([A-Za-z]:\\Users\\)[^\\\s"']+/gi,
    replacement: '$1<user>',
  },
  {
    id: 'posix-user-path',
    pattern: /(\/(?:home|Users)\/)[^/\s"']+/g,
    replacement: '$1<user>',
  },
  {
    id: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '<email>',
  },
];

/**
 * Redact secrets from one text value.
 *
 * @param {unknown} input - raw text.
 * @param {{disabled?: string[], redactEmails?: boolean, redactUserPaths?: boolean}} [options] - pattern switches.
 * @returns {string} redacted text.
 */
export function redact(input, options = {}) {
  return redactWithStats(input, options).text;
}

/**
 * Redact secrets and report how many replacements each pattern made.
 *
 * @param {unknown} input - raw text.
 * @param {{disabled?: string[], redactEmails?: boolean, redactUserPaths?: boolean}} [options] - pattern switches.
 * @returns {{text: string, counts: Record<string, number>, total: number}}
 */
export function redactWithStats(input, options = {}) {
  const disabled = new Set(Array.isArray(options.disabled) ? options.disabled : []);
  let text = String(input ?? '');
  const counts = {};
  let total = 0;

  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    if (rule.id === 'email' && options.redactEmails === false) continue;
    if ((rule.id === 'windows-user-path' || rule.id === 'posix-user-path') && options.redactUserPaths === false) continue;

    const matches = text.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    counts[rule.id] = (counts[rule.id] ?? 0) + matches.length;
    total += matches.length;
    text = text.replace(rule.pattern, rule.replacement);
  }

  return { text, counts, total };
}

/** Stable list of redaction pattern ids, for diagnostics. */
export const REDACTION_RULES = Object.freeze(RULES.map((rule) => rule.id));
