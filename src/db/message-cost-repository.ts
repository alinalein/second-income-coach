import { inArray } from 'drizzle-orm';
import type { createDb } from './client.js';
import { messageCosts } from './schema/index.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Story 5.2 (AD-21/AD-27): the one write/read path for `message_costs` —
 * `src/api/routes/chat.ts`/`plan-chat.ts` are the only callers (never a
 * direct-path flow, Boundary: "Direct-path flows ... get no cost line").
 */
export interface MessageCostRow {
  messageId: string;
  threadId: string;
  userId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** `null` when the turn's resolved model had no registry price match
   * (AD-21) — persisted as `null`, never a guessed/zero figure. */
  amountMinorUnitsUsd: number | null;
  pricePerMillionInputTokens: number | null;
  pricePerMillionOutputTokens: number | null;
  priceAsOf: string | null;
}

/**
 * Insert-only in practice (a given message id is only ever priced once, by
 * the turn that produced it) — `onConflictDoNothing` just guards the same
 * message id being persisted twice (e.g. a retried write after a
 * since-resolved transient failure) without throwing a unique-violation.
 */
export async function saveMessageCost(db: Db, row: MessageCostRow): Promise<void> {
  await db.insert(messageCosts).values(row).onConflictDoNothing({ target: messageCosts.messageId });
}

/** Batch read for `GET /messages`'s history attach — one query per request,
 * never N+1 per message. */
export async function getMessageCosts(db: Db, messageIds: readonly string[]): Promise<Map<string, MessageCostRow>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.select().from(messageCosts).where(inArray(messageCosts.messageId, messageIds as string[]));
  return new Map(rows.map((row) => [row.messageId, row]));
}
