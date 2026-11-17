import { eq } from 'drizzle-orm';
import { tool } from 'langchain';
import { z } from 'zod';
import { currentStepResponseSchema, type CurrentStepResponse, type PlanStepResponse } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { planSteps } from '../../db/schema/index.js';

type Db = ReturnType<typeof createDb>['db'];
type PlanStepRow = typeof planSteps.$inferSelect;

function toStepResponse(row: PlanStepRow): PlanStepResponse {
  return {
    id: row.id,
    stepOrder: row.stepOrder,
    title: row.title,
    description: row.description,
    dayOffset: row.dayOffset,
    status: row.status as PlanStepResponse['status'],
  };
}

/**
 * AD-4/Boundary: "`get_current_step` is the only path returning step
 * content ... capped to current+next" — pure selection logic, factored out
 * of the DB read below so it's unit-testable against synthetic rows without
 * a real Postgres instance (mirrors `generate_ideas.ts`'s `evaluateBatch`).
 * `current` is the one row with `status === 'current'` (at most one, by
 * construction — `create_plan` writes exactly one); `next` is whichever row
 * has the next-higher `stepOrder`, or `null` when `current` is the plan's
 * last step (or when there is no `current` step at all, a defensive-only
 * case `create_plan`'s own write never produces).
 */
export function pickCurrentAndNext(rows: readonly PlanStepRow[]): CurrentStepResponse {
  const ordered = [...rows].sort((a, b) => a.stepOrder - b.stepOrder);
  const currentIndex = ordered.findIndex((row) => row.status === 'current');

  if (currentIndex === -1) {
    return currentStepResponseSchema.parse({ current: null, next: null });
  }

  const current = toStepResponse(ordered[currentIndex]!);
  const nextRow = ordered[currentIndex + 1];
  return currentStepResponseSchema.parse({ current, next: nextRow ? toStepResponse(nextRow) : null });
}

/**
 * AC: "a draft plan ... only the current and immediate-next step are
 * visible — `get_current_step` is the sole path enforcing this (AD-4)".
 * Used directly by `GET /api/plans/:planId/current-step` (plain read) and
 * wrapped below as an agent tool for free-form plan-thread Q&A — never a
 * second read path that could expose more than this.
 */
export async function getCurrentStep(db: Db, planId: string): Promise<CurrentStepResponse> {
  const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
  return pickCurrentAndNext(rows);
}

const PLAN_THREAD_PREFIX = 'plan:';

/**
 * Inverse of `buildPlanThreadId` (`src/agent/index.ts`) — duplicated locally
 * rather than imported (same Code Map precedent as `submit_intake.ts`/
 * `generate_ideas.ts`'s own `deriveUserIdFromThreadId`: this is a plain tool
 * module, not part of `src/agent/`). The plan-thread tool-call variant below
 * derives `planId` this way rather than via `config.configurable.planId` —
 * unlike `create_plan` (which runs *before* the plan/thread exists), this
 * tool only ever runs on an already-created plan's own thread, so the id
 * embedded in `thread_id` is always trustworthy.
 */
export function derivePlanIdFromThreadId(threadId: string | undefined): string | undefined {
  if (!threadId?.startsWith(PLAN_THREAD_PREFIX)) return undefined;
  const planId = threadId.slice(PLAN_THREAD_PREFIX.length);
  return planId.length > 0 ? planId : undefined;
}

export interface GetCurrentStepRunConfig {
  configurable?: { thread_id?: string };
}

/**
 * AD-4: `get_current_step` wrapped for agent use — "an existing plan
 * thread ... a free-form follow-up question (not a structured check-in
 * action) ... the agent answers it in context". No tool-call arguments at
 * all (same trust-boundary precedent as deriving `userId`/`planId` from the
 * thread id elsewhere): the model never supplies which plan to read.
 */
export function createGetCurrentStepTool(db: Db) {
  return tool(
    async (_args: Record<string, never>, config: GetCurrentStepRunConfig) => {
      const planId = derivePlanIdFromThreadId(config?.configurable?.thread_id);
      if (!planId) {
        throw new Error('get_current_step: no planId derivable from the current thread id');
      }
      const result = await getCurrentStep(db, planId);
      return JSON.stringify(result);
    },
    {
      name: 'get_current_step',
      description:
        'Call this when the user asks what their current step or next step is, or anything about where they ' +
        "are in their plan. Returns only the plan's current step and the immediate next step — never the full " +
        'list of steps.',
      schema: z.object({}),
    },
  );
}
