import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row per Google identity (Story 1.2). `googleId` is the Google `sub`
 * claim from the verified ID token — the durable identifier OAuth sign-in is
 * keyed on (email/name/picture can change upstream and are refreshed on
 * sign-in, but never used to look up the account). Created here and never
 * migrated again by later stories.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  picture: text('picture'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
