/**
 * DFL — conservative assistant claim detection.
 *
 * This only recognizes short positive completion claims. It deliberately
 * ignores questions, negations, and code blocks; the caller still records the
 * claim as an anomaly only, never as a tool decision.
 */

const POSITIVE = [
  /已完成|已经完成|已修复|修好了|已通过|已解决|搞定了|已处理/i,
  /\b(all tests pass|tests pass|done|fixed|passed|resolved|completed)\b/i,
];

const NEGATIVE = [
  /未完成|没有完成|还没|尚未|未通过|未修复|无法|不能|失败|待验证|不确认/i,
  /\b(not done|not fixed|not passed|not complete|not resolved|incomplete|cannot|can't|unable|will|plan to|pending)\b/i,
];

/**
 * Extract text blocks from an assistant message.
 *
 * @param {object} message - DSH assistant message.
 * @returns {string} joined text.
 */
export function extractAssistantText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Detect one positive completion claim.
 *
 * @param {unknown} value - assistant text.
 * @returns {{claim: boolean, text: string}} result.
 */
export function detectClaim(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) return { claim: false, text: '' };
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const sentences = withoutCode.split(/[。！？!?\n]+/).map((line) => line.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/[?？]\s*$/.test(sentence)) continue;
    if (NEGATIVE.some((pattern) => pattern.test(sentence))) continue;
    if (POSITIVE.some((pattern) => pattern.test(sentence))) {
      return { claim: true, text: sentence.slice(0, 160) };
    }
  }
  return { claim: false, text: '' };
}
