import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One row per user (unique `userId` FK), upserted on every `submit_intake`
 * tool call (Design Notes: "one row per user ... no historical versions" —
 * mirrors `userSettings`). Every enum-shaped column stays plain `text()`,
 * validated only at the Zod layer (`shared/schemas/intake.ts`) — no
 * `pgEnum`, no DB check constraint (Boundary, same precedent as
 * `userSettings`). `failurePattern` is one of these text columns: it's
 * classified by the top-level agent while constructing the `submit_intake`
 * tool call (AD-4), never computed here.
 */
export const intake = pgTable('intake', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  skillsInterests: text('skills_interests').notNull(),
  weeklyTimeAvailability: text('weekly_time_availability').notNull(),
  startingBudgetRange: text('starting_budget_range').notNull(),
  riskTolerance: text('risk_tolerance').notNull(),
  stoppedBeforeText: text('stopped_before_text').notNull(),
  failurePattern: text('failure_pattern').notNull(),
  /**
   * Story 2.5: steers `generate_ideas`'s source-region preference and the
   * card's "foreign source" labeling. `DEFAULT 'other'` is a migration
   * safety net only (backfills any pre-existing row with "no regional
   * preference") — the Zod request schema (`shared/schemas/intake.ts`)
   * requires every new submission to supply a real value.
   */
  country: text('country').notNull().default('other'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
