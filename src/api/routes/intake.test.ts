import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs, FailurePattern } from '@app/shared';
import { createIntakeRouter, type IntakeRouterDeps } from './intake.js';
import { createDb } from '../../db/client.js';
import { users, intake } from '../../db/schema/index.js';
import { upsertIntake } from '../../tools/plain/submit_intake.js';
import type { ClassifyText } from '../../agent/moderation.js';

const testEnv: IntakeRouterDeps['env'] = {
  RATE_LIMIT_WINDOW_MS: 60_000,
  OPENROUTER_API_KEY: 'test-key',
  MISTRAL_API_KEY: 'test-key',
};

/**
 * Runs against real Postgres (same pattern as `auth.test.ts`).
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
    country: 'DE',
  };
}

function toolArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return { ...validBody(), failurePattern: 'overwhelm', ...overrides } as SubmitIntakeToolArgs;
}

/** Story 2.10: no more `fakeAgent` — the route calls `classifyFailurePattern`/
 * `classify` directly, never an agent. Default fakes resolve immediately so
 * a test that doesn't care about classification/moderation behavior doesn't
 * need to supply either. */
function fakeClassify(failurePattern: FailurePattern = 'overwhelm'): NonNullable<IntakeRouterDeps['classifyFailurePattern']> {
  return vi.fn().mockResolvedValue(failurePattern);
}

function fakeModeration(action: 'pass' | 'reject' | 'redact' = 'pass'): ClassifyText {
  return vi.fn().mockResolvedValue(
    action === 'reject' ? { jailbreaking: true } : action === 'redact' ? { pii: true } : {},
  );
}

/** Same minimal in-memory-session app shape as `chat.test.ts`/`auth.test.ts`
 * — the router relies entirely on the blanket `requireAuth` gate, so this
 * pre-authenticates the session directly rather than exercising OAuth. */
function buildTestApp(userId: string, overrides: Partial<IntakeRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use(
    '/api/intake',
    createIntakeRouter({
      env: testEnv,
      db,
      classifyFailurePattern: fakeClassify(),
      classify: fakeModeration(),
      ...overrides,
    }),
  );
  return app;
}

