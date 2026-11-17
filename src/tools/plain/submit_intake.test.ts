import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake } from '../../db/schema/index.js';
import { buildDiscoveryThreadId, buildIntakeTriggerThreadId } from '../../agent/index.js';
import {
  deriveUserIdFromThreadId,
  getIntakeByUserId,
  handleSubmitIntake,
  upsertIntake,
  type SubmitIntakeToolRunConfig,
} from './submit_intake.js';

function intakeArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return {
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
    country: 'DE',
    failurePattern: 'overwhelm',
    ...overrides,
  };
}

// AD-18/Boundary: "userId is derived server-side from the session-rooted
// thread id — never trusted as a model-supplied tool argument". Deterministic
// unit test over the pure derivation function, no DB/LLM involved.
describe('deriveUserIdFromThreadId (AD-18/Boundary: userId derivation)', () => {
  it.each([
    ['discovery:user-123', 'user-123'],
    // Story 2.2 follow-up fix round 3, fix 1: `intake.ts` now invokes the
    // agent on this internal-only thread, never `discovery:`.
    ['intake-trigger:user-123', 'user-123'],
    ['discovery:', undefined],
    ['plan:abc', undefined],
    [undefined, undefined],
  ] as const)('derives %j -> %j', (threadId, expected) => {
    expect(deriveUserIdFromThreadId(threadId)).toBe(expected);
  });

  // Pins the round-trip with `buildDiscoveryThreadId`/`buildIntakeTriggerThreadId`
  // (`src/agent/index.ts`) directly: `deriveUserIdFromThreadId` is a
  // hand-duplicated inverse of those functions (Code Map), so a future
  // change to either thread-id format should fail this test rather than
  // silently breaking every intake submission.
  it.each([
    ['buildDiscoveryThreadId', buildDiscoveryThreadId],
    ['buildIntakeTriggerThreadId', buildIntakeTriggerThreadId],
  ] as const)('round-trips with %s', (_name, buildThreadId) => {
    const userId = randomUUID();
    expect(deriveUserIdFromThreadId(buildThreadId(userId))).toBe(userId);
  });
});

// Security-relevant failure branch, distinct from the derivation case above:
// a thread id that isn't a discovery thread must never let a write through,
// even with otherwise-valid args (AD-4: deterministic plain-code tool).
describe('handleSubmitIntake (AD-4: no write without a derivable userId)', () => {
  it('throws and never touches the db when no userId is derivable from the thread id', async () => {
    const db = {} as never;
    const config: SubmitIntakeToolRunConfig = { configurable: { thread_id: 'not-a-discovery-thread' } };

    await expect(handleSubmitIntake(db, config, intakeArgs())).rejects.toThrow(/userId/);
  });
});

/**
 * Integration test against real Postgres (CLAUDE.md: "one integration test
 * against real Postgres only for DB constraints"). Same DATABASE_URL
 * fallback and cleanup pattern as `src/db/auth-repository.test.ts`.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function cleanUp(userId: string) {
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// I/O matrix: "Resubmit with changed values" -> "Same row updated in place
// (upsert by userId), never a second row".
describe('upsertIntake (integration, real Postgres)', () => {
  it('updates the same row in place on a second submission, never inserting a second one', async () => {
    const googleId = `test-${randomUUID()}`;
    const [user] = await db
      .insert(users)
      .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
      .returning();
    const userId = user!.id;

    try {
      const first = await upsertIntake(db, userId, intakeArgs());
      const second = await upsertIntake(
        db,
        userId,
        intakeArgs({ riskTolerance: 'high', failurePattern: 'life_disruption' }),
      );

      expect(second.id).toBe(first.id);
      expect(second.riskTolerance).toBe('high');
      expect(second.failurePattern).toBe('life_disruption');

      const rows = await db.select().from(intake).where(eq(intake.userId, userId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanUp(userId);
    }
  });

  // Story 2.5 (narrowed post-handoff, user-directed): `country` dropped
  // `CH`/`GB` after this story had already shipped — the column is plain
  // `text()` with no DB-level check constraint, so an old row can still
  // hold one. `getIntakeByUserId` must normalize it to `'other'`, never
  // throw (which would 503 `GET /api/intake` for that user forever).
  it('reads a legacy row whose stored country is no longer a valid option as "other", without throwing', async () => {
    const googleId = `test-${randomUUID()}`;
    const [user] = await db
      .insert(users)
      .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
      .returning();
    const userId = user!.id;

    try {
      await upsertIntake(db, userId, intakeArgs());
      // Simulate a legacy row: bypass the Zod schema entirely, writing a raw
      // value the enum no longer accepts (same as a real pre-narrowing row).
      await db.update(intake).set({ country: 'CH' }).where(eq(intake.userId, userId));

      const record = await getIntakeByUserId(db, userId);

      expect(record?.country).toBe('other');
    } finally {
      await cleanUp(userId);
    }
  });
});
