import { eq } from 'drizzle-orm';
import { tool } from 'langchain';
import { stepActionToolSchema, type StartStepResponse } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, planSteps } from '../../db/schema/index.js';
import { assertCurrentStep, assertPlanActive, toStepResponse } from './step-state.js';
import { derivePlanIdFromThreadId, type GetCurrentStepRunConfig } from './get_current_step.js';

type Db = ReturnType<typeof createDb>['db'];
/**
 * AC (4.1): "the user starts a step ... a distinct start-of-action
 * acknowledgment fires, separate from completion" and "`start_step` ... is
 * called on a step that is not the plan's current step ... the tool itself
 * rejects the call." A plain, deterministic Postgres write (AD-4) — no LLM
 * call mutates this state. Idempotent on repeat calls against the same
 * current step (re-starting just refreshes `startedAt`), since nothing in
 * the ACs requires a second start to be an error.
 *
 * Bug fix (user-reported, live): also rejects a plan that isn't `active`
 * yet (`assertPlanActive`) — a `draft` plan awaiting human confirmation
 * must not let its own current step be started early. `plan` missing
 * entirely is left to `assertCurrentStep` below, same defensive precedent
 * as the rest of this file.
 */
export async function startStep(db: Db, planId: string, stepId: string): Promise<StartStepResponse> {
  const [plan] = await db.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).limit(1);
  if (plan) assertPlanActive(plan.status);

  const steps = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
  assertCurrentStep(steps, stepId);

  const [updated] = await db.update(planSteps).set({ startedAt: new Date() }).where(eq(planSteps.id, stepId)).returning();
  return { step: toStepResponse(updated!) };
}

/**
 * AD-4: `start_step` wrapped for agent use within the plan thread's
 * free-form chat — `planId` is derived from the thread id (same trust
 * boundary as `get_current_step`'s own agent tool), `stepId` is supplied by
 * the model from a step it already saw via `get_current_step`.
 */
export function createStartStepTool(db: Db) {
  return tool(
    async (args: { stepId: string }, config: GetCurrentStepRunConfig) => {
      const planId = derivePlanIdFromThreadId(config?.configurable?.thread_id);
      if (!planId) {
        throw new Error('start_step: no planId derivable from the current thread id');
      }
      const result = await startStep(db, planId, args.stepId);
      return JSON.stringify(result);
    },
    {
      name: 'start_step',
      description:
        "Call this when the user says they're starting work on their current plan step. Must be called with " +
        "the current step's own id (from get_current_step) — fails if that step isn't the plan's current step.",
      schema: stepActionToolSchema,
    },
  );
}
