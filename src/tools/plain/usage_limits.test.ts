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
  isUnlimitedUserEmail,
  isUnlimitedUser,
} from './usage_limits.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function createTestUser(email?: string): Promise<string> {
  const googleId = `test-${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ googleId, email: email ?? `${googleId}@example.com`, name: 'Test User', picture: null })
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

// Story 2.11 follow-up: owner exemption from the per-user daily generation
// limit only — a trimmed, case-insensitive match against a comma-separated
// list, nobody exempt by default.
describe('isUnlimitedUserEmail (Story 2.11 follow-up)', () => {
  it.each([
    ['a listed email', 'example@example.com', 'example@example.com', true],
    ['the same email in different case/whitespace', 'Example@Example.com', ' example@example.com, other@example.com ', true],
    ['an unlisted email', 'someone-else@example.com', 'example@example.com', false],
    ['an empty list', 'example@example.com', '', false],
  ])('%s -> %s', (_case, email, unlimitedUserEmails, expected) => {
    expect(isUnlimitedUserEmail(email, unlimitedUserEmails)).toBe(expected);
  });
});

// Story 2.11 follow-up: the exemption applies *only* to the per-user daily
// generation check — the shared search budget is global, keyed by UTC date
// alone (never by user), so it is structurally unaffected by any per-user
// exemption and still blocks a listed user exactly like anyone else.
describe('isUnlimitedUser (Story 2.11 follow-up): shared budget still blocks a listed user', () => {
  it('a listed user is exempt from their own daily limit but not from the shared search budget', async () => {
    const userId = await createTestUser('example@example.com');
    const env = { UNLIMITED_USER_EMAILS: 'example@example.com' };
    const now = new Date('2099-07-01T00:00:00.000Z');

    expect(await isUnlimitedUser(db, userId, env)).toBe(true);

    // The shared counter has no concept of "user" at all — exhausting it
    // blocks every subsequent search regardless of who's asking, listed or
    // not (enforced one level up, in src/agent/web-search-budget-guard.ts,
    // by comparing this same count against DAILY_SEARCH_BUDGET).
    const budgetLimit = 2;
    await incrementAndGetSearchBudgetCount(db, now);
    await incrementAndGetSearchBudgetCount(db, now);
    const sharedSearchesUsed = await getSearchBudgetCount(db, now);

    expect(sharedSearchesUsed).toBeGreaterThanOrEqual(budgetLimit);

    await db.delete(searchBudgetCounts).where(eq(searchBudgetCounts.date, getUtcDateKey(now)));
    await db.delete(users).where(eq(users.id, userId));
  });
});
