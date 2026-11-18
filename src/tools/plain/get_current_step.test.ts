import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { buildPlanThreadId } from '../../agent/index.js';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { derivePlanIdFromThreadId, pickCurrentAndNext, computeMissedDays, startOfUtcDay, getCurrentStep } from './get_current_step.js';

type PlanStepRow = {
  id: string;
  planId: string;
  stepOrder: number;
  title: string;
  description: string[];
  dayOffset: number;
  status: string;
  startedAt: Date | null;
};

function step(overrides: Partial<PlanStepRow> = {}): PlanStepRow {
  return {
    id: randomUUID(),
    planId: 'plan-1',
    stepOrder: 0,
    title: 'Step',
    description: ['Do the thing.'],
    dayOffset: 0,
    status: 'pending',
    startedAt: null,
    ...overrides,
  };
}

// AD-18: "a thread id is always derived from the ... session" — same
// trust-boundary derivation pattern as `deriveUserIdFromThreadId`
// (`submit_intake.ts`/`generate_ideas.ts`). Deterministic unit test over the
// pure derivation function, no DB involved.
describe('derivePlanIdFromThreadId (AD-18: planId derivation)', () => {
  it.each([
    ['plan:plan-123', 'plan-123'],
    ['plan:', undefined],
    ['discovery:user-1', undefined],
    [undefined, undefined],
  ] as const)('derives %j -> %j', (threadId, expected) => {
    expect(derivePlanIdFromThreadId(threadId)).toBe(expected);
  });

  // Pins the round-trip with `buildPlanThreadId` (`src/agent/index.ts`) —
  // this is a hand-duplicated inverse of it (Code Map), same precedent as
  // `generate_ideas.ts`'s round-trip test with `buildDiscoveryThreadId`.
  it('round-trips with buildPlanThreadId', () => {
    const planId = randomUUID();
    expect(derivePlanIdFromThreadId(buildPlanThreadId(planId))).toBe(planId);
  });
});

// AC/AD-4: "only the current and immediate-next step are visible —
// `get_current_step` is the sole path enforcing this." Table-driven over
// the pure selection logic (no DB), covering the 3 distinct shapes a plan's
// step rows can take.
describe('pickCurrentAndNext (AC/AD-4: capped to current+next)', () => {
  it('returns the current step and the immediate next step', () => {
    const rows = [
      step({ stepOrder: 0, status: 'completed', title: 'Done' }),
      step({ stepOrder: 1, status: 'current', title: 'Now' }),
      step({ stepOrder: 2, status: 'pending', title: 'Next' }),
      step({ stepOrder: 3, status: 'pending', title: 'Later' }),
    ];

    const result = pickCurrentAndNext(rows);

    expect(result.current?.title).toBe('Now');
    expect(result.next?.title).toBe('Next');
  });

  it('returns a null next when the current step is the last one', () => {
    const rows = [step({ stepOrder: 0, status: 'completed' }), step({ stepOrder: 1, status: 'current', title: 'Last' })];

    const result = pickCurrentAndNext(rows);

    expect(result.current?.title).toBe('Last');
    expect(result.next).toBeNull();
  });

  it('returns null for both when no step is current', () => {
    const rows = [step({ stepOrder: 0, status: 'pending' }), step({ stepOrder: 1, status: 'pending' })];

    const result = pickCurrentAndNext(rows);

    expect(result.current).toBeNull();
    expect(result.next).toBeNull();
  });

  // Story 4.2 AC: "the same non-punitive behavior applies regardless of
  // count" — `gapDetected`/`missedDays` just pass through unchanged
  // regardless of the step shape; defaults to no gap when omitted.
  it('passes the gap flags through unchanged', () => {
    const rows = [step({ stepOrder: 0, status: 'current' })];
    const gap = { gapDetected: true, missedDays: 4, checkedInToday: true };

    expect(pickCurrentAndNext(rows).gapDetected).toBe(false);
    expect(pickCurrentAndNext(rows).checkedInToday).toBe(false);
    expect(pickCurrentAndNext(rows, gap).gapDetected).toBe(true);
    expect(pickCurrentAndNext(rows, gap).missedDays).toBe(4);
    expect(pickCurrentAndNext(rows, gap).checkedInToday).toBe(true);
  });
});

// Bug fix (user-reported): "how's your energy today" must ask at most once
// per calendar day, regardless of how long the user was away.
describe('startOfUtcDay (bug fix: once-per-day check-in ask)', () => {
  it.each([
    ['2026-11-18T00:00:00.000Z', '2026-11-18T23:59:59.000Z'],
    ['2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.001Z'],
    ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ] as const)('same UTC day as %s -> %s', (expected, input) => {
    expect(startOfUtcDay(new Date(input)).toISOString()).toBe(expected);
  });
});

