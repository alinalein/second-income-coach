import { setUiLanguageRequestSchema, type UiLanguage } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { updateUiLanguage as updateUiLanguageInDb } from '../../db/settings-repository.js';

type Db = ReturnType<typeof createDb>['db'];

export interface SetUiLanguageDeps {
  /** Test-only seam (same DI pattern as `set_personality`'s
   * `updatePersonality`): a fake write instead of a real Drizzle update. */
  updateUiLanguage?: typeof updateUiLanguageInDb;
}

/**
 * AD-4/AD-20: `set_ui_language` as a plain deterministic Postgres write to
 * `user_settings.uiLanguage` — never registered as an agent-callable
 * LangChain tool (same boundary as `set_personality`/`set_model`, see their
 * own comments). The only caller is `POST /api/settings/ui-language`
 * (`src/api/routes/settings.ts`), itself only reachable through the settings
 * screen's own API call (AC: "only ever called via the settings UI's API
 * calls"). This never feeds back into the agent's reply-language decision
 * (AD-25) — `src/agent/language.ts`'s `detectReplyLanguage` derives that
 * from the message text alone, not from this setting.
 */
export async function setUiLanguage(
  db: Db,
  userId: string,
  uiLanguage: UiLanguage,
  deps: SetUiLanguageDeps = {},
): Promise<void> {
  const parsed = setUiLanguageRequestSchema.parse({ uiLanguage });
  const updateUiLanguage = deps.updateUiLanguage ?? updateUiLanguageInDb;
  await updateUiLanguage(db, userId, parsed.uiLanguage);
}
