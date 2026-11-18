import { eq } from 'drizzle-orm';
import { tool } from 'langchain';
import { stepActionToolSchema, planStepResponseSchema, type CompleteStepResponse, type PlanStepResponse } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, planSteps } from '../../db/schema/index.js';
import { assertCurrentStep } from './step-state.js';
import { derivePlanIdFromThreadId, type GetCurrentStepRunConfig } from './get_current_step.js';

type Db = ReturnType<typeof createDb>['db'];
type PlanStepRow = typeof planSteps.$inferSelect;

function toStepResponse(row: PlanStepRow): PlanStepResponse {
  return planStepResponseSchema.parse({
    id: row.id,
    stepOrder: row.stepOrder,
    title: row.title,
    description: row.description,
    dayOffset: row.dayOffset,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  });
}

/**
 * AC (4.1): "`complete_step` fires ... the next step immediately becomes
 * current and the step after it becomes visible (maintaining the
 * current+next visibility rule)" and "called on the plan's final step ...
 * the plan's status becomes `completed`". A plain, deterministic Postgres
 * write (AD-4) inside one transaction — the step transitions and (on the
 * final step) the plan transition are never two separate non-atomic writes.
 * `planCompleted` is the one discriminator the caller needs to tell a
 * per-step completion from the final one (AC: "its own completion
 * acknowledgment distinct from a per-step one" — composed by the caller,
 * not this function; see `shared/schemas/check-ins.ts`).
 */
export async function completeStep(db: Db, planId: string, stepId: string): Promise<CompleteStepResponse> {
  return db.transaction(async (tx) => {
    const steps = await tx.select().from(planSteps).where(eq(planSteps.planId, planId));
    const current = assertCurrentStep(steps, stepId);

    const [completedRow] = await tx.update(planSteps).set({ status: 'completed' }).where(eq(planSteps.id, current.id)).returning();

    const nextRow = [...steps].sort((a, b) => a.stepOrder - b.stepOrder).find((step) => step.stepOrder > current.stepOrder);

    let planCompleted = false;
    if (nextRow) {
      await tx.update(planSteps).set({ status: 'current' }).where(eq(planSteps.id, nextRow.id));
    } else {
      await tx.update(plans).set({ status: 'completed', updatedAt: new Date() }).where(eq(plans.id, planId));
      planCompleted = true;
    }

    return { step: toStepResponse(completedRow!), planCompleted };
  });
}

/**
 * AD-4: `complete_step` wrapped for agent use — same `planId`-from-thread /
 * `stepId`-from-model shape as `start_step`'s own agent tool.
 */
export function createCompleteStepTool(db: Db) {
  return tool(
    async (args: { stepId: string }, config: GetCurrentStepRunConfig) => {
      const planId = derivePlanIdFromThreadId(config?.configurable?.thread_id);
      if (!planId) {
        throw new Error('complete_step: no planId derivable from the current thread id');
      }
      const result = await completeStep(db, planId, args.stepId);
      return JSON.stringify(result);
    },
    {
      name: 'complete_step',
      description:
        "Call this when the user says they've finished their current plan step. Must be called with the " +
        "current step's own id (from get_current_step) — fails if that step isn't the plan's current step. " +
        'The result tells you whether this was the plan\'s final step (planCompleted) — if so, give a warm, ' +
        'distinct completion message for finishing the whole plan, not just the one step; never mention ' +
        'streaks, points, or levels either way.',
      schema: stepActionToolSchema,
    },
  );
}
