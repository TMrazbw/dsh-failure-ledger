/**
 * Pure error classification for the failure ledger.
 *
 * The classifier is intentionally local and deterministic: no I/O, no model
 * call, no locale service. It turns one failed tool/model outcome into a
 * stable category, severity, retry guidance, and a short English hint that can
 * be shown to the model.
 */

export const CLASSIFIER_VERSION = 1;

/**
 * Rule table. Order matters: the first matching rule wins.
 * `retryable` is `false`, `'once'`, or `true`.
 */
const RULES = [
  {
    id: 'shell-runtime',
    category: 'shell-runtime',
    severity: 'high',
    retryable: false,
    pattern: /3221225794|0xc0000142|c0000142|dll init(ialization)? failed|status_dll_init_failed|进程.*(初始化|启动).*失败/i,
    hint: 'The shell process failed to initialize (0xC0000142). Do not retry the same command; restart DSH/Windows session and use read/glob instead.',
  },
  {
    id: 'unknown-tool',
    category: 'unknown-tool',
    severity: 'medium',
    retryable: false,
    pattern: /unknown tool|UNKNOWN_TOOL/i,
    hint: 'That tool does not exist in this session. Use only tools present in the current schema (for example read, glob, grep, failure_inbox); do not retry the invented tool name.',
  },
  {
    id: 'dependency-missing',
    category: 'dependency-missing',
    severity: 'medium',
    retryable: false,
    pattern: /modulenotfounderror|no module named|zstd not found/i,
    hint: 'A required runtime dependency is missing. Install it or use the bundled tool; do not retry the same unchanged command.',
  },
  {
    id: 'human-verification',
    category: 'human-verification',
    severity: 'high',
    retryable: false,
    pattern: /captcha|challenge|cloudflare|turnstile|hcaptcha|recaptcha|human verification|just a moment|验证码|人机验证/i,
    hint: 'Stop automated actions and ask the user to complete the verification in the browser window; re-check with browser_snapshot before continuing.',
  },
  {
    id: 'aborted',
    category: 'aborted',
    severity: 'low',
    retryable: 'once',
    pattern: /aborted_before_dispatch|tool_not_started|tool_outcome_unknown|aborted before dispatch|outcome is unknown|interrupted before the harness recorded|已中止|中止/i,
    hint: 'The call was cancelled before it completed. Retry only if it is still needed, and check external state first when side effects are possible.',
  },
  {
    id: 'sandbox-denied',
    category: 'sandbox-denied',
    severity: 'high',
    retryable: false,
    pattern: /sandbox:?|file access denied|eperm|eacces|permission denied|access is denied|grantwrite|write access denied|沙箱|权限被拒绝/i,
    hint: 'The target is outside the workspace or lacks permission; the same call will fail again. Write inside the workspace, or ask the user to widen access.',
  },
  {
    id: 'stale-write',
    category: 'stale-write',
    severity: 'medium',
    retryable: true,
    pattern: /fs_stale_version|stale (version|write|file)|file changed since it was read|版本已过期|文件已变更/i,
    hint: 'Read the file again, rebase the change on the new content, then edit; do not retry the same stale write.',
  },
  {
    id: 'context-overflow',
    category: 'context-overflow',
    severity: 'high',
    retryable: false,
    pattern: /context (length|window)|maximum context|too many tokens|context overflow|max(imum)? tokens? (exceeded|limit)|超过.*上下文/i,
    hint: 'Compact the conversation or read in smaller chunks before adding more context; retrying unchanged will fail again.',
  },
  {
    id: 'rate-limit',
    category: 'rate-limit',
    severity: 'medium',
    retryable: true,
    pattern: /\b429\b|rate limit|too many requests|retry after/i,
    hint: 'Back off and respect the provider retry delay; do not retry immediately or in a tight loop.',
  },
  {
    id: 'auth',
    category: 'auth',
    severity: 'high',
    retryable: false,
    pattern: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication (failed|required)|not authenticated|凭据|未授权/i,
    hint: 'Fix the credentials or ask the user to sign in; do not retry the same unauthenticated call.',
  },
  {
    id: 'missing-command',
    category: 'missing-command',
    severity: 'medium',
    retryable: false,
    pattern: /not recognized|command not found|is not recognized as|unable to find (the )?(command|executable)|无法将.*识别为|找不到命令/i,
    hint: 'Check PATH or use an absolute executable path; do not repeat the same missing command.',
  },
  {
    id: 'edit-target',
    category: 'edit-target',
    severity: 'medium',
    retryable: false,
    pattern: /fs_not_observed|fs_edit_not_found|fs_ambiguous_edit|read.*before.*edit|old_string.*not found|ambiguous edit/i,
    hint: 'Read the current file before editing, use an exact unique old_string, and re-read after a stale or write conflict.',
  },
  {
    id: 'search-failed',
    category: 'search-failed',
    severity: 'low',
    retryable: 'once',
    pattern: /search_failed|search failed|ripgrep.*(failed|not found)|grep.*failed/i,
    hint: 'Use read/glob on workspace files; native search tools cannot read app.asar paths.',
  },
  {
    id: 'not-found',
    category: 'not-found',
    severity: 'medium',
    retryable: 'once',
    pattern: /enoent|no such file|cannot find (the )?(path|file)|does not exist|not found|找不到(路径|文件)|不存在/i,
    hint: 'Confirm the path, case, and separators with glob/list first; for app.asar use the read tool rather than a shell.',
  },
  {
    id: 'timeout',
    category: 'timeout',
    severity: 'medium',
    retryable: 'once',
    pattern: /timed out|timeout|etimedout|deadline exceeded|超时/i,
    hint: 'Narrow the scope, run it as a background job, or reduce output before retrying once.',
  },
  {
    id: 'tool-contract',
    category: 'tool-contract',
    severity: 'medium',
    retryable: false,
    pattern: /invalid argument|invalid params|schema validation|validation (error|failed)|unexpected argument|missing required|required property|must be (a|an|of type|one of)|参数(错误|无效)|缺少(参数|必填)/i,
    hint: 'Fix the arguments to match the tool schema, including required fields and types.',
  },
  {
    id: 'shell-syntax',
    category: 'shell-syntax',
    severity: 'medium',
    retryable: false,
    pattern: /parse error|parsererror|syntax error|unexpected token|missing closing|missing terminator|here-string|unmatched (quote|parenthesis)|引号|语法错误|命令语法/i,
    hint: 'Use single quotes or a here-string, set UTF-8, and avoid nested quotes before retrying.',
  },
];

