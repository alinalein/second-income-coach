import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { IdeaDraft, IntakeResponse, SubmitIntakeToolArgs } from '@app/shared';
import { createIdeasRouter, type IdeasRouterDeps } from './ideas.js';
import { createDb } from '../../db/client.js';
import { users, ideas, userSettings, plans, intake, userGenerationCounts } from '../../db/schema/index.js';
import { upsertIntake } from '../../tools/plain/submit_intake.js';
import { SearchServiceUnavailableError, type GenerateDraftsResult } from '../../tools/llm/generate_ideas.js';
import { incrementAndGetUserGenerationCount, getUserGenerationCount } from '../../tools/plain/usage_limits.js';

// Story 2.7: `createIdeasRouter` now also builds a translation chat model
// at construction time (`createChatModel(env, TRANSLATION_MODEL_ID)`) —
// these two keys are never actually used by any test below (no test here
// exercises `POST /translate`'s real model call), just present so
// construction itself doesn't throw / fails typecheck.
// Story 2.11: generous enough that no existing test's repeated
// `POST /generate` calls ever trip these — each test uses its own fresh user.
const testEnv: IdeasRouterDeps['env'] = {
  RATE_LIMIT_WINDOW_MS: 60_000,
  OPENROUTER_API_KEY: 'test-key',
  MISTRAL_API_KEY: 'test-key',
  IDEAS_PER_BATCH: 5,
  DAILY_SEARCH_BUDGET: 1_000_000,
  DAILY_GENERATIONS_PER_USER: 1_000_000,
  UNLIMITED_USER_EMAILS: '',
};

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
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(userGenerationCounts).where(eq(userGenerationCounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    invoke: vi.fn(),
    getState: vi.fn(),
    ...overrides,
  } as unknown as FakeAgent;
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

// Story 2.10: a minimal hard-valid draft fixture (same shape/precedent as
// `generate_ideas.test.ts`'s own `buildValidDraft`/`fiveValidDrafts`) — just
// enough to satisfy `handleGenerateIdeas`'s per-draft hard checks (quote
// verified against `searchResultTexts`, within intake's limits, not a vendor
// pricing page, currency-consistent). Idea-type/citation-domain variety are
// soft-only checks (never block), so every draft can safely share one
// ideaType/domain here.
const RATE_QUOTE = 'Tutoring work like this typically pays $25.00 an hour.';
const DEMAND_QUOTE = 'Demand for freelance tutoring has grown steadily this year.';
const SEARCH_RESULT_TEXTS = [RATE_QUOTE, DEMAND_QUOTE];

function buildValidDraft(intakeRow: IntakeResponse, overrides: Partial<IdeaDraft> = {}): IdeaDraft {
  return {
    title: 'Freelance tutoring',
    rationale: ['Fits the few hours you have free each week.', 'Start by listing your skills on one platform.'],
    citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
    ideaType: 'service',
    weeklyTimeCommitment: intakeRow.weeklyTimeAvailability,
    startupCostAmountMinorUnits: 0,
    riskLevel: intakeRow.riskTolerance,
    baselineRateQuote: RATE_QUOTE,
    baselineRateLowAmountMinorUnits: 2500,
    baselineRateHighAmountMinorUnits: 2500,
    isVendorSource: false,
    rateUnit: 'hour',
    baselineRateCurrency: 'USD',
    baselineRateCitation: 'https://a.example.com/rates',
    demandEvidenceNote: 'Demand for tutoring help has been rising lately.',
    demandEvidenceCitation: 'https://trend.example.com/demand',
    demandEvidenceQuote: DEMAND_QUOTE,
    growthPath: 'Raise your rate once you have a few regular clients.',
    ...overrides,
  };
}

function fiveValidDrafts(intakeRow: IntakeResponse, label: string): IdeaDraft[] {
  return Array.from({ length: 5 }, (_, i) => buildValidDraft(intakeRow, { title: `${label} ${i + 1}` }));
}

// Story 2.6 (second speed round): `handleGenerateIdeas` now calls
// `generateDrafts` once per idea (always `options.count === 1`), in
// parallel across the batch — order-independent, so this hands out one
// draft per call from a shared pool instead of returning the whole batch
// in one call.
function fakeGenerateDrafts(intakeRow: IntakeResponse, label = 'Idea') {
  const queue = fiveValidDrafts(intakeRow, label);
  return vi.fn().mockImplementation(async () => {
    const draft = queue.shift();
    if (!draft) throw new Error('fakeGenerateDrafts: pool exhausted — test requested more drafts than provided');
    return { drafts: { ideas: [draft] }, searchResultTexts: SEARCH_RESULT_TEXTS } satisfies GenerateDraftsResult;
  });
}

/** Story 2.10: `model`/`webSearchTool` default to never-called stubs —
 * `generate_ideas` is now called directly via `handleGenerateIdeas`, with
 * `generateDrafts` as the test-only seam replacing the real nested-agent
 * call (same DI precedent as `generate_ideas.test.ts`'s own `baseDeps`). */
function buildTestApp(agent: FakeAgent, userId: string, overrides: Partial<IdeasRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/ideas', createIdeasRouter({ env: testEnv, db, agent, model: {} as never, webSearchTool: {} as never, ...overrides }));
  return app;
}

/** Returns the 5 inserted rows' ids, in insertion order — Story 2.3's
 * status tests need to target a specific idea by id. */
async function insertFiveIdeas(userId: string): Promise<string[]> {
  const rows = await db
    .insert(ideas)
    .values(
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
    )
    .returning({ id: ideas.id });
  return rows.map((row) => row.id);
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

  // AC5 (Story 2.8): `hasPlan` is a derived, read-only join against the
  // `plans` table — true for an idea with an existing plan row, false for
  // one without.
  it('reports hasPlan: true for an idea with an existing plan row, and false for one without', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      await db.insert(plans).values({ ideaId: ids[0]!, userId, threadId: `plan:${randomUUID()}` });

      const res = await request(buildTestApp(fakeAgent(), userId)).get('/api/ideas');

      expect(res.status).toBe(200);
      const hasPlanById = new Map(res.body.ideas.map((idea: { id: string; hasPlan: boolean }) => [idea.id, idea.hasPlan]));
      expect(hasPlanById.get(ids[0]!)).toBe(true);
      expect(hasPlanById.get(ids[1]!)).toBe(false);
    } finally {
      await db.delete(plans).where(eq(plans.userId, userId));
      await cleanUp(userId);
    }
  });
});

