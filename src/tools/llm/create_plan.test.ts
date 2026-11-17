import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CreatePlanDraft, SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas, plans, planSteps } from '../../db/schema/index.js';
import { upsertIntake } from '../plain/submit_intake.js';
import { handleCreatePlan, createCreatePlanTool, type CreatePlanDeps, type CreatePlanRunConfig } from './create_plan.js';

function intakeArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return {
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
    failurePattern: 'overwhelm',
    ...overrides,
  };
}

const VALID_DRAFT: CreatePlanDraft = {
  steps: [
    { title: 'List your first item', description: ['Take one photo.', 'Write a short description.'], dayOffset: 0 },
    { title: 'List a second item', description: ['Repeat with a different item.'], dayOffset: 2 },
    { title: 'Share your listings', description: ['Post a link in one local group.'], dayOffset: 5 },
  ],
};

// Perf fix (user-requested): "returnDirect ... cuts 3 LLM calls to 1" — the
// tool's content is already finished and validated by the time it returns,
// so the agent must not spend a second model call narrating it.
describe('createCreatePlanTool', () => {
  it('is built with returnDirect: true', () => {
    const tool = createCreatePlanTool({} as never, {} as never);
    expect(tool.returnDirect).toBe(true);
  });
});

// Trust-boundary unit test (AD-4/Design Notes: "planId/ideaId come from
// config.configurable, never a model-supplied arg") — no DB touched at all,
// mirrors `submit_intake.test.ts`'s identical-shaped test.
describe('handleCreatePlan (Design Notes: no write without a derivable server context)', () => {
  it('throws and never calls createDraft when planId/ideaId/userId are not derivable', async () => {
    const db = {} as never;
    const config: CreatePlanRunConfig = { configurable: { thread_id: 'plan:abc' } };
    let draftCalled = false;

    await expect(
      handleCreatePlan(
        { db, model: {} as never, createDraft: async () => ((draftCalled = true), VALID_DRAFT) },
        config,
        { replyLanguage: 'en' },
      ),
    ).rejects.toThrow(/planId|ideaId|userId/);
    expect(draftCalled).toBe(false);
  });
});

