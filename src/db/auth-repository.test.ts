import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { users, userSettings } from './schema/index.js';
import { upsertUserAndSettings, type GoogleProfile } from './auth-repository.js';

/**
 * Integration test against real Postgres (CLAUDE.md: "one integration test
 * against real Postgres only for DB constraints"). Runs against the Compose
 * Postgres instance with the Story 1.2 migration already applied
 * (`npm run db:generate && npm run db:push`, per this story's Verification
 * commands) — DATABASE_URL defaults to the Compose instance's own default
 * credentials so this runs with no `.env` file required.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

function profile(googleId: string): GoogleProfile {
  return { googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null };
}

async function cleanUp(userId: string) {
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

afterAll(async () => {
  await pool.end();
});

describe('upsertUserAndSettings (integration, real Postgres)', () => {
  // I/O matrix: "First-ever sign-in" -> "users + user_settings rows created
  // transactionally" (AC: transactional creation).
  it('creates a users row and a user_settings row together on first sign-in, with the story defaults', async () => {
    const googleId = `test-${randomUUID()}`;
    const result = await upsertUserAndSettings(db, profile(googleId));

    try {
      const [userRow] = await db.select().from(users).where(eq(users.id, result.id));
      const [settingsRow] = await db.select().from(userSettings).where(eq(userSettings.userId, result.id));

      expect(userRow).toBeDefined();
      expect(settingsRow).toMatchObject({ currency: 'EUR', personality: 'friendly', model: null, uiLanguage: 'English' });
    } finally {
      await cleanUp(result.id);
    }
  });

  // I/O matrix: "Returning user, existing settings" -> "No new rows; existing
  // settings loaded".
  it('does not create a second settings row for a returning user who already has one', async () => {
    const googleId = `test-${randomUUID()}`;
    const first = await upsertUserAndSettings(db, profile(googleId));

    try {
      const second = await upsertUserAndSettings(db, profile(googleId));
      expect(second.id).toBe(first.id);

      const settingsRows = await db.select().from(userSettings).where(eq(userSettings.userId, first.id));
      expect(settingsRows).toHaveLength(1);
    } finally {
      await cleanUp(first.id);
    }
  });

  // I/O matrix: "Returning user, missing settings row" -> "Row created with
  // defaults on this sign-in" (AC: sign-in + backfill rows) — simulates a
  // pre-existing user row from before this story landed.
  it('backfills a missing user_settings row for a pre-existing user, never a failed or empty sign-in', async () => {
    const googleId = `test-${randomUUID()}`;
    const [inserted] = await db
      .insert(users)
      .values({ googleId, email: `${googleId}@example.com`, name: 'Pre-existing User', picture: null })
      .returning();
    const userId = inserted!.id;

    try {
      const [beforeSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      expect(beforeSettings).toBeUndefined();

      const result = await upsertUserAndSettings(db, profile(googleId));
      expect(result.id).toBe(userId);

      const [settingsRow] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      expect(settingsRow).toMatchObject({ currency: 'EUR', personality: 'friendly', uiLanguage: 'English' });
    } finally {
      await cleanUp(userId);
    }
  });
});
