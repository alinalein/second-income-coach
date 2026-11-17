import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CreatePlanDraft, SubmitIntakeToolArgs } from '@app/shared';
import { createPlansRouter, isUniqueViolationError, type PlansRouterDeps } from './plans.js';
import { createDb } from '../../db/client.js';
import { createCheckpointer } from '../../agent/checkpointer.js';
import { createActivatePlanGraph } from '../../tools/plain/activate_plan.js';
import { users, ideas, plans, planSteps, intake } from '../../db/schema/index.js';
import { upsertIntake } from '../../tools/plain/submit_intake.js';

// Bug fix (user-reported, live): Drizzle's `node-postgres` driver wraps the
// real `pg` error — a genuine unique-violation's `.code` lives at
// `error.cause.code`, never copied to the wrapper's own top level (confirmed
// against a real Postgres error, not guessed). This deterministic unit test
// locks that shape in, independent of whether a live HTTP race happens to
// hit the exact insert-collision window (the integration test below does,
// but non-deterministically).
describe('isUniqueViolationError (real Drizzle/node-postgres error shape)', () => {
  it.each([
    ['a Drizzle-wrapped error with the code nested under .cause', { cause: { code: '23505' } }, true],
    ['a raw pg error with the code at the top level', { code: '23505' }, true],
    ['a different Postgres error code', { cause: { code: '23502' } }, false],
    ['an error with no code anywhere', new Error('boom'), false],
  ] as const)('%s -> %s', (_name, error, expected) => {
    expect(isUniqueViolationError(error)).toBe(expected);
  });
});

const testEnv: PlansRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000 };

type FakeAgent = PlansRouterDeps['agent'];

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });
const checkpointer = createCheckpointer({ DATABASE_URL });
const activatePlanGraph = createActivatePlanGraph({ checkpointer, db, model: {} as never });

beforeAll(async () => {
  await checkpointer.setup();
});

afterAll(async () => {
  await pool.end();
});

