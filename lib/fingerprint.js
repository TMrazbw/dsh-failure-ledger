/**
 * Stable failure fingerprints.
 *
 * A fingerprint must group the *same* failure across retries, sessions, and
 * machines while ignoring volatile text such as paths, GUIDs, timestamps, and
 * numeric ids. The hash is truncated to 12 hex characters for file names.
 */

import { createHash } from 'node:crypto';

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Normalize one error message for fingerprinting.
 *
 * @param {unknown} input - raw error text (or an error-like value).
 * @param {{maxChars?: number}} [options] - optional bound before hashing.
 * @returns {string} normalized, lowercased text.
 */
export function normalizeErrorText(input, options = {}) {
  let text = String(input ?? '');
  text = text.replace(ANSI, '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '<url>');
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<guid>');
  text = text.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>');
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
  text = text.replace(/\b[A-Za-z]:[\\/][^\s"'<>,;)]*/g, '<path>');
  text = text.replace(/\\\\[^\s"'<>,;)]+/g, '<path>');
  text = text.replace(/(^|[\s"'(=])\/(?:[^\s"'<>,;:)]+\/)+[^\s"'<>,;:)]*/g, '$1<path>');
  text = text.replace(/\b\d{3,}\b/g, '<n>');
  text = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : 4000;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Compute the ledger fingerprint.
 *
 * @param {{tool?: string, toolName?: string, category?: string, code?: string|null, message?: string, text?: string, options?: {maxChars?: number}}} input - failure identity fields.
 * @returns {string} 12-character lowercase hex digest.
 */
export function fingerprint(input = {}) {
  const tool = normalizeKey(input.tool ?? input.toolName);
  const category = normalizeKey(input.category);
  const code = normalizeKey(input.code);
  const message = normalizeErrorText(input.message ?? input.text ?? '', input.options);
  const material = [tool, category, code, message].join('\u0000');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function normalizeKey(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}
