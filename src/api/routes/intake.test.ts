import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createIntakeRouter, type IntakeRouterDeps } from './intake.js';
import { createDb } from '../../db/client.js';
import { users, intake } from '../../db/schema/index.js';
import { upsertIntake } from '../../tools/plain/submit_intake.js';

const testEnv: IntakeRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000 };

type FakeAgent = IntakeRouterDeps['agent'];

/**
 * Runs against real Postgres (same pattern as `auth.test.ts`): the `intake`
 * row's `userId` is a `NOT NULL` FK to `users`, and this file's "agent
 * actually ran" tests simulate the tool's effect by calling the real
 * `upsertIntake` from a fake `agent.invoke`, so a real `users` row and real
 * db reads are needed either way.
 */
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
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function validBody() {
  return {
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
  };
}

function toolArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return { ...validBody(), failurePattern: 'overwhelm', ...overrides } as SubmitIntakeToolArgs;
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    invoke: vi.fn(),
    getState: vi.fn(),
    ...overrides,
  } as unknown as FakeAgent;
}

/** Same minimal in-memory-session app shape as `chat.test.ts`/`auth.test.ts`
 * — the router relies entirely on the blanket `requireAuth` gate, so this
 * pre-authenticates the session directly rather than exercising OAuth. */
function buildTestApp(agent: FakeAgent, userId: string) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/intake', createIntakeRouter({ env: testEnv, db, agent }));
  return app;
}

describe('createIntakeRouter GET /', () => {
  // I/O matrix: "No intake yet" -> "App renders the intake form, blank".
  it('returns intake: null when the signed-in user has no row yet', async () => {
    const userId = await createTestUser();
    try {
      const res = await request(buildTestApp(fakeAgent(), userId)).get('/api/intake');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ intake: null });
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Revisit with existing intake" -> "Form renders prefilled
  // from the saved record" (AC5).
  it('returns the saved record to prefill on revisit', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, toolArgs());

      const res = await request(buildTestApp(fakeAgent(), userId)).get('/api/intake');

      expect(res.status).toBe(200);
      expect(res.body.intake).toMatchObject(validBody());
      expect(res.body.intake.failurePattern).toBe('overwhelm');
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('createIntakeRouter POST /', () => {
  // I/O matrix: "Invalid/missing field" -> "Rejected at the Zod boundary
  // before any write or agent call" -> "400, generic error body".
  it('rejects a submission missing a field with 400 and never invokes the agent', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent();
      const incomplete: Record<string, string> = { ...validBody() };
      delete incomplete.riskTolerance;

      const res = await request(buildTestApp(agent, userId)).post('/api/intake').send(incomplete);

      expect(res.status).toBe(400);
      expect(agent.invoke).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Agent doesn't call the tool" -> "Row stays unchanged/
  // absent" -> "Generic error response, no partial row ever saved" —
  // distinct failure branch from the 400 case above (agent ran, but produced
  // no persisted effect).
  it('returns a generic error and saves nothing when the agent turn never calls submit_intake', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent({ invoke: vi.fn().mockResolvedValue({ messages: [] }) });

      const res = await request(buildTestApp(agent, userId)).post('/api/intake').send(validBody());

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select().from(intake).where(eq(intake.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });

  // Same I/O matrix row as above, but for the other half of the `before`/
  // `after` check this route does: an existing row that's left untouched
  // must generic-error too, not be silently reported as this submission's
  // result (the exact scenario `updatedAt`-comparison guards against).
  // `stoppedBeforeText` must differ from the existing row's (round 10's
  // instant-save fast path below takes over otherwise) — this test is
  // specifically exercising the *full agent path*'s failure handling.
  it('returns a generic error and leaves an existing row unchanged when the agent turn never calls submit_intake', async () => {
    const userId = await createTestUser();
    try {
      const existing = await upsertIntake(db, userId, toolArgs());
      const agent = fakeAgent({ invoke: vi.fn().mockResolvedValue({ messages: [] }) });
      const changedStoppedBefore = { ...validBody(), stoppedBeforeText: 'A different reason than before.' };

      const res = await request(buildTestApp(agent, userId)).post('/api/intake').send(changedStoppedBefore);

      expect(res.status).toBe(502);
      const [row] = await db.select().from(intake).where(eq(intake.userId, userId));
      expect(row?.updatedAt).toEqual(new Date(existing.updatedAt));
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Valid submission" -> "Agent classifies failurePattern, row
  // upserted, 200 + record returned" (AC2/AC3/AC6). The fake agent's
  // `invoke` stands in for the model turn by calling the real `upsertIntake`
  // itself — the tool call's own persistence behavior is covered directly by
  // `submit_intake.test.ts`.
  it('persists the record and returns it when the agent calls submit_intake', async () => {
    const userId = await createTestUser();
    try {
      const agent = fakeAgent({
        invoke: vi.fn().mockImplementation(async () => {
          await upsertIntake(db, userId, toolArgs());
          return { messages: [] };
        }),
      });

      const res = await request(buildTestApp(agent, userId)).post('/api/intake').send(validBody());

      expect(res.status).toBe(200);
      expect(res.body.intake).toMatchObject(validBody());
      expect(res.body.intake.failurePattern).toBe('overwhelm');
      // Story 2.2 follow-up fix round 3, fix 1: the trigger runs on the
      // internal-only `intake-trigger:` thread, never the user-visible
      // `discovery:` one — this is what keeps it out of
      // GET /api/chat/messages.
      expect(agent.invoke).toHaveBeenCalledWith(expect.anything(), {
        configurable: { thread_id: `intake-trigger:${userId}` },
      });
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.2 round 10 (open item, user-approved): `failurePattern` is only
  // ever re-derived from `stoppedBeforeText` — an unchanged value means
  // there's nothing for a model to decide, so this is an instant save, no
  // agent/model call at all. A changed weeklyTimeAvailability is still
  // persisted; the stored failurePattern is reused, not re-classified.
  it('saves instantly, without invoking the agent, when stoppedBeforeText is unchanged', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, toolArgs({ failurePattern: 'life_disruption' }));
      const agent = fakeAgent();

      const res = await request(buildTestApp(agent, userId))
        .post('/api/intake')
        .send({ ...validBody(), weeklyTimeAvailability: '20h_plus' });

      expect(res.status).toBe(200);
      expect(res.body.intake.weeklyTimeAvailability).toBe('20h_plus');
      // Reused from the stored row, never re-classified — the fake agent
      // (which would otherwise need to supply it) is never even invoked.
      expect(res.body.intake.failurePattern).toBe('life_disruption');
      expect(agent.invoke).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });
});
