/**
 * DFL — conservative assistant claim detection.
 *
 * This only recognizes short positive completion claims. It deliberately
 * ignores questions, negations, and code blocks; the caller still records the
 * claim as an anomaly only, never as a tool decision.
 */

const POSITIVE_CJK = [
  /已完成|已经完成|已修复|修好了|已通过|已解决|搞定了|已处理/i,
];

const POSITIVE_EN = [
  /\b(all tests pass|tests pass|done|fixed|passed|resolved|completed)\b/i,
];

const NEGATIVE = [
  /未完成|没有完成|还没|尚未|未通过|未修复|无法|不能|失败|待验证|不确认/i,
  /\b(not done|not fixed|not passed|not complete|not resolved|incomplete|cannot|can't|unable|will|plan to|pending)\b/i,
];

const INTERNAL_NOTICE_PREFIXES = [
  /^\[dsh-failure-ledger\]/i,
];

const INJECTED_PREFIXES = [
  /^Time sampled while preparing turn/i,
  /^Browser time zone for this request/i,
  /^Elapsed since the preceding model-visible message/i,
  /^Current runtime context/i,
  /^Current working directory/i,
  /^Current DSH file policy/i,
  /^Approval policy/i,
  /^Current DeepSeek Harness implementation checkout/i,
  /^Current DeepSeek Harness Web GUI URL/i,
  /^You are the Team Lead named/i,
  /^Use list_agents\(/i,
  /^To message another teammate/i,
  /^<available_skills>/i,
  /^<\/available_skills>/i,
  /^<system-reminder>/i,
  /^<\/system-reminder>/i,
];

/**
 * Remove runner-injected context from a user message before using it as a goal.
 *
 * @param {unknown} value - user message text.
 * @returns {string} filtered text.
 */
export function stripInjectedContext(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.find((line) => line.trim());
  if (first && INTERNAL_NOTICE_PREFIXES.some((pattern) => pattern.test(first.trim()))) return '';
  const kept = [];
  let inSkills = false;
  let inReminder = false;
  for (const line of lines) {
    if (inReminder) {
      if (/^<\/system-reminder>/i.test(line.trim())) inReminder = false;
      continue;
    }
    if (/^<system-reminder>/i.test(line.trim())) {
      inReminder = true;
      continue;
    }
    if (/^<available_skills>/i.test(line)) {
      inSkills = true;
      continue;
    }
    if (/^<\/available_skills>/i.test(line)) {
      inSkills = false;
      continue;
    }
    if (inSkills) continue;
    if (INJECTED_PREFIXES.some((pattern) => pattern.test(line))) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

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
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[“「『][^”」』]*[”」』]/g, ' ');
  const sentences = withoutCode.split(/[。！？!?\n]+/).map((line) => line.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/[?？]\s*$/.test(sentence)) continue;
    if (NEGATIVE.some((pattern) => pattern.test(sentence))) continue;
    // English keywords are only trusted in English sentences: in Chinese text
    // they are usually identifiers or section names ("Goal", "Done").
    const positives = /[\u3400-\u9fff]/.test(sentence) ? POSITIVE_CJK : POSITIVE_EN;
    if (positives.some((pattern) => pattern.test(sentence))) {
      return { claim: true, text: sentence.slice(0, 160) };
    }
  }
  return { claim: false, text: '' };
}
