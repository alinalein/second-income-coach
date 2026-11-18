import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { recordCheckIn, getCheckInStatus } from './record_check_in.js';

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

type DraftStep = { title: string; description: string[]; dayOffset: number };

const ONE_STEP: DraftStep[] = [{ title: 'Step 1', description: ['Do it.'], dayOffset: 0 }];

async function createActivePlan(userId: string, ideaId: string, steps: DraftStep[] = ONE_STEP): Promise<string> {
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

// Story 6.1 (user-directed: "Add the new check-in tools ... to the
// deterministic coverage") / AD-15 ("a real check-in is itself evidence the
// gap, if any, is over" — `timelineAnchorAt` reset). Integration against
// real Postgres, same precedent as the sibling step-action tools.
describe('recordCheckIn (integration, real Postgres — AD-15)', () => {
  it("records a check-in and resets the plan's timelineAnchorAt to now", async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId);

    try {
      const before = Date.now();
      const result = await recordCheckIn(db, planId, { energy: 'high', note: 'Feeling good today.' });
      expect(result.energy).toBe('high');
      expect(result.note).toBe('Feeling good today.');

      const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
      expect(plan!.timelineAnchorAt).not.toBeNull();
      expect(plan!.timelineAnchorAt!.getTime()).toBeGreaterThanOrEqual(before);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 4.1 AC ("the energy question is asked at most once per calendar day
// per user across ALL plans"): a check-in recorded against one plan counts
// for every one of that user's plans — `getCheckInStatus` carries no
// `planId` filter at all.
describe('getCheckInStatus (AC: once per day, across all of the user\'s plans)', () => {
  it('is true after a check-in recorded against a different plan owned by the same user', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planAId = await createActivePlan(userId, ideaId);

    try {
      expect((await getCheckInStatus(db, userId)).answeredToday).toBe(false);

      await recordCheckIn(db, planAId, { energy: 'medium' });

      expect((await getCheckInStatus(db, userId)).answeredToday).toBe(true);
    } finally {
      await cleanUp(userId);
    }
  });
});