/**
 * Integration tests against real Postgres (same pattern as
 * `generate_ideas.test.ts`) — `handleCreatePlan`'s own deterministic logic
 * (Zod validation, ownership check, atomic persistence) is exercised
 * directly; the real `chatModel.withStructuredOutput(...)` call is replaced
 * by `createDraft`, a test-only seam.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function createTestUserWithIdeaAndIntake(): Promise<{ userId: string; ideaId: string }> {
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

async function cleanUp(userId: string, ideaId: string) {
  const planRows = await db.select({ id: plans.id }).from(plans).where(eq(plans.ideaId, ideaId));
  for (const planRow of planRows) {
    await db.delete(planSteps).where(eq(planSteps.planId, planRow.id));
  }
  await db.delete(plans).where(eq(plans.ideaId, ideaId));
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function baseDeps(overrides: Partial<CreatePlanDeps> = {}): CreatePlanDeps {
  return { db, model: {} as never, ...overrides };
}

describe('handleCreatePlan (integration, real Postgres)', () => {
  // AC: "a selected idea with no existing plan ... create_plan runs,
  // produces ordered steps with a timeline, saved with status draft."
  it('persists a draft plan with step 0 current and the rest pending', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();
    const planId = randomUUID();

    try {
      const result = await handleCreatePlan(
        baseDeps({ createDraft: async () => VALID_DRAFT }),
        { configurable: { thread_id: `plan:${planId}`, planId, ideaId, userId } },
        { replyLanguage: 'en' },
      );

      expect(result.status).toBe('draft');
      expect(result.threadId).toBe(`plan:${planId}`);

      const steps = await db.select().from(planSteps).where(eq(planSteps.planId, planId)).orderBy(planSteps.stepOrder);
      expect(steps).toHaveLength(VALID_DRAFT.steps.length);
      expect(steps[0]!.status).toBe('current');
      expect(steps.slice(1).every((step) => step.status === 'pending')).toBe(true);
    } finally {
      await cleanUp(userId, ideaId);
    }
  });

  // I/O matrix: "LLM output fails Zod validation" -> "Not saved as draft;
  // surfaced as a 502 error" (the route maps this throw to 502) / "Error
  // returned, no partial row".
  it('throws and writes no row when the draft fails Zod validation', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();
    const planId = randomUUID();

    try {
      await expect(
        handleCreatePlan(
          baseDeps({ createDraft: async () => ({ steps: [] }) as unknown as CreatePlanDraft }),
          { configurable: { thread_id: `plan:${planId}`, planId, ideaId, userId } },
          { replyLanguage: 'en' },
        ),
      ).rejects.toThrow();

      const [row] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await cleanUp(userId, ideaId);
    }
  });

  // I/O matrix: "Client disconnects mid-generation" -> "In-flight LLM call
  // aborted via AbortSignal, no orphaned write."
  it('throws and writes no row when the signal is already aborted', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();
    const planId = randomUUID();
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));

    try {
      await expect(
        handleCreatePlan(
          baseDeps({
            createDraft: async (_idea, _intakeRow, _lang, signal) => {
              if (signal?.aborted) throw new Error('create_plan: attempt aborted');
              return VALID_DRAFT;
            },
          }),
          { configurable: { thread_id: `plan:${planId}`, planId, ideaId, userId }, signal: controller.signal },
          { replyLanguage: 'en' },
        ),
      ).rejects.toThrow();

      const [row] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await cleanUp(userId, ideaId);
    }
  });

  // I/O matrix: "Idea not owned by user / unselected idea" -> "404/403, no
  // plan created" — this is the tool's own defense-in-depth re-check
  // (the route's 404 check is covered separately in `plans.test.ts`).
  it('throws and writes no row when the idea does not belong to this user', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();
    const { userId: otherUserId } = await createTestUserWithIdeaAndIntake();
    const planId = randomUUID();

    try {
      await expect(
        handleCreatePlan(
          baseDeps({ createDraft: async () => VALID_DRAFT }),
          { configurable: { thread_id: `plan:${planId}`, planId, ideaId, userId: otherUserId } },
          { replyLanguage: 'en' },
        ),
      ).rejects.toThrow(/idea/i);

      const [row] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await cleanUp(userId, ideaId);
      // `otherUserId` shares no idea with `ideaId` — clean it up by its own
      // (self-)idea id instead.
      const [otherIdea] = await db.select({ id: ideas.id }).from(ideas).where(eq(ideas.userId, otherUserId)).limit(1);
      if (otherIdea) await cleanUp(otherUserId, otherIdea.id);
    }
  });

  // Boundary: "no eager plan creation for unselected/unbookmarked ideas" —
  // a race between the route's own check and this tool actually running:
  // the idea's status has since flipped away from selected/bookmarked (e.g.
  // rejected from another tab) by the time `create_plan` runs.
  it('throws and writes no row when the idea is no longer selected/bookmarked', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();
    const planId = randomUUID();

    try {
      await db.update(ideas).set({ status: 'rejected' }).where(eq(ideas.id, ideaId));

      await expect(
        handleCreatePlan(
          baseDeps({ createDraft: async () => VALID_DRAFT }),
          { configurable: { thread_id: `plan:${planId}`, planId, ideaId, userId } },
          { replyLanguage: 'en' },
        ),
      ).rejects.toThrow(/idea/i);

      const [row] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await cleanUp(userId, ideaId);
    }
  });

  // Boundary: "Exactly one plans row per idea (DB unique constraint)" —
  // the one real-Postgres integration test this story's Verification
  // section calls for (CLAUDE.md: "one integration test against real
  // Postgres only for DB constraints").
  it('rejects a second plans row for the same idea (unique constraint)', async () => {
    const { userId, ideaId } = await createTestUserWithIdeaAndIntake();

    try {
      await db.insert(plans).values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` });

      await expect(db.insert(plans).values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })).rejects.toThrow();
    } finally {
      await cleanUp(userId, ideaId);
    }
  });
});
