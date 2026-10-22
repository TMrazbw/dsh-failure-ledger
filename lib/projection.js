/**
 * The `failureLedger` session projection unit.
 *
 * The registry drives `apply` synchronously over committed session events and
 * serves `wire.view` to clients. The unit is registered by `index.js` through
 * `ctx.inject(['sessionProjections'], ...)`.
 *
 * Schemas are minimal `parse` objects: the installed registry (0.2.1-rc.2)
 * only calls `parse`, and a plain-JS bundle avoids a runtime `zod` dependency.
 * If a future registry starts calling other Zod methods, switching to `zod`
 * becomes a build dependency change, not a behavior change.
 */

import {
  aggregateAnomalyViews,
  applyAnomalyEvent,
  createAnomalyState,
  createAnomalyView,
} from './anomaly.js';

export const PROJECTION_KEY = 'failureLedger';
export const PROJECTION_STATE_VERSION = 1;

/**
 * Build the projection definition consumed by `ctx.sessionProjections.register`.
 *
 * @param {{rules?: object}} [options] - rule config captured at registration.
 * @returns {object} projection definition.
 */
export function createFailureLedgerProjection(options = {}) {
  const rules = options.rules;
  return {
    key: PROJECTION_KEY,
    stateVersion: PROJECTION_STATE_VERSION,
    stateSchema: parseSchema((value) => {
      if (!value || typeof value !== 'object') throw new TypeError('failureLedger state must be an object');
      return value;
    }),
    init(header) {
      return createAnomalyState(header ?? {});
    },
    apply(state, event) {
      return applyAnomalyEvent(state, event);
    },
    wire: {
      viewSchema: parseSchema((value) => {
        if (!value || typeof value !== 'object') throw new TypeError('failureLedger view must be an object');
        return value;
      }),
      view(state) {
        return createAnomalyView(state, { rules });
      },
    },
  };
}

/**
 * Sum parent and subagent views without counting one session twice.
 *
 * @param {object[]} views - `failureLedger` views.
 * @returns {object} aggregate.
 */
export function aggregateSessionStats(views) {
  return aggregateAnomalyViews(views);
}

function parseSchema(validate) {
  return Object.freeze({
    parse(value) {
      validate(value);
      return value;
    },
    safeParse(value) {
      try {
        return { success: true, data: this.parse(value) };
      } catch (error) {
        return { success: false, error };
      }
    },
  });
}
