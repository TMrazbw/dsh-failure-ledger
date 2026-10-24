/**
 * Ephemeral guard hints.
 *
 * A guard hit after a failed tool call queues one short user-message hint for
 * the same session. The next `agent/pre-step` injects it before the model
 * retries. This never blocks a tool call, never creates an extra model request,
 * and limits hints to one per turn per session.
 */

import { randomUUID } from 'node:crypto';

export const HINT_TTL_MS = 60_000;
export const HINT_TEXT_MAX = 320;

/**
 * Create an in-memory hint queue.
 *
 * @param {{ttlMs?: number, now?: () => number, max?: number}} [options] - limits.
 * @returns {{push: Function, take: Function, clear: Function, size: Function}} queue.
 */
export function createHintQueue(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : HINT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 200;
  const pending = new Map();
  const lastTurn = new Map();

  function push(sessionId, guard) {
    const key = sessionId == null ? '' : String(sessionId);
    if (!key || !guard || typeof guard.hint !== 'string' || guard.hint.trim() === '') return false;
    pending.set(key, {
      guard,
      text: boundHint(guard.hint),
      createdAt: now(),
    });
    if (pending.size > max) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    return true;
  }

  function take(sessionId, turn) {
    const key = sessionId == null ? '' : String(sessionId);
    if (!key) return null;
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    if (now() - entry.createdAt > ttlMs) return null;
    const turnKey = turn == null ? null : String(turn);
    if (turnKey != null && lastTurn.get(key) === turnKey) return null;
    if (turnKey != null) lastTurn.set(key, turnKey);
    return { guard: entry.guard, text: entry.text };
  }

  function clear(sessionId) {
    const key = sessionId == null ? '' : String(sessionId);
    if (!key) return;
    pending.delete(key);
    lastTurn.delete(key);
  }

  function size() {
    return pending.size;
  }

  return { push, take, clear, size };
}

/**
 * Build the `agent/pre-step` listener that injects one queued hint.
 *
 * @param {{queue: object, enabled?: boolean, createMessage?: Function}} options - dependencies.
 * @returns {Function} waterfall listener.
 */
export function createGuardHintListener(options = {}) {
  const queue = options.queue;
  const enabled = options.enabled !== false;
  const createMessage = typeof options.createMessage === 'function'
    ? options.createMessage
    : createHintMessage;
  return async (payload, next) => {
    const decision = await next();
    if (!enabled || decision?.kind !== 'enter') return decision;
    const sessionId = payload?.agent?.id ?? payload?.agent?.session?.id ?? null;
    const hint = queue?.take?.(sessionId, payload?.turn);
    if (!hint) return decision;
    return {
      ...decision,
      messages: [...(Array.isArray(decision.messages) ? decision.messages : []), createMessage(hint)],
    };
  };
}

/**
 * Build one compact user-message hint.
 *
 * @param {{guard?: object, text?: string}} hint - queue entry.
 * @returns {object} UserMessage-like value.
 */
export function createHintMessage(hint) {
  const guard = hint?.guard ?? {};
  const text = hint?.text ?? (typeof guard.hint === 'string' ? boundHint(guard.hint) : '');
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{
      type: 'text',
      text: `[dsh-failure-ledger] 防复发提示（${guard.label ?? guard.id ?? 'guard'}）：${text}`,
    }]),
    source: Object.freeze({
      kind: 'failure-ledger',
      form: 'guard-hint',
      summary: String(guard.id ?? 'guard'),
    }),
  });
}

function boundHint(value) {
  const text = String(value ?? '').trim();
  return text.length <= HINT_TEXT_MAX ? text : `${text.slice(0, HINT_TEXT_MAX - 1)}…`;
}
