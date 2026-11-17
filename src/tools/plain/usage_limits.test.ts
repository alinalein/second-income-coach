import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { users, userGenerationCounts, searchBudgetCounts } from '../../db/schema/index.js';
import {
  getUtcDateKey,
  getUserGenerationCount,
  incrementAndGetUserGenerationCount,
  getSearchBudgetCount,
  incrementAndGetSearchBudgetCount,
} from './usage_limits.js';

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

// Story 2.11 AC7: "the per-user generations per day and the shared daily
// search budget ... the counters live in Postgres and reset at a fixed
// time." One real-Postgres integration test (CLAUDE.md) exercising the
// actual DB constraint each counter relies on: `incrementAndGet*` must be
// a correct atomic upsert against the unique (user_id, date) / date index,
// not just correct application logic over a fake.
describe('usage_limits (Story 2.11 AC7: Postgres-backed daily counters)', () => {
  it('atomically upserts the per-user daily counter against its (user_id, date) unique constraint', async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const now = new Date('2026-01-15T12:00:00.000Z');

    expect(await getUserGenerationCount(db, userId, now)).toBe(0);

    expect(await incrementAndGetUserGenerationCount(db, userId, now)).toBe(1);
    expect(await incrementAndGetUserGenerationCount(db, userId, now)).toBe(2);
    expect(await incrementAndGetUserGenerationCount(db, userId, now)).toBe(3);

    // Never shared across users — a different user's row is independent.
    expect(await getUserGenerationCount(db, otherUserId, now)).toBe(0);

    // A new UTC day is a new row starting at 0 — the "reset" (AC7) is
    // implicit, not a separate migration/job.
    const nextDay = new Date('2026-01-16T00:00:01.000Z');
    expect(await getUserGenerationCount(db, userId, nextDay)).toBe(0);

    await db.delete(userGenerationCounts).where(eq(userGenerationCounts.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  it('atomically upserts the shared daily search-budget counter, scoped by UTC date only', async () => {
    const date = getUtcDateKey(new Date('2099-06-01T08:00:00.000Z'));
    const now = new Date('2099-06-01T08:00:00.000Z');

    expect(await getSearchBudgetCount(db, now)).toBe(0);
    expect(await incrementAndGetSearchBudgetCount(db, now)).toBe(1);
    expect(await incrementAndGetSearchBudgetCount(db, now)).toBe(2);
    expect(await getSearchBudgetCount(db, now)).toBe(2);

    await db.delete(searchBudgetCounts).where(eq(searchBudgetCounts.date, date));
  });
});
