/**
 * Host configuration defaults and normalization.
 *
 * The Schemastery `Config` schema lives in `config-schema-host.js` so this pure
 * module stays importable by local tests (the shipped `@deepseek-ai/schemastery`
 * package resolves only through the Host's static-import loader).
 */

import { normalizeRules } from './rules.js';
import { PRICE_MODES } from './savings.js';

export const DEFAULT_REPORT_ROOT = 'failure-reports';

export const DEFAULT_CONFIG = {
  reportRoot: DEFAULT_REPORT_ROOT,
  minSeverity: 'medium',
  digest: {
    enabled: true,
    maxInlineTokens: 250,
    maxDetailChars: 200,
  },
  report: {
    maxTotalMB: 100,
    rawMaxBytes: 32 * 1024,
    logMaxBytes: 1024 * 1024,
  },
  rules: normalizeRules(),
  savings: {
    priceMode: 'cacheMissOffPeak',
    customUnitPricePerMTokens: 1,
  },
  guards: {
    enabled: true,
    hint: true,
    tokenWaste: true,
    autoHint: true,
  },
  selfHeal: {
    enabled: true,
    windowSeconds: 180,
  },
  budget: {
    enabled: false,
    sessionCNY: 0,
    dailyCNY: 0,
    warnRatio: 0.8,
  },
  projection: { enabled: true },
  reminder: { enabled: true },
  panel: { enabled: true },
};

/**
 * Merge a loader config over the defaults without mutating either side.
 *
 * @param {object} [input] - row config.
 * @returns {object} complete config.
 */
export function normalizeHostConfig(input = {}) {
  const source = unwrapConfig(input);
  const digest = source.digest && typeof source.digest === 'object' ? source.digest : {};
  const report = source.report && typeof source.report === 'object' ? source.report : {};
  const savings = source.savings && typeof source.savings === 'object' ? source.savings : {};
  const priceMode = PRICE_MODES.includes(savings.priceMode) ? savings.priceMode : DEFAULT_CONFIG.savings.priceMode;
  return {
    reportRoot: typeof source.reportRoot === 'string' && source.reportRoot.trim() !== ''
      ? source.reportRoot
      : DEFAULT_CONFIG.reportRoot,
    minSeverity: typeof source.minSeverity === 'string' ? source.minSeverity : DEFAULT_CONFIG.minSeverity,
    digest: {
      enabled: digest.enabled !== false,
      maxInlineTokens: positive(digest.maxInlineTokens, DEFAULT_CONFIG.digest.maxInlineTokens),
      maxDetailChars: positive(digest.maxDetailChars, DEFAULT_CONFIG.digest.maxDetailChars),
    },
    report: {
      maxTotalMB: positive(report.maxTotalMB, DEFAULT_CONFIG.report.maxTotalMB),
      rawMaxBytes: positive(report.rawMaxBytes, DEFAULT_CONFIG.report.rawMaxBytes),
      logMaxBytes: positive(report.logMaxBytes, DEFAULT_CONFIG.report.logMaxBytes),
    },
    rules: normalizeRules(source.rules),
    savings: {
      priceMode,
      customUnitPricePerMTokens: positive(
        savings.customUnitPricePerMTokens,
        DEFAULT_CONFIG.savings.customUnitPricePerMTokens,
      ),
    },
    guards: {
      enabled: source.guards?.enabled !== false,
      hint: source.guards?.hint !== false,
      tokenWaste: source.guards?.tokenWaste !== false,
      autoHint: source.guards?.autoHint !== false,
    },
    selfHeal: {
      enabled: source.selfHeal?.enabled !== false,
      windowSeconds: positive(source.selfHeal?.windowSeconds, DEFAULT_CONFIG.selfHeal.windowSeconds),
    },
    budget: {
      enabled: source.budget?.enabled === true,
      sessionCNY: positive(source.budget?.sessionCNY, 0),
      dailyCNY: positive(source.budget?.dailyCNY, 0),
      warnRatio: ratio(source.budget?.warnRatio, DEFAULT_CONFIG.budget.warnRatio),
    },
    projection: {
      enabled: source.projection?.enabled !== false,
    },
    reminder: {
      enabled: source.reminder?.enabled !== false,
    },
    panel: {
      enabled: source.panel?.enabled !== false,
    },
  };
}

function unwrapConfig(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return unwrapConfig(value.get());
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(unwrapConfig);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child);
      return out;
    }
  }
  return value;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ratio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}
