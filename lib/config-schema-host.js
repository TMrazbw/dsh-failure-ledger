/**
 * Host-only Config schema.
 *
 * Schemastery is vendored under `vendor/node_modules` (MIT, copied read-only
 * from the local DSH installation) because a profile `link:` package cannot
 * resolve DSH's shipped bare package names. A relative import keeps both local
 * tests and the installed Host plugin independent of that resolution.
 */

import z from '../vendor/node_modules/@deepseek-ai/schemastery/lib/index.mjs';

import { DEFAULT_CONFIG, DEFAULT_REPORT_ROOT } from './config-schema.js';

const bool = (value) => z.boolean().default(value).volatile();
const num = (value) => z.number().default(value).volatile();
const str = (value) => z.string().default(value).volatile();

export const Config = z.object({
  reportRoot: z.string().default(DEFAULT_REPORT_ROOT),
  minSeverity: str(DEFAULT_CONFIG.minSeverity),
  digest: z.object({
    enabled: bool(true),
    maxInlineTokens: num(250),
    maxDetailChars: num(200),
  }),
  report: z.object({
    maxTotalMB: num(DEFAULT_CONFIG.report.maxTotalMB),
    rawMaxBytes: num(32 * 1024),
    logMaxBytes: num(1024 * 1024),
  }),
  rules: z.object({
    repeatFailure: z.object({
      enabled: bool(true),
      windowMinutes: num(10),
      threshold: num(3),
    }),
    largeErrorResend: z.object({
      enabled: bool(true),
      minRawTokens: num(250),
    }),
    requestRetry: z.object({
      enabled: bool(true),
      alertAfter: num(2),
    }),
    cacheReset: z.object({
      enabled: bool(true),
      minInputTokens: num(4000),
    }),
    contextPressure: z.object({
      enabled: bool(true),
      ratio: num(0.8),
    }),
    contextJump: z.object({
      enabled: bool(true),
      minDeltaTokens: num(8000),
      minWindowRatio: num(0.1),
      maxHitsPerSession: num(3),
    }),
    maxTokens: z.object({ enabled: bool(true) }),
    abortedTurn: z.object({ enabled: bool(true) }),
    subagentFailure: z.object({ enabled: bool(true) }),
    idleLoop: z.object({
      enabled: bool(true),
      minStepsWithoutProgress: num(4),
    }),
  }),
  savings: z.object({
    priceMode: str('cacheMissOffPeak'),
    customUnitPricePerMTokens: num(1),
  }),
  guards: z.object({
    enabled: z.boolean().default(true),
    hint: z.boolean().default(true),
    tokenWaste: z.boolean().default(true),
    autoHint: z.boolean().default(true),
  }),
  selfHeal: z.object({
    enabled: z.boolean().default(true),
    windowSeconds: num(180),
  }),
  budget: z.object({
    enabled: z.boolean().default(false),
    sessionCNY: num(0),
    dailyCNY: num(0),
    warnRatio: num(0.8),
  }),
  projection: z.object({ enabled: z.boolean().default(true) }),
  reminder: z.object({ enabled: z.boolean().default(true) }),
  panel: z.object({ enabled: z.boolean().default(true) }),
});
