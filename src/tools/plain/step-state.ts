import type { planSteps } from '../../db/schema/index.js';

type PlanStepRow = typeof planSteps.$inferSelect;

/** Thrown by `start_step`/`complete_step` when the given `stepId` isn't the
 * plan's own current step (AC/AD-13: "the tool itself rejects the call, not
 * just a UI-level guard") — also covers "no such step/plan at all", since
 * there is then no row matching `stepId` to find either way. The route maps
 * this to a 409, same precedent as `activate_plan.ts`'s `PlanNotDraftError`. */
export class StepNotCurrentError extends Error {}

/**
 * AD-13's state-machine rule, shared by `start_step` and `complete_step`:
 * the given `stepId` must be the one row with `status === 'current'` among
 * this plan's own steps. Factored out as a pure function (same
 * unit-testable-without-Postgres precedent as `get_current_step.ts`'s
 * `pickCurrentAndNext`) so both tools enforce it identically.
 */
export function assertCurrentStep(steps: readonly PlanStepRow[], stepId: string): PlanStepRow {
  const current = steps.find((step) => step.status === 'current');
  if (!current || current.id !== stepId) {
    throw new StepNotCurrentError(`Step "${stepId}" is not this plan's current step`);
  }
  return current;
}
