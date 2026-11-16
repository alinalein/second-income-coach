import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createIdeasRouter, type IdeasRouterDeps } from './ideas.js';
import { createDb } from '../../db/client.js';
import { users, ideas, userSettings } from '../../db/schema/index.js';

const testEnv: IdeasRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000 };

type FakeAgent = IdeasRouterDeps['agent'];

/** Same real-Postgres pattern as `intake.test.ts`. */
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

async function cleanUp(userId: string) {
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    invoke: vi.fn(),
    getState: vi.fn(),
    ...overrides,
  } as unknown as FakeAgent;
}

function buildTestApp(agent: FakeAgent, userId: string) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/ideas', createIdeasRouter({ env: testEnv, db, agent }));
  return app;
}

async function insertFiveIdeas(userId: string) {
  await db.insert(ideas).values(
    Array.from({ length: 5 }, (_, i) => ({
      userId,
      status: 'suggested',
      title: `Idea ${i + 1}`,
      rationale: 'Fits the handful of hours you have free each week.\nStart by listing your skills on one platform.',
      citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
      ideaType: 'service',
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
      baselineRateCitation: 'https://example.com/rates',
      sourceTrustTier: 'tier_3',
      isRateUnverified: false,
    })),
  );
}

describe('createIdeasRouter GET /', () => {
  // AC1: "the UI shows all 5 as cards" — the read this feeds, plus the
  // caller's userSettings.currency (AD-27).
  it('returns the persisted ideas and the user currency', async () => {
    const userId = await createTestUser();
    try {
      await insertFiveIdeas(userId);

      const res = await request(buildTestApp(fakeAgent(), userId)).get('/api/ideas');

      expect(res.status).toBe(200);
      expect(res.body.ideas).toHaveLength(5);
      expect(res.body.currency).toBe('EUR');
      expect(res.body.ideas[0].startupCost).toEqual({ amountMinorUnits: 0, currencyCode: 'EUR' });
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createIdeasRouter POST /generate', () => {
  // I/O matrix: "Happy path" -> 5 ideas returned, 200.
  it('returns the 5 newly generated ideas when the agent calls generate_ideas', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent({
        invoke: vi.fn().mockImplementation(async () => {
          await insertFiveIdeas(userId);
          return { messages: [] };
        }),
      });

      const res = await request(buildTestApp(agent, userId)).post('/api/ideas/generate');

      expect(res.status).toBe(200);
      expect(res.body.ideas).toHaveLength(5);
      // Story 2.2 follow-up fix 4: the trigger runs on the internal-only
      // `ideas-trigger:` thread, never the user-visible `discovery:` one —
      // this is what keeps it out of GET /api/chat/messages. Round 9, fix
      // (b): a request-scoped `AbortSignal` is now always passed too.
      expect(agent.invoke).toHaveBeenCalledWith(expect.anything(), {
        configurable: { thread_id: `ideas-trigger:${userId}` },
        signal: expect.any(AbortSignal),
      });
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.2 round 10 ("Generate new ideas" open item): the route's id-set
  // success check, not `generate_ideas.ts`'s own delete+insert transaction
  // (that has its own direct test in `generate_ideas.test.ts`) — this fake
  // agent simulates a real regenerate's effect (delete old suggested, insert
  // new 5) to prove the route correctly reports success from entirely new
  // ids, not the old before+5 row-count formula (which a replace, not an
  // append, no longer satisfies).
  it('reports success and returns the new batch when the agent regenerates (replacing the old suggested batch)', async () => {
    const userId = await createTestUser();
    try {
      await insertFiveIdeas(userId);
      const oldIds = (await db.select({ id: ideas.id }).from(ideas).where(eq(ideas.userId, userId))).map((row) => row.id);

      const agent = fakeAgent({
        invoke: vi.fn().mockImplementation(async () => {
          await db.delete(ideas).where(and(eq(ideas.userId, userId), eq(ideas.status, 'suggested')));
          await insertFiveIdeas(userId);
          return { messages: [] };
        }),
      });

      const res = await request(buildTestApp(agent, userId)).post('/api/ideas/generate');

      expect(res.status).toBe(200);
      expect(res.body.ideas).toHaveLength(5);
      expect(res.body.ideas.every((idea: { id: string }) => !oldIds.includes(idea.id))).toBe(true);
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "No intake row" / "Agent doesn't call the tool" -> generic
  // error, zero rows ever reported as success — same before/after guard as
  // `intake.ts`'s POST /, adapted to a row-count check.
  it('returns a generic error and reports nothing when the agent turn never persists ideas', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent({ invoke: vi.fn().mockResolvedValue({ messages: [] }) });

      const res = await request(buildTestApp(agent, userId)).post('/api/ideas/generate');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});
