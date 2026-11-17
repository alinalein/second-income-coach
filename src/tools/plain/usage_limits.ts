import { and, eq, sql } from 'drizzle-orm';
import type { createDb } from '../../db/client.js';
import { userGenerationCounts, searchBudgetCounts } from '../../db/schema/index.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Story 2.11 (AC7): "the counters live in Postgres and reset at a fixed
 * time" — a plain UTC calendar date string (`YYYY-MM-DD`). Reset is
 * implicit: a new UTC day is simply a row that doesn't exist yet, starting
 * at 0 — no cron/reset job needed.
 */
export function getUtcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** UTC midnight of the day after `now` — what the client shows as "resets
 * tomorrow at HH:MM" (AC5/AC6). */
export function getNextUtcResetIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

/** Read-only — used by `GET /api/ideas` (Story 2.11 AC5) to decide whether
 * to disable the generate button *before* the user clicks it, without
 * itself consuming a generation. */
export async function getUserGenerationCount(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const date = getUtcDateKey(now);
  const [row] = await db
    .select({ count: userGenerationCounts.count })
    .from(userGenerationCounts)
    .where(and(eq(userGenerationCounts.userId, userId), eq(userGenerationCounts.date, date)))
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Atomic upsert-increment (AC5/AC7 DB constraint: one row per user per UTC
 * day, `user_generation_counts_user_id_date_idx`) — always increments, then
 * the caller compares the returned count to the configured limit. Counts a
 * generation *attempt* (called once at `POST /api/ideas/generate`'s entry),
 * regardless of whether that attempt goes on to succeed.
 */
export async function incrementAndGetUserGenerationCount(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const date = getUtcDateKey(now);
  const [row] = await db
    .insert(userGenerationCounts)
    .values({ userId, date, count: 1 })
    .onConflictDoUpdate({
      target: [userGenerationCounts.userId, userGenerationCounts.date],
      set: { count: sql`${userGenerationCounts.count} + 1`, updatedAt: new Date() },
    })
    .returning({ count: userGenerationCounts.count });
  // `onConflictDoUpdate` here has no `where`, so the upsert always affects
  // (inserts or updates) exactly one row — `returning()` is never empty.
  return row!.count;
}

/** Read-only — used by `POST /api/ideas/generate`'s own pre-check (AC6) so
 * a run that's already futile (shared budget already empty) never starts,
 * and by `GET /api/ideas` to reflect that same state before the button is
 * even clicked. */
export async function getSearchBudgetCount(db: Db, now: Date = new Date()): Promise<number> {
  const date = getUtcDateKey(now);
  const [row] = await db.select({ count: searchBudgetCounts.count }).from(searchBudgetCounts).where(eq(searchBudgetCounts.date, date)).limit(1);
  return row?.count ?? 0;
}

/**
 * Atomic upsert-increment (same precedent as the per-user counter above,
 * DB constraint: one row per UTC day, `search_budget_counts.date` unique) —
 * called once per *real* `web_search` network call (never a cache hit,
 * AD-7), from `src/agent/web-search-budget-guard.ts`, so a run that starts
 * under budget but exhausts the shared budget mid-run degrades the same way
 * the per-run cap does (AC2: continues with what it has, logs the hit).
 */
export async function incrementAndGetSearchBudgetCount(db: Db, now: Date = new Date()): Promise<number> {
  const date = getUtcDateKey(now);
  const [row] = await db
    .insert(searchBudgetCounts)
    .values({ date, count: 1 })
    .onConflictDoUpdate({
      target: searchBudgetCounts.date,
      set: { count: sql`${searchBudgetCounts.count} + 1`, updatedAt: new Date() },
    })
    .returning({ count: searchBudgetCounts.count });
  // Same guarantee as `incrementAndGetUserGenerationCount` above.
  return row!.count;
}