// Story 4.2 (AD-15): "compares the expected vs. actual last check-in date."
// Table-driven over the pure day-math — one day of silence is the expected
// cadence (never a "miss"), every day beyond that counts, with no special
// case for a larger gap (NFR1: identical handling regardless of count).
describe('computeMissedDays (AD-15: gap-day math)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date('2026-11-18T12:00:00Z');

  it.each([
    ['checked in a few hours ago', new Date(now.getTime() - DAY_MS * 0.2), 0],
    ['checked in exactly one day ago (expected cadence)', new Date(now.getTime() - DAY_MS * 1), 0],
    ['missed one day', new Date(now.getTime() - DAY_MS * 2), 1],
    ['missed five days', new Date(now.getTime() - DAY_MS * 6), 5],
  ] as const)('%s -> missedDays %i', (_name, anchor, expected) => {
    expect(computeMissedDays(anchor, now)).toBe(expected);
  });
});

function intakeArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return {
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
    country: 'other',
    failurePattern: 'overwhelm',
    ...overrides,
  };
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function createTestUserAndIdea(): Promise<{ userId: string; ideaId: string }> {
  const googleId = `test-${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
    .returning();
  const userId = user!.id;

  await upsertIntake(db, userId, intakeArgs());

  const [idea] = await db
    .insert(ideas)
    .values({
      userId,
      status: 'selected',
      title: 'Resell thrifted items',
      rationale: 'Fits your schedule.\nStart by listing one item.',
      citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
      ideaType: 'resale_arbitrage',
      weeklyTimeCommitment: '5_to_10h',
      startupCostAmountMinorUnits: 0,
      startupCostCurrency: 'EUR',
      riskLevel: 'low',
      baselineRateQuote: 'Workers in this field earn €25.00 an hour on average.',
      baselineRateLowAmountMinorUnits: 2500,
      baselineRateHighAmountMinorUnits: 2500,
      isVendorSource: false,
      rateUnit: 'hour',
      baselineRateCurrency: 'EUR',
      baselineRateCitation: 'https://a.example.com/rates',
      sourceTrustTier: 'tier_1',
      isRateUnverified: false,
    })
    .returning();

  return { userId, ideaId: idea!.id };
}

async function cleanUp(userId: string): Promise<void> {
  const planRows = await db.select({ id: plans.id }).from(plans).where(eq(plans.userId, userId));
  for (const planRow of planRows) {
    await db.delete(checkIns).where(eq(checkIns.planId, planRow.id));
    await db.delete(planSteps).where(eq(planSteps.planId, planRow.id));
  }
  await db.delete(plans).where(eq(plans.userId, userId));
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

const DAY_MS_CONST = 24 * 60 * 60 * 1000;

// Story 6.1 AC1 ("timeline recalculation ... covered") / AD-15: the actual
// DB-level write `computeMissedDays`'s pure math feeds — shifts every
// not-yet-completed step's `dayOffset` forward by the missed-day count and
// resets `timelineAnchorAt`, leaving a `completed` step's own `dayOffset`
// untouched. Integration against real Postgres, since this is a write
// (`getCurrentStep`'s own transaction), not just the pure-math branch above.
describe('getCurrentStep (integration, real Postgres — Story 6.1 AC1/AD-15: timeline recalculation)', () => {
  it("shifts pending/current steps' dayOffset forward by the missed-day count, leaves a completed step untouched, and resets the anchor", async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = randomUUID();
    const sixDaysAgo = new Date(Date.now() - DAY_MS_CONST * 6);

    await db.insert(plans).values({ id: planId, ideaId, userId, status: 'active', threadId: `plan:${planId}`, timelineAnchorAt: sixDaysAgo });
    await db.insert(planSteps).values([
      { planId, stepOrder: 0, title: 'Done already', description: ['Do it.'], dayOffset: 0, status: 'completed' },
      { planId, stepOrder: 1, title: 'Now', description: ['Then this.'], dayOffset: 2, status: 'current' },
      { planId, stepOrder: 2, title: 'Later', description: ['Then that.'], dayOffset: 5, status: 'pending' },
    ]);

    try {
      const result = await getCurrentStep(db, planId);

      // 6 days of silence - 1 (expected cadence) = 5 missed days.
      expect(result.gapDetected).toBe(true);
      expect(result.missedDays).toBe(5);

      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      expect(rows.find((row) => row.status === 'completed')!.dayOffset).toBe(0);
      expect(rows.find((row) => row.title === 'Now')!.dayOffset).toBe(7);
      expect(rows.find((row) => row.title === 'Later')!.dayOffset).toBe(10);

      const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
      expect(plan!.timelineAnchorAt!.getTime()).toBeGreaterThan(sixDaysAgo.getTime());
    } finally {
      await cleanUp(userId);
    }
  });
});
