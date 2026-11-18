import { and, eq, gte } from 'drizzle-orm';
import { tool } from 'langchain';
import {
  recordCheckInRequestSchema,
  checkInResponseSchema,
  checkInStatusResponseSchema,
  type RecordCheckInRequest,
  type CheckInResponse,
  type CheckInStatusResponse,
} from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, checkIns } from '../../db/schema/index.js';
import { derivePlanIdFromThreadId, startOfUtcDay, type GetCurrentStepRunConfig } from './get_current_step.js';

type Db = ReturnType<typeof createDb>['db'];
type CheckInRow = typeof checkIns.$inferSelect;

/** Same "not found/not owned" precedent as `activate_plan.ts`'s
 * `PlanNotFoundError`. */
export class PlanNotFoundError extends Error {}

function toCheckInResponse(row: CheckInRow): CheckInResponse {
  return checkInResponseSchema.parse({
    id: row.id,
    planId: row.planId,
    energy: row.energy,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Story 4.1 (AC, follow-up): "the energy question is asked at most once per
 * calendar day per user across ALL plans ... 'already answered today' is
 * computed from the user's check-ins across plans." A plain, deterministic
 * read (AD-4) — no `planId` filter at all, by design: a check-in recorded
 * against any one of the user's plans today counts for every plan. Same UTC
 * calendar-day precedent as `get_current_step.ts`'s own `startOfUtcDay`
 * (no-timezone-handling, consistent across this codebase).
 */
export async function getCheckInStatus(db: Db, userId: string): Promise<CheckInStatusResponse> {
  const [row] = await db
    .select({ id: checkIns.id })
    .from(checkIns)
    .where(and(eq(checkIns.userId, userId), gte(checkIns.createdAt, startOfUtcDay(new Date()))))
    .limit(1);
  return checkInStatusResponseSchema.parse({ answeredToday: Boolean(row) });
}

/**
 * AC (4.1): "a lightweight energy/status input is requested before any
 * task-related ask (`record_check_in`)" — a plain, deterministic Postgres
 * write (AD-4), never LLM-authored. Also resets `plans.timelineAnchorAt` to
 * now (AD-15): a real check-in is itself evidence the gap, if any, is over —
 * `get_current_step`'s next gap calculation measures forward from this
 * moment, not from whenever the plan was created/last adjusted.
 */
export async function recordCheckIn(db: Db, planId: string, args: RecordCheckInRequest): Promise<CheckInResponse> {
  const parsed = recordCheckInRequestSchema.parse(args);

  return db.transaction(async (tx) => {
    const [plan] = await tx.select({ userId: plans.userId }).from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) {
      throw new PlanNotFoundError(`record_check_in: plan "${planId}" was not found`);
    }

    const [row] = await tx
      .insert(checkIns)
      .values({ planId, userId: plan.userId, energy: parsed.energy, note: parsed.note ?? null })
      .returning();

    await tx.update(plans).set({ timelineAnchorAt: new Date(), updatedAt: new Date() }).where(eq(plans.id, planId));

    return toCheckInResponse(row!);
  });
}

/**
 * AD-4: `record_check_in` wrapped for agent use — `planId` derived from the
 * thread id (same trust boundary as `get_current_step`'s own agent tool);
 * `energy`/`note` are the model's own classification of the user's latest
 * message, the same "top-level agent classifies as part of its own ordinary
 * reasoning" precedent `submit_intake`'s `failurePattern` argument uses
 * (AD-4 Amendment) — not a second LLM-backed tool.
 */
export function createRecordCheckInTool(db: Db) {
  return tool(
    async (args: RecordCheckInRequest, config: GetCurrentStepRunConfig) => {
      const planId = derivePlanIdFromThreadId(config?.configurable?.thread_id);
      if (!planId) {
        throw new Error('record_check_in: no planId derivable from the current thread id');
      }
      const result = await recordCheckIn(db, planId, args);
      return JSON.stringify(result);
    },
    {
      name: 'record_check_in',
      description:
        "Call this first when the user checks in, before asking about or acting on any plan step — ask a " +
        'brief question about their energy or status today, classify their reply into energy (low/medium/high), ' +
        'and call this tool with that and an optional short note before doing anything else in the check-in.',
      schema: recordCheckInRequestSchema,
    },
  );
}
