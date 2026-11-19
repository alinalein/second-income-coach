import { eq } from 'drizzle-orm';
import type { Money, RateUnit, WeeklyTimeAvailability, ProjectionData } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, planSteps, checkIns, ideas } from '../../db/schema/index.js';
import { getCurrentStep } from './get_current_step.js';

type Db = ReturnType<typeof createDb>['db'];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Same precedent as `IdeasPanel.tsx`'s own `computeMonthlyPotential`: the
 * weekly-time bucket's own upper-bound hours, times the standard
 * weeks-per-month constant. Reused here (not re-derived) so the projection
 * card's monthly figure is computed the same way the idea card's own
 * "potential per month" number already is.
 */
const WEEKLY_HOURS_CAP: Record<WeeklyTimeAvailability, number> = {
  under_5h: 5,
  '5_to_10h': 10,
  '10_to_20h': 20,
  '20h_plus': 20,
};
const WEEKS_PER_MONTH = 4.3;

export interface ProjectionInputs {
  /** AD-6: the idea's own persisted baseline rate — low end, same
   * conservative-estimate precedent `IdeasPanel.tsx` uses for its single-
   * number display. Never re-fetched or recomputed here. */
  baselineRateLow: Money;
  rateUnit: RateUnit;
  weeklyTimeCommitment: WeeklyTimeAvailability;
  totalSteps: number;
  completedSteps: number;
  checkInCount: number;
  /** Whole days since the plan was created, floored, minimum 1 (avoids a
   * division by zero on the plan's first day). */
  daysSincePlanStart: number;
}

/**
 * AC (4.4): "it uses the baseline rate persisted at idea-generation (AD-6)
 * combined with actual logged hours and consistency [from check-ins and
 * completed steps]" and "two check-ins with different actual progress ->
 * the projection value changes between them." A plain, deterministic
 * function (AD-4) — no LLM computes this math. Pure and unit-testable
 * without Postgres (same precedent as `get_current_step.ts`'s
 * `pickCurrentAndNext`/`computeMissedDays`).
 *
 * Design notes (no AC/AD spells out the exact formula — this story is the
 * first to need one, same "implementation-level decision made while
 * building the story that owns it" precedent epics.md uses for other
 * deferred details):
 * - No field anywhere in the app tracks literal "hours worked" (check-ins
 *   only ever carry an energy level + optional note, Story 4.1) — "actual
 *   logged hours" is derived from real progress instead: completed steps as
 *   a fraction of the plan's total steps, scaled against the idea's own
 *   weekly time-availability bucket (reusing `IdeasPanel.tsx`'s own
 *   `WEEKLY_HOURS_CAP`/`WEEKS_PER_MONTH` constants), never a literal input.
 * - "Consistency" reuses `step-state.ts`'s own AD-15 precedent ("one full
 *   day between visits is the expected cadence") as the expected check-in
 *   cadence: check-ins made vs. days elapsed, capped at 1. It floors the
 *   pace multiplier at 0.5 rather than letting a quiet stretch zero the
 *   estimate out entirely — visible progress is never erased by a missed
 *   check-in, matching this epic's non-punitive design even though NFR1
 *   itself only binds check-in *messaging*, not this number.
 * - `rateUnit === 'hour'` projects a monthly-equivalent figure (progress-
 *   scaled hours x the hourly rate); `'project'`/`'month'` rates have no
 *   meaningful hourly decomposition (same limitation `computeMonthlyPotential`
 *   documents), so those scale the sourced rate directly by plan-completion
 *   progress instead.
 */
export function computeProjection(inputs: ProjectionInputs): { estimate: Money; progressRatio: number } {
  const progressRatio = inputs.totalSteps > 0 ? inputs.completedSteps / inputs.totalSteps : 0;
  const consistencyRatio = Math.min(1, inputs.checkInCount / Math.max(1, inputs.daysSincePlanStart));
  const paceMultiplier = 0.5 + 0.5 * consistencyRatio;

  const amountMinorUnits =
    inputs.rateUnit === 'hour'
      ? Math.round(
          progressRatio * WEEKLY_HOURS_CAP[inputs.weeklyTimeCommitment] * WEEKS_PER_MONTH *
            inputs.baselineRateLow.amountMinorUnits *
            paceMultiplier,
        )
      : Math.round(inputs.baselineRateLow.amountMinorUnits * progressRatio * paceMultiplier);

  return {
    estimate: { amountMinorUnits, currencyCode: inputs.baselineRateLow.currencyCode },
    progressRatio,
  };
}

/**
 * AD-4/CAP-5: `get_projection` as a plain deterministic Postgres read — the
 * route (`src/api/routes/plans.ts`) checks plan ownership before calling
 * this, same precedent as `recordCheckIn`'s own `PlanNotFoundError`-free
 * callers; a missing plan/idea row here is defensive-only.
 *
 * `unlockedOpportunity`/`nextStepEstimate` both reuse `getCurrentStep`'s own
 * `next` field (AD-4: "`get_current_step` is the sole path ... capped to
 * current+next" — this never adds a second steps-reading path that could
 * expose more).
 */
export async function getProjection(db: Db, planId: string): Promise<ProjectionData> {
  const [row] = await db
    .select({
      baselineRateLowAmountMinorUnits: ideas.baselineRateLowAmountMinorUnits,
      baselineRateCurrency: ideas.baselineRateCurrency,
      rateUnit: ideas.rateUnit,
      weeklyTimeCommitment: ideas.weeklyTimeCommitment,
      planCreatedAt: plans.createdAt,
    })
    .from(plans)
    .innerJoin(ideas, eq(ideas.id, plans.ideaId))
    .where(eq(plans.id, planId))
    .limit(1);

  if (!row) {
    throw new Error(`get_projection: plan "${planId}" has no idea (defensive — caller must check ownership first)`);
  }

  const [stepRows, checkInRows, currentStep] = await Promise.all([
    db.select({ status: planSteps.status }).from(planSteps).where(eq(planSteps.planId, planId)),
    db.select({ id: checkIns.id }).from(checkIns).where(eq(checkIns.planId, planId)),
    getCurrentStep(db, planId),
  ]);

  const totalSteps = stepRows.length;
  const completedSteps = stepRows.filter((step) => step.status === 'completed').length;
  const daysSincePlanStart = Math.max(1, Math.floor((Date.now() - row.planCreatedAt.getTime()) / ONE_DAY_MS));

  // Bug fix (user-reported, live): shared base inputs for both calls below —
  // `nextStepEstimate` is deliberately the exact same `computeProjection`,
  // the exact same inputs, with only `completedSteps` bumped by one (the
  // pending next step counted as done) — "at this pace," nothing else about
  // the user's own consistency/pace changes.
  const projectionInputsBase = {
    baselineRateLow: { amountMinorUnits: row.baselineRateLowAmountMinorUnits, currencyCode: row.baselineRateCurrency as Money['currencyCode'] },
    rateUnit: row.rateUnit as RateUnit,
    weeklyTimeCommitment: row.weeklyTimeCommitment as WeeklyTimeAvailability,
    totalSteps,
    checkInCount: checkInRows.length,
    daysSincePlanStart,
  };

  const { estimate, progressRatio } = computeProjection({ ...projectionInputsBase, completedSteps });
  const nextStepEstimate = currentStep.next
    ? computeProjection({ ...projectionInputsBase, completedSteps: completedSteps + 1 }).estimate
    : null;

  return {
    estimate,
    progressRatio,
    nextStepEstimate,
    unlockedOpportunity: currentStep.next ? { title: currentStep.next.title, description: currentStep.next.description } : null,
  };
}
