/**
 * In-memory self-heal tracker.
 *
 * A failure is remembered for the current session/turn. If the same tool later
 * succeeds in the same turn with different arguments, that is a strong signal
 * that the model corrected the call; the caller may auto-resolve the failure
 * and learn a Guard.
 *
 * No raw arguments are persisted: only a stable in-memory signature is kept.
 */

import { stableValue } from './token-waste.js';

export const SELF_HEAL_WINDOW_MS = 180_000;

/**
 * Create a self-heal tracker.
 *
 * @param {{now?: () => number, windowMs?: number, max?: number}} [options] - limits.
 * @returns {{noteFailure: Function, noteSuccess: Function, clear: Function, size: Function}} tracker.
 */
export function createSelfHealTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : SELF_HEAL_WINDOW_MS;
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 200;
  const pending = new Map();

  function noteFailure(input = {}) {
    const sessionId = input.sessionId == null ? '' : String(input.sessionId);
    const tool = input.tool == null ? '' : String(input.tool);
    if (!sessionId || !tool) return false;
    pending.set(sessionId, {
      sessionId,
      tool,
      turn: input.turn == null ? null : input.turn,
      fingerprint: input.fingerprint ?? null,
      failureId: input.failureId ?? null,
      hint: input.hint ?? '',
      argsSignature: stableValue(input.args),
      at: now(),
    });
    if (pending.size > max) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    return true;
  }

  function noteSuccess(input = {}) {
    const sessionId = input.sessionId == null ? '' : String(input.sessionId);
    if (!sessionId) return null;
    const failure = pending.get(sessionId);
    if (!failure) return null;
    if (now() - failure.at > windowMs) {
      pending.delete(sessionId);
      return null;
    }
    if (failure.tool !== String(input.tool ?? '')) return null;
    if (failure.turn != null && input.turn != null && failure.turn !== input.turn) return null;
    const nextArgs = stableValue(input.args);
    if (nextArgs === failure.argsSignature) return null;
    pending.delete(sessionId);
    return { failure, nextArgs };
  }

  function clear(sessionId) {
    if (sessionId == null) return;
    pending.delete(String(sessionId));
  }

  function size() {
    return pending.size;
  }

  return { noteFailure, noteSuccess, clear, size };
}
