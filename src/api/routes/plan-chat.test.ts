import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPlanChatRouter, type PlanChatRouterDeps } from './plan-chat.js';
import { createDb } from '../../db/client.js';
import { users, ideas, plans } from '../../db/schema/index.js';

const testEnv: PlanChatRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000, MISTRAL_API_KEY: 'test-key' };

type FakeAgent = PlanChatRouterDeps['agent'];

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

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

async function insertIdea(userId: string): Promise<string> {
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
    .returning({ id: ideas.id });
  return idea!.id;
}

async function cleanUp(userId: string) {
  await db.delete(plans).where(eq(plans.userId, userId));
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return { stream: vi.fn(), getState: vi.fn(), ...overrides } as unknown as FakeAgent;
}

function buildTestApp(agent: FakeAgent, userId: string, overrideDb: PlanChatRouterDeps['db'] = db) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/plans', createPlanChatRouter({ env: testEnv, db: overrideDb, agent }));
  return app;
}

/** Review fix: a minimal fake matching `assertPlanOwnership`'s own
 * `db.select(...).from(...).where(...).limit(...)` chain, whose `limit`
 * rejects — simulates a transient DB failure during the ownership check
 * itself, distinct from a genuine "not found/not owned" result. */
function throwingDb(): PlanChatRouterDeps['db'] {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.reject(new Error('connection lost')),
        }),
      }),
    }),
  } as unknown as PlanChatRouterDeps['db'];
}

// Code Map: "resolves `plan:${planId}` ... after an ownership check against
// `plans.userId`" — the one behavior this router adds beyond mirroring
// `chat.ts`'s own already-tested SSE mechanics. A plan id that exists but
// belongs to another user is a 404 for either route, before the agent (or
// any checkpoint read/write on that thread) is ever touched.
describe('createPlanChatRouter (ownership check against plans.userId)', () => {
  it('POST /:planId/messages returns 404 and never invokes/streams the agent for a plan owned by another user', async () => {
    const ownerUserId = await createTestUser();
    const requesterUserId = await createTestUser();
    try {
      const ideaId = await insertIdea(ownerUserId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId: ownerUserId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, requesterUserId))
        .post(`/api/plans/${plan!.id}/messages`)
        .send({ content: 'hi' });

      expect(res.status).toBe(404);
      expect(agent.stream).not.toHaveBeenCalled();
    } finally {
      await cleanUp(ownerUserId);
      await cleanUp(requesterUserId);
    }
  });

  it('GET /:planId/messages returns 404 and never reads state for a plan owned by another user', async () => {
    const ownerUserId = await createTestUser();
    const requesterUserId = await createTestUser();
    try {
      const ideaId = await insertIdea(ownerUserId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId: ownerUserId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, requesterUserId)).get(`/api/plans/${plan!.id}/messages`);

      expect(res.status).toBe(404);
      expect(agent.getState).not.toHaveBeenCalled();
    } finally {
      await cleanUp(ownerUserId);
      await cleanUp(requesterUserId);
    }
  });

  // Review fix: a thrown error during the ownership check itself (a
  // transient DB failure) must surface as a logged 503, never a 404 —
  // a 404 is reserved for an actual "not found/not owned" result.
  it.each([
    ['POST', (app: ReturnType<typeof express>, planId: string) => request(app).post(`/api/plans/${planId}/messages`).send({ content: 'hi' })],
    ['GET', (app: ReturnType<typeof express>, planId: string) => request(app).get(`/api/plans/${planId}/messages`)],
  ] as const)('%s /:planId/messages returns 503 when the ownership check itself throws', async (_method, makeRequest) => {
    const app = buildTestApp(fakeAgent(), randomUUID(), throwingDb());

    const res = await makeRequest(app, randomUUID());

    expect(res.status).toBe(503);
  });

  // Story 5.3 Design Notes: "no new ownership-check code — ... reuses its
  // existing `assertPlanOwnership`". Proven here the same way as the
  // message routes above: a plan owned by someone else is a 404 for the
  // feedback routes too, before `record_feedback` is ever reached.
  it.each([
    ['POST', (app: ReturnType<typeof express>, planId: string) => request(app).post(`/api/plans/${planId}/messages/msg-1/feedback`).send({ rating: 'up' })],
    ['DELETE', (app: ReturnType<typeof express>, planId: string) => request(app).delete(`/api/plans/${planId}/messages/msg-1/feedback`)],
  ] as const)('%s .../feedback returns 404 for a plan owned by another user', async (_method, makeRequest) => {
    const ownerUserId = await createTestUser();
    const requesterUserId = await createTestUser();
    try {
      const ideaId = await insertIdea(ownerUserId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId: ownerUserId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const res = await makeRequest(buildTestApp(fakeAgent(), requesterUserId), plan!.id);

      expect(res.status).toBe(404);
    } finally {
      await cleanUp(ownerUserId);
      await cleanUp(requesterUserId);
    }
  });
});
