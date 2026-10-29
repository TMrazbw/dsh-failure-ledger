/**
 * `tools/post-execute` integration: classify a failed tool outcome, compress
 * large text errors into a bounded digest, persist the failure/savings, and
 * attach a short hint when the original content must stay unchanged.
 *
 * The handler is deliberately independent from DSH imports so its behavior can
 * be tested with plain objects. `index.js` owns the Cordis wiring.
 */

import { randomUUID } from 'node:crypto';

import { classifyError } from './classify.js';
import { fingerprint } from './fingerprint.js';
import { redact } from './redact.js';
import { renderDigest, truncateMiddle } from './render.js';
import { estimateTokens } from './savings.js';

export const DEFAULT_DIGEST_CONFIG = Object.freeze({
  enabled: true,
  maxInlineTokens: 250,
  maxDetailChars: 200,
});

const SEEN_LIMIT = 2000;
const CONTEXT_SUMMARY_MAX = 120;

/**
 * Build the post-execute listener.
 *
 * @param {{store?: object|null, config?: object, createMessage?: Function, onError?: Function, onGuardHit?: Function, onUnresolved?: Function, onFailurePersisted?: Function, onToolResult?: Function}} [options] - handler options.
 * @returns {{listener: Function, config: object, stats: object, reset: Function}} handler.
 */
export function createDigestHandler(options = {}) {
  const config = { ...DEFAULT_DIGEST_CONFIG, ...(options.config ?? {}) };
  const store = options.store ?? null;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onPersisted = typeof options.onPersisted === 'function' ? options.onPersisted : null;
  const onGuardHit = typeof options.onGuardHit === 'function' ? options.onGuardHit : null;
  const onUnresolved = typeof options.onUnresolved === 'function' ? options.onUnresolved : null;
  const onFailurePersisted = typeof options.onFailurePersisted === 'function' ? options.onFailurePersisted : null;
  const onToolResult = typeof options.onToolResult === 'function' ? options.onToolResult : null;
  const createMessage = typeof options.createMessage === 'function' ? options.createMessage : defaultContextMessage;
  const seen = new Set();
  const stats = { failures: 0, compressed: 0, hints: 0, skipped: 0, duplicate: 0, savingsTokens: 0 };
  let firstPersist = true;

  async function listener(exec, result, next) {
    const decision = await next();
    try {
      if (onToolResult != null) {
        await onToolResult(exec, result, decision);
      }
      return await handle(exec, result, decision);
    } catch (error) {
      onError(error);
      return decision;
    }
  }

  async function handle(exec, result, decision) {
    if (!isToolFailure(exec, result)) {
      stats.skipped += 1;
      return decision;
    }
    if (decision?.kind === 'block' || decision?.kind !== 'accept') {
      stats.skipped += 1;
      return decision;
    }

    const key = exec?.callId == null ? null : String(exec.callId);
    if (key) {
      if (seen.has(key)) {
        stats.duplicate += 1;
        return decision;
      }
      seen.add(key);
      if (seen.size > SEEN_LIMIT) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    }

    const blocks = Array.isArray(result.content) ? result.content : [];
    const hasMedia = blocks.some((block) => block?.type === 'image' || block?.type === 'file');
    const contentText = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const errorMessage = result.error?.message == null ? '' : String(result.error.message);
    const rawText = [contentText, errorMessage].filter(Boolean).join('\n');
    const classification = classifyError({
      message: errorMessage,
      code: result.error?.info?.code,
      error: result.error,
      content: blocks,
    });

    if (classification.category === 'aborted') {
      stats.skipped += 1;
      return decision;
    }

    const tool = exec?.name == null ? 'tool' : String(exec.name);
    const fp = fingerprint({ tool, category: classification.category, code: classification.code, message: rawText || errorMessage });
    const reportPath = store && typeof store.reportPathFor === 'function'
      ? store.reportPathFor(fp)
      : `reports/${fp}.md`;
    const safeRaw = redact(rawText || errorMessage);
    const safeError = redact(errorMessage || contentText || rawText);
    const route = routeOf(exec);
    const rawTokens = estimateTokens(safeRaw);
    const blockedBySeverity = severityRank(classification.severity) < severityRank(config.minSeverity ?? 'medium');

    let digest = null;
    let digestTokens = rawTokens;
    // `next()` normally returns the raw error as content blocks. That is not a
    // downstream replacement; only different text (or a value replacement) is.
    const decisionContentText = decision.content === undefined ? contentText : textOfContent(decision.content);
    const downstreamChanged = decision.value !== undefined
      || (decision.content !== undefined && !sameContentText(decisionContentText, contentText));
    if (
      config.enabled !== false
      && !blockedBySeverity
      && !hasMedia
      && !downstreamChanged
      && rawTokens > positiveNumber(config.maxInlineTokens, 250)
    ) {
      const baseFields = {
        toolName: tool,
        category: classification.category,
        detail: safeError || safeRaw,
        hint: classification.hint,
        reportPath,
      };
      const base = renderDigest(baseFields, { maxDetailChars: positiveNumber(config.maxDetailChars, 200) });
      const baseTokens = estimateTokens(base);
      if (baseTokens < rawTokens) {
        // The marker itself costs tokens; subtract a small conservative margin
        // so the recorded projection saving never overstates the compression.
        const conservativeSaved = Math.max(0, rawTokens - baseTokens - 16);
        if (conservativeSaved > 0) {
          const candidate = renderDigest({
            ...baseFields,
            rawTokens,
            digestTokens: baseTokens,
            savedTokens: conservativeSaved,
          }, { maxDetailChars: positiveNumber(config.maxDetailChars, 200) });
          const candidateTokens = estimateTokens(candidate);
          if (candidateTokens < rawTokens) {
            digest = candidate;
            digestTokens = candidateTokens;
          }
        }
      }
    }

    const entry = {
      fingerprint: fp,
      tool,
      category: classification.category,
      severity: classification.severity,
      code: classification.code,
      session: sessionOf(exec),
      parent: parentOf(exec),
      agentKind: agentKindOf(exec),
      route,
      tokensRaw: rawTokens,
      tokensDigest: digestTokens,
      raw: safeRaw,
      error: safeError,
      summary: `${tool} failed · ${classification.category}`,
      hint: classification.hint,
      context: contextOf(exec),
      evidence: `tool/result callId=${exec?.callId ?? 'unknown'} root=${exec?.rootCallId ?? 'unknown'} code=${classification.code ?? 'none'}`,
    };
    const savings = digest ? {
      savedTokens: rawTokens - digestTokens,
      rawTokens,
      digestTokens,
      provider: route.split('/')[0],
      model: route.split('/')[1],
      route,
      tool,
      category: classification.category,
      fingerprint: fp,
      session: entry.session,
      mode: config.priceMode ?? 'cacheMissOffPeak',
    } : null;

    stats.failures += 1;
    if (digest) {
      stats.compressed += 1;
      stats.savingsTokens += savings.savedTokens;
    }

    const persistence = persist(entry, savings, exec);
    if (firstPersist) {
      firstPersist = false;
      await persistence;
    } else {
      void persistence;
    }

    if (digest) {
      return { ...decision, content: [{ type: 'text', text: digest }] };
    }
    if (config.enabled === false || blockedBySeverity || downstreamChanged) {
      return decision;
    }

    stats.hints += 1;
    const context = createMessage({
      text: hintText(tool, classification.category, classification.hint, reportPath),
      summary: boundSummary(`${tool} · ${classification.category}`),
    });
    return {
      ...decision,
      additionalContexts: [...(Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []), context],
    };
  }

  async function persist(entry, savings, exec) {
    if (!store) return;
    try {
      const failure = Promise.resolve().then(() => store.recordFailure(entry));
      const saving = savings ? Promise.resolve().then(() => store.recordSavings(savings)) : Promise.resolve();
      const [failureResult] = await Promise.all([failure, saving]);
      if (failureResult && failureResult.ok === false) onError(new Error(failureResult.error ?? 'recordFailure failed'));
      const persisted = { ...entry, id: failureResult?.id ?? null };
      let observed = null;
      if (config.guardObserve !== false && failureResult?.ok !== false && typeof store.observeFailure === 'function') {
        observed = await store.observeFailure(persisted);
        if (observed?.hit && onGuardHit != null) {
          try {
            onGuardHit({ ...persisted, guard: observed.guard });
          } catch (error) {
            onError(error);
          }
        }
      }
      if (!observed?.hit && onUnresolved != null) {
        try {
          onUnresolved(persisted);
        } catch (error) {
          onError(error);
        }
      }
      if (onFailurePersisted != null) {
        try {
          onFailurePersisted(persisted, exec);
        } catch (error) {
          onError(error);
        }
      }
      if (onPersisted != null) {
        try {
          await onPersisted(entry);
        } catch (error) {
          onError(error);
        }
      }
    } catch (error) {
      onError(error);
    }
  }

  return {
    listener,
    config,
    stats,
    reset() {
      seen.clear();
      firstPersist = true;
    },
  };
}

