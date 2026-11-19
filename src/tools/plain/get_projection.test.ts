import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { completeStep } from './complete_step.js';
import { recordCheckIn } from './record_check_in.js';
import { computeProjection, getProjection } from './get_projection.js';

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

async function createTestUserAndIdea(overrides: Partial<typeof ideas.$inferInsert> = {}): Promise<{ userId: string; ideaId: string }> {
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
      ...overrides,
    })
    .returning();

  return { userId, ideaId: idea!.id };
}

type DraftStep = { title: string; description: string[]; dayOffset: number };

const THREE_STEPS: DraftStep[] = [
  { title: 'Step 1', description: ['Do it.'], dayOffset: 0 },
  { title: 'Step 2', description: ['Then this.'], dayOffset: 2 },
  { title: 'Step 3', description: ['Then that.'], dayOffset: 5 },
];

async function createActivePlan(userId: string, ideaId: string, steps: DraftStep[] = THREE_STEPS): Promise<string> {
  const planId = randomUUID();
  await db.insert(plans).values({ id: planId, ideaId, userId, status: 'active', threadId: `plan:${planId}` });
  await db.insert(planSteps).values(
    steps.map((step, index) => ({
      planId,
      stepOrder: index,
      title: step.title,
      description: step.description,
      dayOffset: step.dayOffset,
      status: index === 0 ? 'current' : 'pending',
    })),
  );
  return planId;
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

// AC (4.4): "it uses the baseline rate persisted at idea-generation (AD-6)
// combined with actual logged hours and consistency [from check-ins and
// completed steps]" / "two check-ins with different actual progress -> the
// projection value changes between them" / "a plain deterministic tool
// (AD-4) - no LLM computes the projection math."
describe('computeProjection (AC: deterministic, progress- and consistency-driven, AD-4)', () => {
  it.each([
    [
      'no progress, no check-ins -> zero estimate',
      { baselineRateLow: { amountMinorUnits: 2500, currencyCode: 'EUR' as const }, rateUnit: 'hour' as const, weeklyTimeCommitment: '5_to_10h' as const, totalSteps: 3, completedSteps: 0, checkInCount: 0, daysSincePlanStart: 1 },
      0,
    ],
    [
      'full progress, full consistency (hourly rate) -> baseline x monthly hours cap',
      { baselineRateLow: { amountMinorUnits: 2500, currencyCode: 'EUR' as const }, rateUnit: 'hour' as const, weeklyTimeCommitment: '5_to_10h' as const, totalSteps: 3, completedSteps: 3, checkInCount: 5, daysSincePlanStart: 5 },
      Math.round(1 * 10 * 4.3 * 2500 * 1),
    ],
    [
      'same progress, fewer check-ins (lower consistency) -> a smaller estimate than full consistency',
      { baselineRateLow: { amountMinorUnits: 2500, currencyCode: 'EUR' as const }, rateUnit: 'hour' as const, weeklyTimeCommitment: '5_to_10h' as const, totalSteps: 3, completedSteps: 3, checkInCount: 0, daysSincePlanStart: 5 },
      Math.round(1 * 10 * 4.3 * 2500 * 0.5),
    ],
    [
      'project-rate idea -> scales the sourced rate by step-completion progress directly (no hourly decomposition)',
      { baselineRateLow: { amountMinorUnits: 50000, currencyCode: 'USD' as const }, rateUnit: 'project' as const, weeklyTimeCommitment: '5_to_10h' as const, totalSteps: 2, completedSteps: 1, checkInCount: 1, daysSincePlanStart: 1 },
      Math.round(50000 * 0.5 * 1),
    ],
  ] as const)('%s', (_name, inputs, expectedAmountMinorUnits) => {
    const result = computeProjection(inputs);

    expect(result.estimate.amountMinorUnits).toBe(expectedAmountMinorUnits);
    expect(result.estimate.currencyCode).toBe(inputs.baselineRateLow.currencyCode);
    // AC: "a plain deterministic tool - no LLM computes the projection
    // math" - the same inputs always produce the exact same output.
    expect(computeProjection(inputs)).toEqual(result);
  });
});

describe('getProjection (AC: uses the persisted baseline rate, never re-fetched)', () => {
  it('derives the estimate from the idea row\'s own stored baseline rate and rateUnit, matching computeProjection directly', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      await completeStep(db, planId, rows.find((row) => row.status === 'current')!.id);
      await recordCheckIn(db, planId, { energy: 'high' });

      const result = await getProjection(db, planId);

      const expected = computeProjection({
        baselineRateLow: { amountMinorUnits: 2500, currencyCode: 'EUR' },
        rateUnit: 'hour',
        weeklyTimeCommitment: '5_to_10h',
        totalSteps: 3,
        completedSteps: 1,
        checkInCount: 1,
        daysSincePlanStart: 1,
      });
      expect(result.estimate).toEqual(expected.estimate);
      expect(result.progressRatio).toBeCloseTo(expected.progressRatio);
    } finally {
      await cleanUp(userId);
    }
  });

  it('changes between two different check-in/completed-step histories for the same plan (AC3)', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      const before = await getProjection(db, planId);

      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      await completeStep(db, planId, rows.find((row) => row.status === 'current')!.id);
      await recordCheckIn(db, planId, { energy: 'medium' });

      const after = await getProjection(db, planId);

      expect(after.estimate.amountMinorUnits).not.toBe(before.estimate.amountMinorUnits);
    } finally {
      await cleanUp(userId);
    }
  });

  it('names the specific unlocked opportunity as the next step\'s own persisted title/description, never invented text', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      const result = await getProjection(db, planId);

      expect(result.unlockedOpportunity).toEqual({ title: 'Step 2', description: ['Then this.'] });
    } finally {
      await cleanUp(userId);
    }
  });

  it('returns a null unlocked opportunity when the plan\'s current step is its last', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId, [{ title: 'Only step', description: ['Do it.'], dayOffset: 0 }]);

      const result = await getProjection(db, planId);

      expect(result.unlockedOpportunity).toBeNull();
    } finally {
      await cleanUp(userId);
    }
  });

  // Bug fix (user-reported, live): "the value the next step unlocks,
  // computed deterministically with the same computeProjection but with the
  // next step counted as completed." Same `computeProjection`
  // determinism guarantee as above, specifically for `nextStepEstimate`.
  it('computes nextStepEstimate deterministically — the same plan state always produces the same value', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      const first = await getProjection(db, planId);
      const second = await getProjection(db, planId);

      expect(first.nextStepEstimate).toEqual(second.nextStepEstimate);
    } finally {
      await cleanUp(userId);
    }
  });

  it('nextStepEstimate differs from the current estimate when there is a next step', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      const result = await getProjection(db, planId);

      expect(result.nextStepEstimate).not.toBeNull();
      expect(result.nextStepEstimate!.amountMinorUnits).not.toBe(result.estimate.amountMinorUnits);
      expect(result.nextStepEstimate!.currencyCode).toBe(result.estimate.currencyCode);
    } finally {
      await cleanUp(userId);
    }
  });

  it('omits nextStepEstimate (null) when the plan\'s current step is its last', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId, [{ title: 'Only step', description: ['Do it.'], dayOffset: 0 }]);

      const result = await getProjection(db, planId);

      expect(result.nextStepEstimate).toBeNull();
    } finally {
      await cleanUp(userId);
    }
  });
});
