import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { completeStep } from './complete_step.js';
import { StepNotCurrentError } from './step-state.js';

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

async function createActivePlan(userId: string, ideaId: string, steps: DraftStep[]): Promise<string> {
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

const TWO_STEPS: DraftStep[] = [
  { title: 'Step 1', description: ['Do it.'], dayOffset: 0 },
  { title: 'Step 2', description: ['Then this.'], dayOffset: 2 },
];

// Story 6.1 AC1 ("`complete_step` ... is covered") / AD-13 (state machine):
// integration tests against real Postgres, since `completeStep` runs inside
// a `db.transaction` whose step-advance + plan-completion writes must be
// observed atomically — a mocked `db` can't exercise that.
describe('completeStep (integration, real Postgres — Story 6.1 AC1, AD-13)', () => {
  it('advances to the next step as current and keeps the plan active', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId, TWO_STEPS);

    try {
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const current = rows.find((row) => row.status === 'current')!;

      const result = await completeStep(db, planId, current.id);

      expect(result.step.status).toBe('completed');
      expect(result.planCompleted).toBe(false);

      const [next] = await db.select().from(planSteps).where(eq(planSteps.id, rows.find((row) => row.status === 'pending')!.id));
      expect(next!.status).toBe('current');

      const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
      expect(plan!.status).toBe('active');
    } finally {
      await cleanUp(userId);
    }
  });

  // AC1: "called on the plan's final step ... the plan's status becomes
  // `completed`."
  it("completes the plan when the final step is completed", async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId, [{ title: 'Only step', description: ['Do it.'], dayOffset: 0 }]);

    try {
      const [onlyStep] = await db.select().from(planSteps).where(eq(planSteps.planId, planId));

      const result = await completeStep(db, planId, onlyStep!.id);

      expect(result.planCompleted).toBe(true);

      const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
      expect(plan!.status).toBe('completed');
    } finally {
      await cleanUp(userId);
    }
  });

  // AD-13: "`start_step`/`complete_step` must reject ... if called against a
  // step that is not the plan's current step — this is the state-machine
  // rule." The tool itself enforces this, not just the UI.
  it('rejects when stepId is not the plan\'s current step', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId, TWO_STEPS);

    try {
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const notCurrent = rows.find((row) => row.status === 'pending')!;

      await expect(completeStep(db, planId, notCurrent.id)).rejects.toThrow(StepNotCurrentError);
    } finally {
      await cleanUp(userId);
    }
  });
});
