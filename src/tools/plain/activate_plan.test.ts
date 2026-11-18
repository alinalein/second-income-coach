import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { CreatePlanDraft, SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { createCheckpointer } from '../../agent/checkpointer.js';
import { users, intake, ideas, plans, planSteps } from '../../db/schema/index.js';
import { upsertIntake } from './submit_intake.js';
import { confirmActivation, saveModifiedDraft, resumePausedPlan, createActivatePlanGraph } from './activate_plan.js';

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

const VALID_DRAFT: CreatePlanDraft = {
  steps: [
    { title: 'Step 1', description: ['Do it.'], dayOffset: 0 },
    { title: 'Step 2', description: ['Then this.'], dayOffset: 2 },
    { title: 'Step 3', description: ['Then that.'], dayOffset: 5 },
  ],
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });
const checkpointer = createCheckpointer({ DATABASE_URL });

beforeAll(async () => {
  await checkpointer.setup();
});

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

async function createDraftPlan(userId: string, ideaId: string, draft: CreatePlanDraft = VALID_DRAFT): Promise<string> {
  const planId = randomUUID();
  await db.insert(plans).values({ id: planId, ideaId, userId, status: 'draft', threadId: `plan:${planId}` });
  await db.insert(planSteps).values(
    draft.steps.map((step, index) => ({
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
    await db.delete(planSteps).where(eq(planSteps.planId, planRow.id));
  }
  await db.delete(plans).where(eq(plans.userId, userId));
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('confirmActivation (integration, real Postgres — AD-14)', () => {
  // AC: "Given no plan is active yet / When checked / Then the system
  // correctly reflects zero active plans rather than erroring."
  it('activates a draft plan when the user has zero active plans', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createDraftPlan(userId, ideaId);

    try {
      const result = await confirmActivation(db, planId, userId);
      expect(result.status).toBe('active');
    } finally {
      await cleanUp(userId);
    }
  });

  // AD-14: "Confirm → plan becomes active (and any previously active plan
  // becomes paused) ... a single transaction that atomically deactivates the
  // previous plan and activates the new one." The one real-Postgres
  // integration test for the exactly-one-active-plan partial unique
  // constraint, exercised via the application path.
  it('pauses the previously active plan, leaving exactly one active plan for the user', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planAId = await createDraftPlan(userId, ideaId);
    await confirmActivation(db, planAId, userId);

    // A second idea/plan for the same user (plans.ideaId is unique per idea).
    const [idea2] = await db
      .insert(ideas)
      .values({
        userId,
        status: 'selected',
        title: 'Freelance writing',
        rationale: 'Fits your schedule.',
        citedIntakeFields: ['weeklyTimeAvailability'],
        ideaType: 'service_gig',
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
    const planBId = await createDraftPlan(userId, idea2!.id);

    try {
      const result = await confirmActivation(db, planBId, userId);
      expect(result.status).toBe('active');

      const activePlans = await db.select().from(plans).where(and(eq(plans.userId, userId), eq(plans.status, 'active')));
      expect(activePlans).toHaveLength(1);
      expect(activePlans[0]!.id).toBe(planBId);

      const [planA] = await db.select().from(plans).where(eq(plans.id, planAId));
      expect(planA!.status).toBe('paused');
    } finally {
      await cleanUp(userId);
    }
  });

  // AD-14: the database-level backstop — even bypassing `confirmActivation`'s
  // own pause-first transaction, the partial unique index itself rejects a
  // second `active` row for the same user.
  it('rejects a second active plan for the same user at the DB layer (partial unique index)', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planAId = await createDraftPlan(userId, ideaId);

    const [idea2] = await db
      .insert(ideas)
      .values({
        userId,
        status: 'selected',
        title: 'Freelance writing',
        rationale: 'Fits your schedule.',
        citedIntakeFields: ['weeklyTimeAvailability'],
        ideaType: 'service_gig',
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
    const planBId = await createDraftPlan(userId, idea2!.id);

    try {
      await db.update(plans).set({ status: 'active' }).where(eq(plans.id, planAId));
      await expect(db.update(plans).set({ status: 'active' }).where(eq(plans.id, planBId))).rejects.toThrow();
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('resumePausedPlan (integration, real Postgres — Story 3.3 AD-13)', () => {
  // AC1/AC2: "the current plan becomes `paused` ... as part of activating
  // the new one" / "that same plan resumes with its existing steps/progress
  // intact — `create_plan` does not run again." No LLM/`create_plan` call
  // happens here at all (unlike `confirmActivation`'s reject branch) — the
  // steps assertion below is what proves the existing row/steps were never
  // touched, only the status flip.
  it('resumes a paused plan to active, pauses the previously active plan, and leaves its steps untouched', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planAId = await createDraftPlan(userId, ideaId);
    await confirmActivation(db, planAId, userId);

    const [idea2] = await db
      .insert(ideas)
      .values({
        userId,
        status: 'bookmarked',
        title: 'Freelance writing',
        rationale: 'Fits your schedule.',
        citedIntakeFields: ['weeklyTimeAvailability'],
        ideaType: 'service_gig',
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
    const planBId = await createDraftPlan(userId, idea2!.id);
    await confirmActivation(db, planBId, userId);
    // planB is active, planA is now paused (confirmActivation's own pause
    // step) — pausing planB directly to set up "a bookmarked idea with an
    // existing paused plan" (planB).
    await db.update(plans).set({ status: 'paused' }).where(eq(plans.id, planBId));

    try {
      const result = await resumePausedPlan(db, planBId, userId);
      expect(result.status).toBe('active');

      const [planA] = await db.select().from(plans).where(eq(plans.id, planAId));
      expect(planA!.status).toBe('paused');

      const activePlans = await db.select().from(plans).where(and(eq(plans.userId, userId), eq(plans.status, 'active')));
      expect(activePlans).toHaveLength(1);
      expect(activePlans[0]!.id).toBe(planBId);

      const stepsB = await db.select().from(planSteps).where(eq(planSteps.planId, planBId)).orderBy(planSteps.stepOrder);
      expect(stepsB.map((step) => step.title)).toEqual(VALID_DRAFT.steps.map((step) => step.title));
    } finally {
      await cleanUp(userId);
    }
  });

  // AC: resuming a plan that is not (or no longer) `paused` is a tolerant
  // no-op — same idempotency spirit as `/select/:ideaId`'s own "re-open,
  // plan exists" path, never an error for a plan that's already active.
  it('is a no-op, returning the plan unchanged, when the plan is not paused', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createDraftPlan(userId, ideaId);
    await confirmActivation(db, planId, userId);

    try {
      const result = await resumePausedPlan(db, planId, userId);
      expect(result.status).toBe('active');
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('saveModifiedDraft (integration, real Postgres)', () => {
  // AC: "the modification ... saved to the draft (status remains draft)."
  it('replaces the plan steps from the given draft and keeps status draft', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createDraftPlan(userId, ideaId);
    const EDITED_DRAFT: CreatePlanDraft = {
      steps: [
        { title: 'Edited step 1', description: ['New action.'], dayOffset: 0 },
        { title: 'Edited step 2', description: ['Another new action.'], dayOffset: 4 },
      ],
    };

    try {
      const result = await saveModifiedDraft(db, planId, EDITED_DRAFT);
      expect(result.status).toBe('draft');

      const steps = await db.select().from(planSteps).where(eq(planSteps.planId, planId)).orderBy(planSteps.stepOrder);
      expect(steps.map((step) => step.title)).toEqual(['Edited step 1', 'Edited step 2']);
      expect(steps[0]!.status).toBe('current');
      expect(steps[1]!.status).toBe('pending');
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createActivatePlanGraph (integration, real Postgres + checkpointer — HITL-bypass negative test, AD-14/AD-23)', () => {
  // "A negative test proving activate_plan can never reach active status
  // without passing through the HITL pause" (AD-23). A fresh (non-`Command`)
  // invocation always hits `interrupt()` before any branch that could write
  // `active`/modify the draft — it can only pause, never fall through.
  it('pauses on a fresh invocation and leaves the plan untouched — never reaches active without a resume', async () => {
    const { userId, ideaId } = await createTestUserAndIdea();
    const planId = await createDraftPlan(userId, ideaId);
    const graph = createActivatePlanGraph({ checkpointer, db, model: {} as never });
    const threadId = `plan-activation:${planId}`;

    try {
      const result = (await graph.invoke({}, { configurable: { thread_id: threadId, planId, userId } })) as {
        result?: unknown;
      };

      // Interrupted: the node never returned its `{ result }` update.
      expect(result.result).toBeUndefined();

      const [planRow] = await db.select().from(plans).where(eq(plans.id, planId));
      expect(planRow!.status).toBe('draft');
    } finally {
      await cleanUp(userId);
    }
  });
});
