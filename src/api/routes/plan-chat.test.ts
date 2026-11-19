import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeModel } from '@langchain/core/testing';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { createPlanChatRouter, type PlanChatRouterDeps } from './plan-chat.js';
import { createCoachAgent } from '../../agent/index.js';
import { createDb } from '../../db/client.js';
import { users, ideas, plans, messageCosts } from '../../db/schema/index.js';

// Story 5.3b: `PlanChatRouterDeps['env']` grew the LangSmith keys
// `recordFeedbackExample` reads — `LANGSMITH_TRACING: 'false'` keeps every
// feedback-route test below a no-op on that path, same as `record_feedback.
// test.ts`'s own `TEST_ENV`.
const testEnv: PlanChatRouterDeps['env'] = {
  RATE_LIMIT_WINDOW_MS: 60_000,
  MISTRAL_API_KEY: 'test-key',
  LANGSMITH_TRACING: 'false',
  LANGSMITH_API_KEY: 'test-key',
  LANGSMITH_FEEDBACK_DATASET: 'test-dataset',
};

// Story 5.3b: `PlanChatRouterDeps` gained `memoryStore` — no test in this
// file exercises a commented rating (the only path that touches it), so a
// never-called stub is enough.
function fakeMemoryStore(): PlanChatRouterDeps['memoryStore'] {
  return { put: vi.fn(), get: vi.fn(), delete: vi.fn(), search: vi.fn() } as unknown as PlanChatRouterDeps['memoryStore'];
}

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
  app.use('/api/plans', createPlanChatRouter({ env: testEnv, db: overrideDb, agent, memoryStore: fakeMemoryStore() }));
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

// Bug fix (user-reported): `create_plan` (wired into this same `plansAgent`)
// threw "planId/ideaId/userId are not derivable from the current server
// context" on every turn of an existing plan thread whenever its tool call
// got invoked/retried here — this router's own `agent.stream` call passed
// only `thread_id`, never the rest `create_plan` requires (the lazy-create
// route, `src/api/routes/plans.ts`, does supply it). Once that invocation
// failed, the whole turn fell back to the generic error reply, which is also
// why no cost line showed: `src/api/routes/plan-chat.ts`'s cost-persistence
// block only runs for a successful reply.
describe('createPlanChatRouter (bug fix: create_plan tool context missing on this thread)', () => {
  it('POST /:planId/messages passes planId/ideaId/userId into configurable, not just thread_id', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const agent = fakeAgent({ stream: vi.fn().mockResolvedValue([['values', { messages: [new AIMessage('Sure.')] }]]) });

      const res = await request(buildTestApp(agent, userId)).post(`/api/plans/${plan!.id}/messages`).send({ content: 'hi' });

      expect(res.status).toBe(200);
      expect(agent.stream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ configurable: { thread_id: `plan:${plan!.id}`, planId: plan!.id, ideaId, userId } }),
      );
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 4.3 (AD-25): "the detected language from that call ... is passed
// downstream so the agent's reply uses that same language" — a voice-
// confirmed message carries `detectedLanguage`, forwarded into
// `configurable.voiceDetectedLanguage` for `src/agent/index.ts`'s own
// system-prompt hint to read. The test above already proves the no-hint
// (typed-message) case keeps the exact-object shape unchanged.
describe('createPlanChatRouter (Story 4.3, AD-25: voice-detected language forwarding)', () => {
  it('POST /:planId/messages forwards detectedLanguage into configurable.voiceDetectedLanguage when present', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const agent = fakeAgent({ stream: vi.fn().mockResolvedValue([['values', { messages: [new AIMessage('Klar.')] }]]) });

      const res = await request(buildTestApp(agent, userId))
        .post(`/api/plans/${plan!.id}/messages`)
        .send({ content: 'Hallo', detectedLanguage: 'de' });

      expect(res.status).toBe(200);
      expect(agent.stream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          configurable: { thread_id: `plan:${plan!.id}`, planId: plan!.id, ideaId, userId, voiceDetectedLanguage: 'de' },
        }),
      );
    } finally {
      await cleanUp(userId);
    }
  });
});