describe('createIdeasRouter POST /generate', () => {
  // I/O matrix: "Happy path" -> 5 ideas returned, 200. Story 2.10 (AC1): no
  // `agent.invoke` at all anymore — `handleGenerateIdeas` is called
  // directly, with `generateDrafts` as the test-only seam replacing the real
  // nested-agent call (same DI precedent as `generate_ideas.test.ts`).
  it('returns the 5 newly generated ideas, calling handleGenerateIdeas directly (no agent.invoke)', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const generateDrafts = fakeGenerateDrafts(intakeRow);
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, userId, { generateDrafts })).post('/api/ideas/generate');

      expect(res.status).toBe(200);
      expect(res.body.ideas).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(5); // one call per idea, in parallel
      // AC1: no `agent.invoke` anywhere in this route anymore.
      expect(agent.invoke).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.4 AC1: a regenerate appends a new 5 to the existing batch in
  // one transaction (`generate_ideas.ts`'s own real insert-only write — now
  // exercised directly, not simulated by a fake agent) — proving the route
  // reports success from entirely new ids on top of (not replacing) the old
  // ones, via the all-statuses before/after id-set diff.
  it('reports success and returns the appended batch when regenerating, keeping the old suggested batch', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const oldIds = await insertFiveIdeas(userId);
      const generateDrafts = fakeGenerateDrafts(intakeRow, 'New');

      const res = await request(buildTestApp(fakeAgent(), userId, { generateDrafts })).post('/api/ideas/generate');

      expect(res.status).toBe(200);
      // Story 2.4: nothing is deleted — the response is the full visible
      // list, old (5) + new (5).
      expect(res.body.ideas).toHaveLength(10);
      const returnedIds = res.body.ideas.map((idea: { id: string }) => idea.id);
      expect(oldIds.every((id) => returnedIds.includes(id))).toBe(true);
      const newIds = returnedIds.filter((id: string) => !oldIds.includes(id));
      expect(newIds).toHaveLength(5);
    } finally {
      await cleanUp(userId);
    }
  });

  // Bug fix (user-reported): this response replaces the client's entire
  // `ideas` list, so a previously-rejected idea (persisted, never deleted —
  // epics.md's own "kept, not repeated" rule for bookmarked/rejected ideas
  // across a regenerate) must stay excluded here exactly like it is from
  // `GET /`, never reappearing just because a new batch was generated.
  it('excludes a previously-rejected idea from the regenerated response, keeping a bookmarked one', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const ids = await insertFiveIdeas(userId);
      await db.update(ideas).set({ status: 'rejected' }).where(eq(ideas.id, ids[0]!));
      await db.update(ideas).set({ status: 'bookmarked' }).where(eq(ideas.id, ids[1]!));
      const generateDrafts = fakeGenerateDrafts(intakeRow, 'New');

      const res = await request(buildTestApp(fakeAgent(), userId, { generateDrafts })).post('/api/ideas/generate');

      expect(res.status).toBe(200);
      const returnedIds = res.body.ideas.map((idea: { id: string }) => idea.id);
      expect(returnedIds).not.toContain(ids[0]); // rejected — stays hidden
      expect(returnedIds).toContain(ids[1]); // bookmarked — stays visible
      // Story 2.4: insert-only — the 3 still-suggested old ideas (ids[2-4])
      // also survive, on top of (not instead of) the 5 new ones.
      expect(res.body.ideas).toHaveLength(9); // 1 bookmarked + 3 old suggested + 5 new suggested
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "No intake row" -> generic error, zero rows ever reported as
  // success — `handleGenerateIdeas` throws before `generateDrafts` is ever
  // called (same before/after guard precedent as `intake.ts`'s POST /,
  // adapted to a row-count check).
  it('returns a generic error and persists nothing when there is no intake row', async () => {
    const userId = await createTestUser();
    try {
      const res = await request(buildTestApp(fakeAgent(), userId)).post('/api/ideas/generate');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.7 (AC4): the button's own explicit `language` wins outright,
  // never overridden by the (unmocked, thus always-fallback-'en')
  // discovery-thread detection. Story 2.10: checked via the `generateDrafts`
  // seam's own `replyLanguage` argument instead of an `agent.invoke` message.
  it('passes an explicit request-body language straight through as replyLanguage, skipping detection', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const generateDrafts = fakeGenerateDrafts(intakeRow);

      await request(buildTestApp(fakeAgent(), userId, { generateDrafts })).post('/api/ideas/generate').send({ language: 'de' });

      // Story 2.4: a 4th `{ excludeTitles }` argument is now always passed
      // too (empty here — this user has no existing ideas yet).
      expect(generateDrafts).toHaveBeenCalledWith(
        expect.objectContaining({ id: intakeRow.id }),
        'de',
        expect.any(AbortSignal),
        expect.objectContaining({ excludeTitles: [] }),
      );
    } finally {
      await cleanUp(userId);
    }
  });

  // Addition 2 (fail-fast): every web_search call this round failed ->
  // a distinct 503/`search_unavailable` response, never the generic 502 —
  // and the pre-existing `suggested` batch is left completely untouched
  // (no delete, no insert — `handleGenerateIdeas` throws this before its DB
  // transaction). Story 2.6 AC3 ("the user's counted generation for that
  // day is refunded"): the attempt was already counted at entry
  // (`incrementAndGetUserGenerationCount`, before `handleGenerateIdeas`
  // runs) — this proves `refundUserGeneration` actually gives it back,
  // not just that the route calls it.
  it('returns 503 with search_unavailable, leaves existing suggested ideas unchanged, and refunds the counted generation', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, intakeArgs());
      const existingIds = await insertFiveIdeas(userId);
      const existingRowsBefore = await db.select().from(ideas).where(eq(ideas.userId, userId));
      const countBefore = await getUserGenerationCount(db, userId);
      const generateDrafts = vi.fn().mockRejectedValue(new SearchServiceUnavailableError('generate_ideas: every web_search call in this round failed'));

      const res = await request(buildTestApp(fakeAgent(), userId, { generateDrafts })).post('/api/ideas/generate');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'search_unavailable' });
      const existingRowsAfter = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(existingRowsAfter).toEqual(existingRowsBefore);
      expect(existingRowsAfter.map((row) => row.id).sort()).toEqual(existingIds.sort());
      const countAfter = await getUserGenerationCount(db, userId);
      expect(countAfter).toBe(countBefore);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.11 AC5/AC6: "the route returns a clear 429-style response the UI
