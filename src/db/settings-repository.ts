import { eq } from 'drizzle-orm';
import type { CurrencyCode, Personality, UiLanguage } from '@app/shared';
import type { createDb } from './client.js';
import { userSettings } from './schema/index.js';

type Db = ReturnType<typeof createDb>['db'];

export interface UserSettingsRow {
  personality: string;
  model: string | null;
  uiLanguage: string;
  currency: string;
}

/**
 * Story 5.1 (extended Story 5.4 for `uiLanguage`): the one read both
 * `src/agent/index.ts` (per-turn personality/model resolution) and
 * `src/api/routes/settings.ts` (the settings screen) use against the
 * `user_settings` table Story 1.2 created — never a second, hand-rolled
 * query. `undefined` only for a user with no settings row yet, which Story
 * 1.2's sign-in flow already prevents in practice (every caller still treats
 * it as "use the defaults", never an error).
 */
export async function getUserSettings(db: Db, userId: string): Promise<UserSettingsRow | undefined> {
  const [row] = await db
    .select({
      personality: userSettings.personality,
      model: userSettings.model,
      uiLanguage: userSettings.uiLanguage,
      currency: userSettings.currency,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row;
}

/** AD-4/AD-20: the deterministic write `src/tools/plain/set_personality.ts`
 * calls — never called directly by anything else. */
export async function updatePersonality(db: Db, userId: string, personality: Personality): Promise<void> {
  await db
    .update(userSettings)
    .set({ personality, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** AD-4/AD-20: the deterministic write `src/tools/plain/set_model.ts` calls
 * — never called directly by anything else. */
export async function updateModel(db: Db, userId: string, model: string): Promise<void> {
  await db
    .update(userSettings)
    .set({ model, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** AD-4/AD-20: the deterministic write `src/tools/plain/set_ui_language.ts`
 * calls — never called directly by anything else. */
export async function updateUiLanguage(db: Db, userId: string, uiLanguage: UiLanguage): Promise<void> {
  await db
    .update(userSettings)
    .set({ uiLanguage, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** AD-4/AD-27: the deterministic write `src/tools/plain/set_currency.ts`
 * calls — never called directly by anything else. */
export async function updateCurrency(db: Db, userId: string, currency: CurrencyCode): Promise<void> {
  await db
    .update(userSettings)
    .set({ currency, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
