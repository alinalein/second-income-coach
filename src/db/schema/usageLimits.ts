import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Story 2.11 (AC5/AC7): one row per user per UTC calendar day — the
 * per-user daily cap on `generate_ideas` runs (`DAILY_GENERATIONS_PER_USER`,
 * `src/config/env.ts`). `date` is a plain `YYYY-MM-DD` string (the UTC
 * calendar date), never a timestamp — "reset at a fixed time" (AC7) is
 * implicit: a new UTC day is simply a new, not-yet-existing row starting at
 * 0, no cron/reset job needed. `src/tools/plain/usage_limits.ts` is the only
 * reader/writer (AD-4: plain-code, never an LLM tool).
 */
export const userGenerationCounts = pgTable(
  'user_generation_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    date: text('date').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_generation_counts_user_id_date_idx').on(table.userId, table.date)],
);

/**
 * Story 2.11 (AC6/AC7): one row per UTC calendar day — the app-wide shared
 * daily budget on real `web_search` calls (`DAILY_SEARCH_BUDGET`,
 * `src/config/env.ts`), counting only actual network calls, never a cache
 * hit (AD-7). Never scoped by user — "shared", not per-user, per the AC.
 */
export const searchBudgetCounts = pgTable('search_budget_counts', {
  id: uuid('id').primaryKey().defaultRandom(),
  date: text('date').notNull().unique(),
  count: integer('count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