const FALLBACK = {
  id: 'unknown',
  category: 'unknown',
  severity: 'medium',
  retryable: 'once',
  hint: 'Inspect the error before retrying; do not repeat the same call unchanged.',
};

/** Stable list of categories, for UI labels and tests. */
export const CATEGORIES = Object.freeze([
  ...new Set([...RULES.map((rule) => rule.category), FALLBACK.category]),
]);

const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

/**
 * Flatten an error-like value into searchable text.
 *
 * Accepts the shapes produced by the tool pipeline (`error.message`,
 * `error.info.code`, `content` blocks), an `Error`, or a plain message.
 *
 * @param {object} input - failure fields.
 * @returns {string} newline-joined text used by the matcher only.
 */
export function errorTextOf(input = {}) {
  const parts = [];
  collectText(input.message, parts);
  collectText(input.code, parts);
  if (input.status !== undefined && input.status !== null) collectText(input.status, parts);
  collectText(input.error, parts);
  collectText(input.content, parts);
  return parts.join('\n');
}

/**
 * Classify one failed outcome.
 *
 * @param {object} input - `{ message, code, status, error, content }`.
 * @returns {{category: string, severity: 'low'|'medium'|'high', retryable: boolean|'once', hint: string, code: string|null, ruleId: string, version: number}}
 */
export function classifyError(input = {}) {
  const status = Number(input.status ?? input.error?.status);
  const code = extractCode(input);

  if (status === 429) return makeResult(RULES_BY_ID.get('rate-limit'), code);
  if (status === 401 || status === 403) return makeResult(RULES_BY_ID.get('auth'), code);

  if (code === 'FS_NOT_FOUND' || code === 'ENOENT') {
    return makeResult(RULES_BY_ID.get('not-found'), code);
  }
  if (code === 'FS_EDIT_NOT_FOUND' || code === 'FS_NOT_OBSERVED' || code === 'FS_AMBIGUOUS_EDIT') {
    return makeResult(RULES_BY_ID.get('edit-target'), code);
  }
  if (code === 'SEARCH_FAILED') {
    return makeResult(RULES_BY_ID.get('search-failed'), code);
  }

  const text = errorTextOf(input);
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return makeResult(rule, code);
  }
  return makeResult(FALLBACK, code);
}

/**
 * Return a category's default severity/hint without matching text.
 * Used by the UI when rendering stored reports.
 *
 * @param {string} category - category key.
 * @returns {{category: string, severity: string, retryable: boolean|'once', hint: string}|null}
 */
export function describeCategory(category) {
  const rule = RULES.find((candidate) => candidate.category === category) ?? FALLBACK;
  return {
    category: rule.category,
    severity: rule.severity,
    retryable: rule.retryable,
    hint: rule.hint,
  };
}

function makeResult(rule, code) {
  const source = rule ?? FALLBACK;
  return {
    category: source.category,
    severity: source.severity,
    retryable: source.retryable,
    hint: source.hint,
    code: code == null ? null : String(code),
    ruleId: source.id,
    version: CLASSIFIER_VERSION,
  };
}

function extractCode(input) {
  const value = input.code ?? input.error?.code ?? input.error?.info?.code;
  return value == null ? null : String(value);
}

function collectText(value, out) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, out);
    return;
  }
  if (typeof value === 'object') {
    for (const key of ['message', 'reason', 'name', 'code', 'stack', 'text']) {
      collectText(value[key], out);
    }
    if (value.info && typeof value.info === 'object') {
      collectText(value.info.code, out);
      collectText(value.info.name, out);
      collectText(value.info.reason, out);
    }
    if (value.content) collectText(value.content, out);
  }
}
