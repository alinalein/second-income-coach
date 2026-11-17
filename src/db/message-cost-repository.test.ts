import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { saveMessageCost, getMessageCosts } from './message-cost-repository.js';
import { createDb } from './client.js';
import { users, messageCosts } from './schema/index.js';

// AD-21's own DB-constraint-dependent behavior (the `message_id` unique
// index `saveMessageCost`'s `onConflictDoNothing` relies on) — a real
// Postgres instance, not a mock, is the only thing that can prove this
// actually works (same "real Postgres for DB constraints" precedent as the
// one-active-plan test, AD-14).
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';
const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function createTestUser(): Promise<string> {
  const googleId = `test-${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
    .returning();
  return user!.id;
}

describe('saveMessageCost / getMessageCosts (real Postgres: the message_id unique constraint)', () => {
  it('persists a priced row, reads it back by id, and a repeat save for the same message id is a no-op', async () => {
    const userId = await createTestUser();
    const messageId = `msg-${randomUUID()}`;
    try {
      await saveMessageCost(db, {
        messageId,
        threadId: 'discovery:test',
        userId,
        modelId: 'openai/gpt-6-luna',
        inputTokens: 1000,
        outputTokens: 500,
        amountMinorUnitsUsd: 35,
        pricePerMillionInputTokens: 0.1,
        pricePerMillionOutputTokens: 0.5,
        priceAsOf: '2026-11-14',
      });

      const costs = await getMessageCosts(db, [messageId]);
      expect(costs.get(messageId)).toMatchObject({ modelId: 'openai/gpt-6-luna', inputTokens: 1000, outputTokens: 500, amountMinorUnitsUsd: 35 });

      // A second save for the same message id (e.g. a retried write) must
      // never throw a unique-violation, and must never overwrite the
      // original snapshot (AD-21: "never retroactively alter a past
      // message's recorded cost").
      await saveMessageCost(db, {
        messageId,
        threadId: 'discovery:test',
        userId,
        modelId: 'openai/gpt-6-luna',
        inputTokens: 999_999,
        outputTokens: 999_999,
        amountMinorUnitsUsd: 999_999,
        pricePerMillionInputTokens: 0.1,
        pricePerMillionOutputTokens: 0.5,
        priceAsOf: '2026-11-14',
      });

      const costsAfterRetry = await getMessageCosts(db, [messageId]);
      expect(costsAfterRetry.get(messageId)).toMatchObject({ inputTokens: 1000, outputTokens: 500, amountMinorUnitsUsd: 35 });
    } finally {
      await db.delete(messageCosts).where(eq(messageCosts.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('a model with no price persists tokens with null price/amount fields, and reads back the same way', async () => {
    const userId = await createTestUser();
    const messageId = `msg-${randomUUID()}`;
    try {
      await saveMessageCost(db, {
        messageId,
        threadId: 'discovery:test',
        userId,
        modelId: 'some/unpriced-model',
        inputTokens: 42,
        outputTokens: 7,
        amountMinorUnitsUsd: null,
        pricePerMillionInputTokens: null,
        pricePerMillionOutputTokens: null,
        priceAsOf: null,
      });

      const costs = await getMessageCosts(db, [messageId]);
      expect(costs.get(messageId)).toMatchObject({ inputTokens: 42, outputTokens: 7, amountMinorUnitsUsd: null, priceAsOf: null });
    } finally {
      await db.delete(messageCosts).where(eq(messageCosts.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
