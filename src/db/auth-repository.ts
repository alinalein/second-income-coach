import { eq } from 'drizzle-orm';
import type { createDb } from './client.js';
import { users, userSettings } from './schema/index.js';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface UpsertedUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

/**
 * Transactional upsert on Google sign-in (Intent: "`users` + `user_settings`
 * row creation on first sign-in" / AC: "sign-in + backfill rows").
 *
 * - New Google identity: `users` + `user_settings` rows are created together,
 *   in one transaction — a `users` row never exists without its settings row.
 * - Known identity, settings already present: no rows are written.
 * - Known identity, settings missing (pre-existing user from before this
 *   story): the settings row is created now, with the same defaults, inside
 *   the same transaction — never a failed or empty sign-in.
 */
export async function upsertUserAndSettings(
  db: ReturnType<typeof createDb>['db'],
  profile: GoogleProfile,
): Promise<UpsertedUser> {
  return db.transaction(async (tx) => {
    const [existingUser] = await tx.select().from(users).where(eq(users.googleId, profile.googleId)).limit(1);

    const user =
      existingUser ??
      (
        await tx
          .insert(users)
          .values({
            googleId: profile.googleId,
            email: profile.email,
            name: profile.name,
            picture: profile.picture,
          })
          .returning()
      )[0]!;

    const [existingSettings] = await tx
      .select({ id: userSettings.id })
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .limit(1);

    if (!existingSettings) {
      await tx.insert(userSettings).values({ userId: user.id });
    }

    return { id: user.id, email: user.email, name: user.name, picture: user.picture };
  });
}