describe('createIntakeRouter GET /', () => {
  // I/O matrix: "No intake yet" -> "App renders the intake form, blank".
  it('returns intake: null when the signed-in user has no row yet', async () => {
    const userId = await createTestUser();
    try {
      const res = await request(buildTestApp(userId)).get('/api/intake');

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

      const res = await request(buildTestApp(userId)).get('/api/intake');

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
  // before any write or classify/moderate call" -> "400, generic error body".
  it('rejects a submission missing a field with 400 and never calls classify or moderation', async () => {
    const userId = await createTestUser();
    try {
      const classifyFailurePattern = fakeClassify();
      const classify = fakeModeration();
      const incomplete: Record<string, string> = { ...validBody() };
      delete incomplete.riskTolerance;

      const res = await request(buildTestApp(userId, { classifyFailurePattern, classify }))
        .post('/api/intake')
        .send(incomplete);

      expect(res.status).toBe(400);
      expect(classifyFailurePattern).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });

  // AC2/AC3/AC6: a valid first submit classifies `failurePattern` directly
  // (no agent), moderates both free-text fields in one combined call, and
  // persists — 200 + record returned.
  it('persists the record and returns it, classifying failurePattern directly', async () => {
    const userId = await createTestUser();
    try {
      const classifyFailurePattern = fakeClassify('overwhelm');

      const res = await request(buildTestApp(userId, { classifyFailurePattern }))
        .post('/api/intake')
        .send(validBody());

      expect(res.status).toBe(200);
      expect(res.body.intake).toMatchObject(validBody());
      expect(res.body.intake.failurePattern).toBe('overwhelm');
      expect(classifyFailurePattern).toHaveBeenCalledWith(expect.anything(), validBody().stoppedBeforeText, expect.any(AbortSignal));
    } finally {
      await cleanUp(userId);
    }
  });

  // AC2: classification and moderation must run in parallel, never
  // sequenced — proven by recording the order each resolves relative to the
  // other rather than trusting call order alone.
  it('runs classify and moderation concurrently, not sequenced', async () => {
    const userId = await createTestUser();
    try {
      const order: string[] = [];
      const classifyFailurePattern: IntakeRouterDeps['classifyFailurePattern'] = vi.fn().mockImplementation(async () => {
        order.push('classify-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('classify-end');
        return 'overwhelm';
      });
      const classify: ClassifyText = vi.fn().mockImplementation(async () => {
        order.push('moderate-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('moderate-end');
        return {};
      });

      const res = await request(buildTestApp(userId, { classifyFailurePattern, classify }))
        .post('/api/intake')
        .send(validBody());

      expect(res.status).toBe(200);
      // Both must have started before either finished.
      expect(order.slice(0, 2).sort()).toEqual(['classify-start', 'moderate-start']);
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Jailbreak-flagged free text" -> no row written/changed ->
  // the same generic 502 the old "tool never called" path already returned.
  it('rejects with a generic 502 and writes nothing when either free-text field flags jailbreaking', async () => {
    const userId = await createTestUser();
    try {
      const classify = fakeModeration('reject');

      const res = await request(buildTestApp(userId, { classify })).post('/api/intake').send(validBody());

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Intake could not be saved' });
      const rows = await db.select().from(intake).where(eq(intake.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "PII-flagged free text" -> redacted fields stored (per-field
  // `redactPii`) -> save continues, 200, redacted text persisted.
  it('redacts PII independently per field and still saves, 200', async () => {
    const userId = await createTestUser();
    try {
      const classify = fakeModeration('redact');
      const body = { ...validBody(), skillsInterests: 'Email me at test@example.com', stoppedBeforeText: 'Call 555-123-4567 please' };

      const res = await request(buildTestApp(userId, { classify })).post('/api/intake').send(body);

      expect(res.status).toBe(200);
      expect(res.body.intake.skillsInterests).toBe('Email me at [redacted-email]');
      expect(res.body.intake.stoppedBeforeText).toContain('[redacted-number]');
    } finally {
      await cleanUp(userId);
    }
  });

  // I/O matrix: "Agent doesn't call the tool" equivalent — any failure in
  // the classify/moderate/persist path is a generic error, no partial row
  // ever reported as success.
  it('returns a generic error and saves nothing when classification fails', async () => {
    const userId = await createTestUser();
    try {
      const classifyFailurePattern: IntakeRouterDeps['classifyFailurePattern'] = vi.fn().mockRejectedValue(new Error('model down'));

      const res = await request(buildTestApp(userId, { classifyFailurePattern })).post('/api/intake').send(validBody());

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: expect.any(String) });
      const rows = await db.select().from(intake).where(eq(intake.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.2 round 10 (open item, user-approved): `failurePattern` is only
  // ever re-derived from `stoppedBeforeText` — an unchanged value means
  // there's nothing for a model to decide, so this is an instant save, no
  // classify/moderate call at all. A changed weeklyTimeAvailability is still
  // persisted; the stored failurePattern is reused, not re-classified.
  it('saves instantly, without classifying or moderating, when stoppedBeforeText is unchanged', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, toolArgs({ failurePattern: 'life_disruption' }));
      const classifyFailurePattern = fakeClassify();
      const classify = fakeModeration();

      const res = await request(buildTestApp(userId, { classifyFailurePattern, classify }))
        .post('/api/intake')
        .send({ ...validBody(), weeklyTimeAvailability: '20h_plus' });

      expect(res.status).toBe(200);
      expect(res.body.intake.weeklyTimeAvailability).toBe('20h_plus');
      // Reused from the stored row, never re-classified.
      expect(res.body.intake.failurePattern).toBe('life_disruption');
      expect(classifyFailurePattern).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await cleanUp(userId);
    }
  });
});
