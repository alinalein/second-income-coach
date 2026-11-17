import { and, eq, sql } from 'drizzle-orm';
import type { createDb } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { userGenerationCounts, searchBudgetCounts, users } from '../../db/schema/index.js';

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

/**
 * Gives one counted generation back (never below zero). Used when a run
 * fails fast because the search service itself was unavailable
 * (`SearchServiceUnavailableError`) — that attempt was never the user's own
 * doing, so it must not spend one of their daily generations.
 */
export async function refundUserGeneration(db: Db, userId: string, now: Date = new Date()): Promise<void> {
  const date = getUtcDateKey(now);
  await db
    .update(userGenerationCounts)
    .set({ count: sql`GREATEST(${userGenerationCounts.count} - 1, 0)`, updatedAt: new Date() })
    .where(and(eq(userGenerationCounts.userId, userId), eq(userGenerationCounts.date, date)));
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

/**
 * Story 2.11 follow-up: trimmed, case-insensitive match against
 * `UNLIMITED_USER_EMAILS`'s comma-separated list. Pure and deterministic
 * — never logs or returns the list itself (no email is ever passed back),
 * just a boolean. An empty list (the default) matches nobody.
 */
export function isUnlimitedUserEmail(email: string, unlimitedUserEmails: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  return unlimitedUserEmails
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .includes(normalizedEmail);
}

/**
 * The session only carries `userId` (never email), so this looks the
 * signed-in user's own email up by id before checking the exemption list.
 * Exempts only the per-user daily generation check — the shared search
 * budget, the per-run search cap, the forced cheap search settings, and
 * the per-user query cache all still apply to every user, listed or not.
 */
export async function isUnlimitedUser(db: Db, userId: string, env: Pick<Env, 'UNLIMITED_USER_EMAILS'>): Promise<boolean> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return false;
  return isUnlimitedUserEmail(row.email, env.UNLIMITED_USER_EMAILS);
}