function defaultContextMessage({ text, summary }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'failure-ledger', form: 'notice', summary: boundSummary(summary) }),
  });
}

function hintText(tool, category, hint, reportPath) {
  return `[dsh-failure-ledger] ${tool} failed · ${String(category).toUpperCase()}\n${hint}\nReport: ${reportPath}`;
}

function boundSummary(value) {
  const text = String(value ?? '');
  return text.length <= CONTEXT_SUMMARY_MAX ? text : `${text.slice(0, CONTEXT_SUMMARY_MAX - 1)}…`;
}

function routeOf(exec) {
  try {
    const config = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = config?.provider ?? 'unknown';
    const model = config?.model ?? 'unknown';
    return `${provider}/${model}`;
  } catch {
    return 'unknown/unknown';
  }
}

function sessionOf(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.id ?? null;
}

function parentOf(exec) {
  return exec?.agent?.session?.header?.parentSession ?? null;
}

function agentKindOf(exec) {
  return exec?.agent?.session?.header?.origin === 'subagent' ? 'subagent' : 'root';
}

function contextOf(exec) {
  try {
    return truncateMiddle(redact(JSON.stringify(exec?.arguments ?? null)), 1000);
  } catch {
    return '';
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function isToolFailure(exec, result) {
  if (!result) return false;
  if (result.isError === true) return true;
  const tool = String(exec?.name ?? '');
  if (tool !== 'pwsh' && tool !== 'bash' && tool !== 'sh' && tool !== 'cmd') return false;
  const metaCode = result.meta?.exitCode ?? result.value?.exitCode;
  if (Number.isInteger(metaCode) && metaCode > 0) return true;
  // Shell tools treat a non-zero process exit as a successful tool call whose
  // content carries `[exit code: N]`; it is still a failure for this ledger.
  const text = [
    textOfContent(result.content),
    typeof result.value === 'string' ? result.value : '',
    result.error?.message ?? '',
  ].join('\n');
  return /\[exit code: [1-9]\d*\]/u.test(text);
}

function sameContentText(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  if (a === b) return true;
  if (a === '' || b === '') return false;
  return a.includes(b) || b.includes(a);
}

function severityRank(value) {
  if (value === 'low') return 0;
  if (value === 'high') return 2;
  return 1;
}
