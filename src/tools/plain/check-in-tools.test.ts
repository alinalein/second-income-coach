import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps, checkIns } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { startStep } from './start_step.js';
import { completeStep } from './complete_step.js';
import { recordCheckIn } from './record_check_in.js';
import { getCurrentStep } from './get_current_step.js';
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
      baselineRateQuote: 'Workers in this field earn $25.00 an hour on average.',
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

// AC (4.1): "`start_step`/`complete_step` ... called on a step that is not
// the plan's current step ... the tool itself rejects the call."
describe('start_step / complete_step reject on a non-current step (AD-13 state-machine rule)', () => {
  it.each([
    ['start_step', (planId: string, stepId: string) => startStep(db, planId, stepId)],
    ['complete_step', (planId: string, stepId: string) => completeStep(db, planId, stepId)],
  ] as const)('%s rejects a stepId that is not the plan\'s current step', async (_name, call) => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const nonCurrent = rows.find((row) => row.status === 'pending')!;

      await expect(call(planId, nonCurrent.id)).rejects.toThrow(StepNotCurrentError);
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('startStep (AC: distinct start-of-action write)', () => {
  it('sets startedAt on the current step and leaves its status unchanged', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const current = rows.find((row) => row.status === 'current')!;

      const result = await startStep(db, planId, current.id);

      expect(result.step.status).toBe('current');
      expect(result.step.startedAt).not.toBeNull();
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('completeStep (AC: advance + visibility, final-step plan completion)', () => {
  it('advances the next step to current, leaving the one after it visible via get_current_step', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const current = rows.find((row) => row.status === 'current')!;

      const result = await completeStep(db, planId, current.id);

      expect(result.planCompleted).toBe(false);
      expect(result.step.status).toBe('completed');

      const afterRows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const newCurrent = afterRows.find((row) => row.status === 'current')!;
      expect(newCurrent.title).toBe('Step 2');
      const stillPending = afterRows.filter((row) => row.status === 'pending');
      expect(stillPending.map((row) => row.title)).toEqual(['Step 3']);
    } finally {
      await cleanUp(userId);
    }
  });

  it('completes the plan when the final step is completed', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId, [{ title: 'Only step', description: ['Do it.'], dayOffset: 0 }]);
      const rows = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
      const current = rows.find((row) => row.status === 'current')!;

      const result = await completeStep(db, planId, current.id);

      expect(result.planCompleted).toBe(true);
      const [plan] = await db.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).limit(1);
      expect(plan?.status).toBe('completed');
    } finally {
      await cleanUp(userId);
    }
  });
});

// AC (4.1): "`record_check_in`/`start_step`/`complete_step` ... are plain
// deterministic Postgres writes (AD-4)."
describe('recordCheckIn (AC: plain deterministic write, resets the gap anchor)', () => {
  it('persists the check-in and resets the plan\'s timelineAnchorAt', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      const result = await recordCheckIn(db, planId, { energy: 'medium', note: 'Feeling okay today.' });

      expect(result.energy).toBe('medium');
      expect(result.note).toBe('Feeling okay today.');

      const [plan] = await db.select({ timelineAnchorAt: plans.timelineAnchorAt }).from(plans).where(eq(plans.id, planId)).limit(1);
      expect(plan?.timelineAnchorAt).not.toBeNull();
    } finally {
      await cleanUp(userId);
    }
  });
});

// Bug fix (user-reported): the energy/status ask must disappear once
// answered for the day (and never reappear on reload the same day) —
// `getCurrentStep`'s `checkedInToday` is the server-truth signal the UI
// gates on, so it survives a page reload, not just in-memory component state.
describe('getCurrentStep.checkedInToday (bug fix: once-per-day check-in ask)', () => {
  it('is false with no check-in yet, true right after one is recorded', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    try {
      const planId = await createActivePlan(userId, ideaId);

      expect((await getCurrentStep(db, planId)).checkedInToday).toBe(false);

      await recordCheckIn(db, planId, { energy: 'high' });

      expect((await getCurrentStep(db, planId)).checkedInToday).toBe(true);
    } finally {
      await cleanUp(userId);
    }
  });
});