// Bug fix (user-reported): a plan-chat reply showed the thumbs footer item
// but no cost line at all — not even a token count. Root cause: production
// (`src/api/index.ts`) passes a shared, pre-built `model` into every
// `createCoachAgent(...)` call (AD-7 speed optimization), which this
// router's own agent dependency then also carries into `reactAgent.invoke`
// — `createCoachAgent`'s middleware wiring treats *any* injected `model` as
// "skip `createModelSelectionMiddleware`", so `resolvedModelId` was never
// tagged, for any turn, in production (confirmed: zero `message_costs` rows
// existed in the lane's own dev DB despite real prior conversations). This
// reproduces that exact production topology end to end — a *real* compiled
// `createCoachAgent` (not the `fakeAgent()` stand-in the tests above use),
// built the same way `src/api/index.ts` builds `plansAgent` (a `model`
// override, no `createModelSelectionMiddleware`) — through this router's
// real POST/GET handlers and a real Postgres `message_costs` row, with only
// the one real network call (the model itself) replaced by a `fakeModel`
// shaped like a genuine `ChatOpenAI` response (`response_metadata.model_name`
// set, the provider-native field `src/agent/index.ts`'s `resolveTurnModelId`
// now falls back to).
describe('createPlanChatRouter (bug fix: cost line missing because of the production model-sharing topology)', () => {
  it('persists a message_costs row and attaches cost on reload, using a real createCoachAgent built the same way production builds plansAgent', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'draft', threadId: `plan:${randomUUID()}` })
        .returning();

      const model = fakeModel().respond(
        new AIMessage({
          content: 'Here is a half-day outing idea for you.',
          usage_metadata: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
          response_metadata: { model_provider: 'openai', model_name: 'openai/gpt-6-luna' },
        }),
      );
      // Same shape `src/api/index.ts` builds `plansAgent` with: a shared
      // `model` override (AD-7), real checkpointer, no tools needed for a
      // plain reply (`tools: []` — this turn never calls one).
      const realAgent = createCoachAgent({
        env: { OPENROUTER_API_KEY: 'test-key', MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 2, DAILY_SEARCH_BUDGET: 500 },
        checkpointer: new MemorySaver(),
        db,
        webSearchTool: {} as never,
        model,
        classify: async () => ({}),
        tools: [],
      });

      const app = buildTestApp(realAgent, userId);
      const postRes = await request(app).post(`/api/plans/${plan!.id}/messages`).send({ content: 'Plan a day trip for two.' });
      expect(postRes.status).toBe(200);

      const costRows = await db.select().from(messageCosts).where(eq(messageCosts.threadId, `plan:${plan!.id}`));
      expect(costRows).toHaveLength(1);
      expect(costRows[0]).toMatchObject({ modelId: 'openai/gpt-6-luna', inputTokens: 120, outputTokens: 80 });

      const getRes = await request(app).get(`/api/plans/${plan!.id}/messages`);
      const reply = getRes.body.messages.find((message: { role: string }) => message.role === 'assistant');
      expect(reply.cost).toMatchObject({ modelId: 'openai/gpt-6-luna', inputTokens: 120, outputTokens: 80 });
      expect(reply.cost.amount).not.toBeNull();
    } finally {
      await db.delete(messageCosts).where(eq(messageCosts.userId, userId));
      await cleanUp(userId);
    }
  });
});

// Story 4.5 (AC4): "the chat stays fully usable [after completion] — read
// history, ask about completed steps, follow-up questions." Neither route
// below gates on `plans.status` at all (only `start_step`/`complete_step`
// do, at the tool level) — this proves a `completed` plan's thread is never
// blocked by anything this story's own wiring (the new system-prompt note)
// could have broken.
describe('createPlanChatRouter (Story 4.5 AC4: chat stays usable for a completed plan)', () => {
  it('POST /:planId/messages still succeeds, and GET /:planId/messages still reads history', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const [plan] = await db
        .insert(plans)
        .values({ ideaId, userId, status: 'completed', threadId: `plan:${randomUUID()}` })
        .returning();

      const model = fakeModel().respond(new AIMessage('You completed every step — your dog-walking plan is done.'));
      const realAgent = createCoachAgent({
        env: { OPENROUTER_API_KEY: 'test-key', MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 2, DAILY_SEARCH_BUDGET: 500 },
        checkpointer: new MemorySaver(),
        db,
        webSearchTool: {} as never,
        model,
        classify: async () => ({}),
        tools: [],
      });

      const app = buildTestApp(realAgent, userId);
      const postRes = await request(app).post(`/api/plans/${plan!.id}/messages`).send({ content: 'What did I just finish?' });
      expect(postRes.status).toBe(200);

      const getRes = await request(app).get(`/api/plans/${plan!.id}/messages`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.messages.some((message: { role: string; content: string }) => message.role === 'assistant')).toBe(true);
    } finally {
      await cleanUp(userId);
    }
  });
});