// turns into the message" — the server enforces the limit itself, never
// relying on the UI's own disabled button, and reports which of the two
// reasons applies.
describe('createIdeasRouter POST /generate (Story 2.11: limits)', () => {
  it.each([
    { case: 'the shared daily search budget is already used up', envOverride: { DAILY_SEARCH_BUDGET: 0 }, expectedReason: 'shared_budget' },
    { case: "the user's own daily generation limit is already reached", envOverride: { DAILY_GENERATIONS_PER_USER: 0 }, expectedReason: 'user_limit' },
  ])('returns 429 with reason "$expectedReason" when $case', async ({ envOverride, expectedReason }) => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent({ invoke: vi.fn() });

      const res = await request(buildTestApp(agent, userId, { env: { ...testEnv, ...envOverride } })).post('/api/ideas/generate');

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'limit_reached', reason: expectedReason });
      expect(res.body.resetsAt).toEqual(expect.any(String));
      // The agent is never even invoked — the server gates before doing any
      // of the real (cost-bearing) work.
      expect(agent.invoke).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.11 AC5: the generate button must be disabled *before* the user
// ever clicks it — `GET /` reflects the same blocked state read-only.
describe('createIdeasRouter GET / (Story 2.11: generateLimit)', () => {
  it('reports generateLimit.blocked when the per-user daily limit is already reached, without incrementing anything', async () => {
    const userId = await createTestUser();
    try {
      await incrementAndGetUserGenerationCount(db, userId);
      const agent = fakeAgent();
      const res = await request(buildTestApp(agent, userId, { env: { ...testEnv, DAILY_GENERATIONS_PER_USER: 1 } })).get('/api/ideas');

      expect(res.status).toBe(200);
      expect(res.body.generateLimit).toMatchObject({ blocked: true, reason: 'user_limit', limit: 1 });
    } finally {
      await cleanUp(userId);
    }
  });

  it('reports generateLimit.blocked: false under the generous default limits', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent();
      const res = await request(buildTestApp(agent, userId)).get('/api/ideas');

      expect(res.status).toBe(200);
      expect(res.body.generateLimit).toEqual({ blocked: false, reason: null, limit: null, resetsAt: null });
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createIdeasRouter POST /translate', () => {
  // AC1/AC2: a translation of the caller's own ideas, persisted and
  // returned — via the injectable `translateIdeaCards` seam (the real
  // implementation's own model/moderation/cache behavior has its own
  // dedicated test suite in `src/agent/translate-idea-cards.test.ts`).
  it('returns the translations produced by translateIdeaCards for the caller’s own idea ids', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      const translateIdeaCards = vi.fn().mockResolvedValue([
        { ideaId: ids[0], language: 'de', title: 'DE Titel', rationale: 'Zeile 1.\nZeile 2.', demandEvidenceNote: null, growthPath: null },
      ]);

      const res = await request(buildTestApp(fakeAgent(), userId, { translateIdeaCards }))
        .post('/api/ideas/translate')
        .send({ ideaIds: [ids[0]], language: 'de' });

      expect(res.status).toBe(200);
      expect(res.body.translations).toEqual([
        { ideaId: ids[0], language: 'de', title: 'DE Titel', rationale: 'Zeile 1.\nZeile 2.', demandEvidenceNote: null, growthPath: null },
      ]);
      expect(translateIdeaCards).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        [ids[0]],
        'de',
        expect.any(AbortSignal),
      );
    } finally {
      await cleanUp(userId);
    }
  });

  // Security-relevant failure branch: a foreign idea id must never be
  // translated or leak whether it exists — same 404 vocabulary as
  // `POST /:id/status`'s own ownership check.
  it('returns 404 and never calls translateIdeaCards when an idea id is not owned by the caller', async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    try {
      await insertFiveIdeas(userId);
      const otherIds = await insertFiveIdeas(otherUserId);
      const translateIdeaCards = vi.fn();

      const res = await request(buildTestApp(fakeAgent(), userId, { translateIdeaCards }))
        .post('/api/ideas/translate')
        .send({ ideaIds: [otherIds[0]], language: 'de' });

      expect(res.status).toBe(404);
      expect(translateIdeaCards).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
      await cleanUp(otherUserId);
    }
  });

  // I/O matrix: "Failure/abort/moderation-reject persists nothing" surfaces
  // to the client as a generic error, same vocabulary as POST /generate's
  // own failure path.
  it('returns 502 when translateIdeaCards fails (timeout, abort, or moderation reject)', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      const translateIdeaCards = vi.fn().mockRejectedValue(new Error('translate_idea_cards: moderation rejected the translated batch'));

      const res = await request(buildTestApp(fakeAgent(), userId, { translateIdeaCards }))
        .post('/api/ideas/translate')
        .send({ ideaIds: [ids[0]], language: 'de' });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: expect.any(String) });
    } finally {
      await cleanUp(userId);
    }
  });

  // Input-validation failure branch: an empty/malformed body never reaches
  // the ownership check or translateIdeaCards at all.
  it('returns 400 for a malformed body (no ideaIds)', async () => {
    const userId = await createTestUser();
    try {
      const translateIdeaCards = vi.fn();
      const res = await request(buildTestApp(fakeAgent(), userId, { translateIdeaCards }))
        .post('/api/ideas/translate')
        .send({ language: 'de' });

      expect(res.status).toBe(400);
      expect(translateIdeaCards).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createIdeasRouter POST /:id/status', () => {
  // AC1: selecting one idea marks it `selected`, every *other* idea owned
  // by the same user that isn't already `rejected` defaults to `bookmarked`,
  // and an idea already `rejected` is never resurrected by someone else
  // being selected (real-Postgres integration test, per CLAUDE.md's own
  // "one active plan per user"-style precedent for this transaction).
  it('selects the target idea, demotes the other non-rejected ideas to bookmarked, and preserves an existing reject', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      await db.update(ideas).set({ status: 'rejected' }).where(eq(ideas.id, ids[2]!));

      const res = await request(buildTestApp(fakeAgent(), userId))
        .post(`/api/ideas/${ids[0]}/status`)
        .send({ status: 'selected' });

      expect(res.status).toBe(204);
      const rows = await db.select({ id: ideas.id, status: ideas.status }).from(ideas).where(eq(ideas.userId, userId));
      const statusById = new Map(rows.map((row) => [row.id, row.status]));
      expect(statusById.get(ids[0]!)).toBe('selected');
      expect(statusById.get(ids[1]!)).toBe('bookmarked');
      expect(statusById.get(ids[2]!)).toBe('rejected'); // preserved, not resurrected
      expect(statusById.get(ids[3]!)).toBe('bookmarked');
      expect(statusById.get(ids[4]!)).toBe('bookmarked');
    } finally {
      await cleanUp(userId);
    }
  });

  // User-reported bug fix: selecting an idea must not rewrite a sibling
  // that's already `bookmarked` — only a genuine status change touches a
  // row (and bumps its `updatedAt`). Re-selecting after switching away and
  // back previously re-swept every already-bookmarked sibling on every
  // call, which is what made their buttons visibly flicker client-side.
  it('does not rewrite (or touch the updatedAt of) a sibling that is already bookmarked when selecting again', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      const app = buildTestApp(fakeAgent(), userId);

      await request(app).post(`/api/ideas/${ids[0]}/status`).send({ status: 'selected' }); // first select: sweeps 1-4 to bookmarked
      const [beforeSibling] = await db.select({ updatedAt: ideas.updatedAt }).from(ideas).where(eq(ideas.id, ids[1]!));

      await request(app).post(`/api/ideas/${ids[0]}/status`).send({ status: 'bookmarked' }); // switch away
      const res = await request(app).post(`/api/ideas/${ids[0]}/status`).send({ status: 'selected' }); // select again
      expect(res.status).toBe(204);

      const [afterSibling] = await db.select({ updatedAt: ideas.updatedAt }).from(ideas).where(eq(ideas.id, ids[1]!));
      expect(afterSibling!.updatedAt.getTime()).toBe(beforeSibling!.updatedAt.getTime());
    } finally {
      await cleanUp(userId);
    }
  });

  // AC3/AC5: rejecting a bookmarked idea hides it from this and every later
  // `GET /` response — persisted server-side (a status change, not a
  // delete), not just removed from client-side state.
  it('rejecting an idea hides it from GET / immediately and after a later reload-style GET', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      const app = buildTestApp(fakeAgent(), userId);

      const rejectRes = await request(app).post(`/api/ideas/${ids[1]}/status`).send({ status: 'rejected' });
      expect(rejectRes.status).toBe(204);

      const firstGet = await request(app).get('/api/ideas');
      expect(firstGet.body.ideas).toHaveLength(4);
      expect(firstGet.body.ideas.map((idea: { id: string }) => idea.id)).not.toContain(ids[1]);

      // A second, independent GET ("reload") proves this is a persisted DB
      // status, not something only removed from an in-memory response.
      const secondGet = await request(app).get('/api/ideas');
      expect(secondGet.body.ideas.map((idea: { id: string }) => idea.id)).not.toContain(ids[1]);
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Unknown or foreign idea id" -> 404, no row changes —
  // `IdeaNotFoundError` is the same failure branch for either cause.
  it.each([
    { label: 'an id that does not exist', pickTargetId: () => randomUUID() },
    { label: 'an id owned by a different user', pickTargetId: (otherIds: string[]) => otherIds[0]! },
  ])('returns 404 and makes no row changes for $label', async ({ pickTargetId }) => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    try {
      await insertFiveIdeas(userId);
      const otherIds = await insertFiveIdeas(otherUserId);
      const targetId = pickTargetId(otherIds);

      const res = await request(buildTestApp(fakeAgent(), userId)).post(`/api/ideas/${targetId}/status`).send({ status: 'selected' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
      const ownRows = await db.select({ status: ideas.status }).from(ideas).where(eq(ideas.userId, userId));
      expect(ownRows.every((row) => row.status === 'suggested')).toBe(true);
    } finally {
      await cleanUp(userId);
      await cleanUp(otherUserId);
    }
  });

  // A rejected idea is never resurrected — including by a direct request
  // targeting its own id (not just as a side effect of selecting a
  // different idea, already covered above).
  it('returns 404 and makes no row changes when directly re-targeting an already-rejected idea with a non-reject status', async () => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      await db.update(ideas).set({ status: 'rejected' }).where(eq(ideas.id, ids[0]!));

      const res = await request(buildTestApp(fakeAgent(), userId)).post(`/api/ideas/${ids[0]}/status`).send({ status: 'selected' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select({ id: ideas.id, status: ideas.status }).from(ideas).where(eq(ideas.userId, userId));
      expect(rows.find((row) => row.id === ids[0])?.status).toBe('rejected');
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Invalid status value" -> 400, no row changes — garbage
  // body and a malformed id are both input-validation failures rejected
  // before `setIdeaStatus` ever runs.
  it.each([
    {
      label: 'an invalid status value',
      send: (app: ReturnType<typeof buildTestApp>, id: string) => request(app).post(`/api/ideas/${id}/status`).send({ status: 'suggested' }),
    },
    {
      label: 'a non-UUID id',
      send: (app: ReturnType<typeof buildTestApp>) => request(app).post('/api/ideas/not-a-uuid/status').send({ status: 'selected' }),
    },
  ])('returns 400 and makes no row changes for $label', async ({ send }) => {
    const userId = await createTestUser();
    try {
      const ids = await insertFiveIdeas(userId);
      const app = buildTestApp(fakeAgent(), userId);

      const res = await send(app, ids[0]!);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select({ status: ideas.status }).from(ideas).where(eq(ideas.userId, userId));
      expect(rows.every((row) => row.status === 'suggested')).toBe(true);
    } finally {
      await cleanUp(userId);
    }
  });
});
