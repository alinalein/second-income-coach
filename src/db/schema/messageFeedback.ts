import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Story 5.3 (AD-4/AD-22): one row per rated message, keyed by `messageId`
 * (unique) — "change" upserts this same row, "remove" deletes it; feedback
 * never accumulates a history of ratings for one message. `rating` stays
 * plain `text()` (no `pgEnum`, same no-`pgEnum` precedent as `ideas.status`/
 * `intake.failurePattern`), validated at the Zod layer
 * (`shared/schemas/index.ts`'s `feedbackRatingSchema`). `comment` is
 * nullable: no comment was submitted, a jailbreak-flagged comment was
 * dropped (Boundary: "reject drops the comment — rating still stored"), or
 * it's the redacted/verbatim text of a comment that otherwise passed
 * moderation.
 */
export const messageFeedback = pgTable('message_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull().unique(),
  threadId: text('thread_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  rating: text('rating').notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
