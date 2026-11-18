import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { startStep } from './start_step.js';
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

// Story 6.1 (user-directed: "Add the new check-in tools ... to the
// deterministic coverage") / AD-13 (state machine), AD-4 (plain
// deterministic Postgres write). Integration against real Postgres, same
// precedent as `complete_step.test.ts`'s own sibling tool.
describe('startStep (integration, real Postgres — AD-13, AD-4)', () => {
  it('sets startedAt on the plan\'s current step', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId, TWO_STEPS);

    try {
      const [current] = await db.select().from(planSteps).where(eq(planSteps.planId, planId));

      const result = await startStep(db, planId, current!.id);

      expect(result.step.startedAt).not.toBeNull();
      expect(result.step.status).toBe('current');
    } finally {
      await cleanUp(userId);
    }
  });

  // AD-13: same state-machine rule `complete_step` enforces — the tool
  // itself rejects a call against a step that isn't the plan's current one.
  it('rejects when stepId is not the plan\'s current step', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createActivePlan(userId, ideaId, TWO_STEPS);

    try {
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const notCurrent = rows.find((row) => row.status === 'pending')!;

      await expect(startStep(db, planId, notCurrent.id)).rejects.toThrow(StepNotCurrentError);
    } finally {
      await cleanUp(userId);
    }
  });
});