async function createTestUser(): Promise<string> {
  const googleId = `test-${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
    .returning();
  return user!.id;
}

async function insertIdea(userId: string, status: string): Promise<string> {
  const [idea] = await db
    .insert(ideas)
    .values({
      userId,
      status,
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
    .returning({ id: ideas.id });
  return idea!.id;
}

async function cleanUp(userId: string) {
  const planRows = await db.select({ id: plans.id }).from(plans).where(eq(plans.userId, userId));
  for (const planRow of planRows) {
    await db.delete(planSteps).where(eq(planSteps.planId, planRow.id));
  }
  await db.delete(plans).where(eq(plans.userId, userId));
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

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

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    invoke: vi.fn(),
    getState: vi.fn(),
    updateState: vi.fn(),
    ...overrides,
  } as unknown as FakeAgent;
}

/** Story 2.10: `model` defaults to a never-called stub — `create_plan` is
 * now called directly via `handleCreatePlan`, with `createDraft` as the
 * test-only seam replacing the real model call (same DI precedent as
 * `create_plan.test.ts`). */
function buildTestApp(agent: FakeAgent, userId: string, overrides: Partial<PlansRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/plans', createPlansRouter({ env: testEnv, db, agent, model: {} as never, activatePlanGraph, ...overrides }));
  return app;
}

describe('createPlansRouter POST /select/:ideaId', () => {
  // I/O matrix: "Idea not owned by user / unselected idea" -> 404, no plan
  // created.
  it('returns 404 and creates no plan when the idea is still suggested', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'suggested');
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, userId)).post(`/api/plans/select/${ideaId}`);

      expect(res.status).toBe(404);
      expect(agent.invoke).not.toHaveBeenCalled();
      const [row] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Re-open, plan exists" -> existing row returned,
  // create_plan never re-invoked.
  it('returns the existing plan without invoking the agent when one already exists', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      const [existingPlan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const agent = fakeAgent();
      const res = await request(buildTestApp(agent, userId)).post(`/api/plans/select/${ideaId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(existingPlan!.id);
      expect(agent.invoke).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "First selection, no plan" -> create_plan runs once, draft
  // row + ordered steps + plan thread created. Story 2.10 (AC1): `agent.invoke`
  // is gone entirely — `handleCreatePlan` is called directly, with
  // `createDraft` as the test-only seam replacing the real model call (same
  // DI precedent as `create_plan.test.ts`). This proves the route mints a
  // planId, builds `plan:${planId}` as the real thread id, and reports the
  // row `handleCreatePlan` wrote back to the client.
  it('calls handleCreatePlan directly (no agent.invoke) and returns the created plan', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      await upsertIntake(db, userId, intakeArgs());
      const createDraft = vi.fn().mockResolvedValue(VALID_DRAFT);
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, userId, { createDraft })).post(`/api/plans/select/${ideaId}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('draft');
      expect(res.body.threadId).toBe(`plan:${res.body.id}`);
      expect(createDraft).toHaveBeenCalledTimes(1);
      // AC1: no `agent.invoke` anywhere in this route anymore.
      expect(agent.invoke).not.toHaveBeenCalled();

      // Bug fix (user-reported): the real plan thread gets seeded with a
      // fixed welcome message, never the raw trigger text.
      expect(agent.updateState).toHaveBeenCalledTimes(1);
      const [updateConfig, updateValues] = (agent.updateState as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(updateConfig.configurable.thread_id).toBe(`plan:${res.body.id}`);
      expect(updateValues.messages).toHaveLength(1);
      expect(updateValues.messages[0].content).toMatch(/first step/i);
    } finally {
      await cleanUp(userId);
    }
  });

  // Review fix: two concurrent requests both pass the "no existing plan"
  // check and both call `handleCreatePlan` — the loser's own insert hits the
  // real `plans_idea_id_unique` constraint. That must resolve to the
  // winner's plan (200), never a flat 502, since a plan genuinely was
  // created. Story 2.10: exercises the real `handleCreatePlan` transaction
  // (not a fake agent simulating its write) against real Postgres.
  it('returns the winning plan, not a 502, when two concurrent selects race past the no-existing-plan check', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      await upsertIntake(db, userId, intakeArgs());
      const createDraft = vi.fn().mockResolvedValue(VALID_DRAFT);
      const agent = fakeAgent();
      const app = buildTestApp(agent, userId, { createDraft });

      const [resA, resB] = await Promise.all([
        request(app).post(`/api/plans/select/${ideaId}`),
        request(app).post(`/api/plans/select/${ideaId}`),
      ]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.id).toBe(resB.body.id);

      const rows = await db.select().from(plans).where(eq(plans.ideaId, ideaId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanUp(userId);
    }
  });

  // Live-bug fix (user-reported, measured live: two real model calls, one
  // plan selection): the in-process in-flight dedupe map means a second
  // concurrent request for the same idea awaits the first's already
  // in-flight `handleCreatePlan` call instead of starting its own — so the
  // model-call seam itself (not just the DB row) is now idempotent too.
  it('calls createDraft exactly once when two concurrent selects race for the same idea', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      await upsertIntake(db, userId, intakeArgs());
      const createDraft = vi.fn().mockResolvedValue(VALID_DRAFT);
      const agent = fakeAgent();
      const app = buildTestApp(agent, userId, { createDraft });

      const [resA, resB] = await Promise.all([
        request(app).post(`/api/plans/select/${ideaId}`),
        request(app).post(`/api/plans/select/${ideaId}`),
      ]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.id).toBe(resB.body.id);
      expect(createDraft).toHaveBeenCalledTimes(1);
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createPlansRouter GET /:planId/current-step', () => {
  // Security-relevant failure branch: a plan id that exists but belongs to
  // another user is a 404, never another user's step content.
  it('returns 404 when the plan does not belong to this user', async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    try {
      const ideaId = await insertIdea(otherUserId, 'selected');
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId: otherUserId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const res = await request(buildTestApp(fakeAgent(), userId)).get(`/api/plans/${plan!.id}/current-step`);

      expect(res.status).toBe(404);
    } finally {
      await cleanUp(userId);
      await cleanUp(otherUserId);
    }
  });

  // AC: "only the current and immediate-next step are visible."
  it('returns the current and next step for the plan owner', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();
      await db.insert(planSteps).values([
        { planId: plan!.id, stepOrder: 0, title: 'Now', description: ['Do this.'], dayOffset: 0, status: 'current' },
        { planId: plan!.id, stepOrder: 1, title: 'Next', description: ['Then this.'], dayOffset: 2, status: 'pending' },
      ]);

      const res = await request(buildTestApp(fakeAgent(), userId)).get(`/api/plans/${plan!.id}/current-step`);

      expect(res.status).toBe(200);
      expect(res.body.current.title).toBe('Now');
      expect(res.body.next.title).toBe('Next');
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createPlansRouter POST /:planId/activate* (AD-14, end to end over HTTP)', () => {
  // AC: "activate_plan pauses ... and surfaces the draft for confirm" then
  // "confirmation ... the plan becomes active" — the full request/pause/
  // resume cycle through the real route wiring, not just the underlying
  // functions `activate_plan.test.ts` already covers.
  it('surfaces the draft for review, then confirming it makes the plan active', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();
      await db.insert(planSteps).values(
        VALID_DRAFT.steps.map((step, index) => ({
          planId: plan!.id,
          stepOrder: index,
          title: step.title,
          description: step.description,
          dayOffset: step.dayOffset,
          status: index === 0 ? 'current' : 'pending',
        })),
      );

      const app = buildTestApp(fakeAgent(), userId);

      const reviewRes = await request(app).post(`/api/plans/${plan!.id}/activate`);
      expect(reviewRes.status).toBe(200);
      expect(reviewRes.body.steps).toHaveLength(VALID_DRAFT.steps.length);

      const confirmRes = await request(app).post(`/api/plans/${plan!.id}/activate/confirm`);
      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.status).toBe('active');
    } finally {
      await cleanUp(userId);
    }
  });

  // AC: "the modification is validated against the Zod schema" — an
  // invalid draft (too few steps) is rejected before any write, with the
  // plan's existing steps left untouched.
  it('rejects an invalid modify draft with 400 and leaves the plan steps unchanged', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, 'selected');
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();
      await db.insert(planSteps).values(
        VALID_DRAFT.steps.map((step, index) => ({
          planId: plan!.id,
          stepOrder: index,
          title: step.title,
          description: step.description,
          dayOffset: step.dayOffset,
          status: index === 0 ? 'current' : 'pending',
        })),
      );

      const app = buildTestApp(fakeAgent(), userId);
      await request(app).post(`/api/plans/${plan!.id}/activate`);

      const modifyRes = await request(app)
        .post(`/api/plans/${plan!.id}/activate/modify`)
        .send({ draft: { steps: [] } });

      expect(modifyRes.status).toBe(400);

      const steps = await db.select().from(planSteps).where(eq(planSteps.planId, plan!.id)).orderBy(planSteps.stepOrder);
      expect(steps.map((step) => step.title)).toEqual(VALID_DRAFT.steps.map((step) => step.title));
    } finally {
      await cleanUp(userId);
    }
  });
});
