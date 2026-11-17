import { pgTable, uuid, text, integer, doublePrecision, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Story 5.2 (AD-21/AD-27): one row per chat-turn reply message that carried
 * at least one model call. Keyed by `messageId` (the `AIMessage.id`
 * LangChain assigns, already surfaced as `ChatMessage.id` by `chat.ts`/
 * `plan-chat.ts`'s `toChatMessage`) — one row per message, never per
 * turn-number or thread-position, since a message id is already globally
 * unique and is exactly what `GET /messages`'s batch read keys off.
 *
 * Money is persisted USD-native, integer **micro**-units (millionths of a
 * dollar — bug fix, epics.md amendment: a typical per-message cost is a
 * fraction of a cent, which minor-unit/cent granularity rounds straight to
 * zero) plus a price snapshot (`pricePerMillionInputTokens`/
 * `pricePerMillionOutputTokens`/`priceAsOf`, all copied from the registry
 * entry at write time — Design Notes) so a later registry price change
 * never retroactively alters a past message's recorded cost.
 * `amountMicroUnitsUsd`/`pricePerMillion*`/`priceAsOf` are all nullable
 * together — null means this turn's resolved model had no `findModelEntry`
 * match (AD-21: "token count only, never a guessed/zero cost");
 * `inputTokens`/`outputTokens`/`modelId` are always recorded regardless.
 */
export const messageCosts = pgTable('message_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull().unique(),
  threadId: text('thread_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  modelId: text('model_id').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  amountMicroUnitsUsd: integer('amount_micro_units_usd'),
  pricePerMillionInputTokens: doublePrecision('price_per_million_input_tokens'),
  pricePerMillionOutputTokens: doublePrecision('price_per_million_output_tokens'),
  priceAsOf: text('price_as_of'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
