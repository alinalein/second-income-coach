import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { tool } from 'langchain';
import { z } from 'zod';
import { currentStepResponseSchema, type CompletedStepResponse, type CurrentStepResponse, type PlanStepResponse } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, planSteps, checkIns } from '../../db/schema/index.js';

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
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  };
}

function toCompletedStepResponse(row: PlanStepRow): CompletedStepResponse {
  return { stepOrder: row.stepOrder, title: row.title, description: row.description };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AD-15: "compares the expected vs. actual last check-in date." `anchor` is
 * `plans.timelineAnchorAt` (reset to now by a real `record_check_in`, or by
 * this function itself once a gap is shifted) — falling back to the plan's
 * `createdAt` when never checked into yet. One full day between visits is
 * the expected cadence, not a miss, so `missedDays` only counts whatever is
 * beyond that — identical formula regardless of how large the gap is
 * (NFR1: "same non-punitive behavior ... regardless of count"). Pure and
 * unit-testable without Postgres (same precedent as `pickCurrentAndNext`).
 */
export function computeMissedDays(anchor: Date, now: Date): number {
  const elapsedDays = Math.floor((now.getTime() - anchor.getTime()) / ONE_DAY_MS);
  return Math.max(0, elapsedDays - 1);
}

/**
 * Bug fix (user-reported): "how's your energy today" must ask at most once
 * per calendar day — a week away should only ever ask about *today*, never
 * once per missed day. UTC calendar day (same no-timezone-handling
 * precedent as `dayOffset`/the rest of this file) — pure and unit-testable.
 */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
 *
 * AD-4 amendment (Story 4.5 bug fix): the cap stays for *future* steps
 * only — `completedSteps` below returns every `status === 'completed'`
 * row's title/description regardless of `current`, so a chat question
 * about a step the user already finished can be answered on both an
 * active and a completed plan.
 */
export interface GapFlags {
  gapDetected: boolean;
  missedDays: number;
  checkedInToday: boolean;
}

const NO_GAP: GapFlags = { gapDetected: false, missedDays: 0, checkedInToday: false };

/**
 * Story 4.5 (AC1): `completedAt` is the plan's own `updatedAt` — set once,
 * the moment `complete_step` transitions the plan to `completed`
 * (`complete_step.ts`), never touched again afterward (every other route
 * that could otherwise update a plan row rejects a non-`active` plan via
 * `assertPlanActive` first) — so it's a stable completion timestamp, not
 * re-derived here. `null` means "not completed" — `completion` below is
 * `null` either way.
 */
export function pickCurrentAndNext(
  rows: readonly PlanStepRow[],
  gap: GapFlags = NO_GAP,
  completedAt: Date | null = null,
): CurrentStepResponse {
  const ordered = [...rows].sort((a, b) => a.stepOrder - b.stepOrder);
  const currentIndex = ordered.findIndex((row) => row.status === 'current');
  const completedRows = ordered.filter((row) => row.status === 'completed');
  const completedSteps = completedRows.map(toCompletedStepResponse);
  const completion = completedAt ? { completedAt: completedAt.toISOString(), completedSteps: completedRows.length } : null;

  if (currentIndex === -1) {
    return currentStepResponseSchema.parse({ current: null, next: null, completedSteps, ...gap, completion });
  }

  const current = toStepResponse(ordered[currentIndex]!);
  const nextRow = ordered[currentIndex + 1];
  return currentStepResponseSchema.parse({
    current,
    next: nextRow ? toStepResponse(nextRow) : null,
    completedSteps,
    ...gap,
    completion,
  });
}

/**
 * AC: "a draft plan ... only the current and immediate-next step are
 * visible — `get_current_step` is the sole path enforcing this (AD-4)".
 * Used directly by `GET /api/plans/:planId/current-step` (plain read) and
 * wrapped below as an agent tool for free-form plan-thread Q&A — never a
 * second read path that could expose more than this.
 *
 * Story 4.2 (AD-15): "lazy, performed inside `get_current_step` the next
 * time the app is opened." `missedDays > 0` shifts every not-yet-completed
 * step's `dayOffset` forward by that many days (the DB write — a plain
 * deterministic Postgres update, AD-4) and resets `timelineAnchorAt` so the
 * same gap is never shifted twice; `gapDetected` is then `true` for this one
 * call only (the next call's anchor is already "now", so its own
 * `missedDays` comes back 0 until a real new gap opens).
 */
export async function getCurrentStep(db: Db, planId: string): Promise<CurrentStepResponse> {
  const [plan] = await db
    .select({ createdAt: plans.createdAt, timelineAnchorAt: plans.timelineAnchorAt, status: plans.status, updatedAt: plans.updatedAt })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const anchor = plan ? (plan.timelineAnchorAt ?? plan.createdAt) : undefined;
  const missedDays = anchor ? computeMissedDays(anchor, new Date()) : 0;

  if (missedDays > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(planSteps)
        .set({ dayOffset: sql`${planSteps.dayOffset} + ${missedDays}` })
        .where(and(eq(planSteps.planId, planId), ne(planSteps.status, 'completed')));
      await tx.update(plans).set({ timelineAnchorAt: new Date() }).where(eq(plans.id, planId));
    });
  }

  const [rows, [todaysCheckIn]] = await Promise.all([
    db.select().from(planSteps).where(eq(planSteps.planId, planId)),
    db
      .select({ id: checkIns.id })
      .from(checkIns)
      .where(and(eq(checkIns.planId, planId), gte(checkIns.createdAt, startOfUtcDay(new Date()))))
      .limit(1),
  ]);

  return pickCurrentAndNext(
    rows,
    { gapDetected: missedDays > 0, missedDays, checkedInToday: Boolean(todaysCheckIn) },
    plan?.status === 'completed' ? plan.updatedAt : null,
  );
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
        'Call this when the user asks what their current step or next step is, anything about where they are ' +
        'in their plan, or anything about a step they already completed (e.g. "what exactly was step 3?") — ' +
        "including on a completed plan, where there is no current step. Returns the plan's current step, the " +
        'immediate next step, and the title/description of every already-completed step. Never reveals any ' +
        'step beyond the immediate next one.',
      schema: z.object({}),
    },
  );
}
