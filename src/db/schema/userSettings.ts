import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Exactly one settings row per user (`userId` unique FK), created in the same
 * DB transaction as its `users` row on first sign-in (AC: transactional
 * creation), or backfilled with these same defaults on next sign-in for a
 * pre-existing user missing one (AC: sign-in + backfill rows).
 *
 * Created here (Story 1.2) and never migrated again — Epic 2 (2.2), Epic 4
 * (4.4), and Epic 5 (5.1, 5.2, 5.4, 5.5) only read/extend this table.
 *
 * `model` is deliberately nullable with no default: null means "use the
 * default model" (there is no model registry yet — that lands in Epic 5,
 * Story 5.1/5.4). `currency`, `personality`, and `uiLanguage` get concrete
 * defaults per the story's Intent.
 */
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  currency: text('currency').notNull().default('EUR'),
  personality: text('personality').notNull().default('friendly'),
  model: text('model'),
  uiLanguage: text('ui_language').notNull().default('English'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
