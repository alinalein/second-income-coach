import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { plans } from './plans.js';

/**
 * Story 4.1 (AD-4/CAP-4): one row per text check-in — a plain, deterministic
 * Postgres write (`record_check_in`), never LLM-authored. `energy` stays
 * plain `text()` (no `pgEnum`, same precedent as `plans.status`), validated
 * only at the Zod layer (`checkInEnergySchema`, `shared/schemas/check-ins.ts`).
 * `note` is the optional free text typed alongside the energy/status pick —
 * moderated (AD-11) by the caller before this row is written.
 */
export const checkIns = pgTable('check_ins', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  energy: text('energy').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
