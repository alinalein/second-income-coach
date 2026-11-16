import { setCurrencyRequestSchema, type CurrencyCode } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { updateCurrency as updateCurrencyInDb } from '../../db/settings-repository.js';

type Db = ReturnType<typeof createDb>['db'];

export interface SetCurrencyDeps {
  /** Test-only seam (same DI pattern as `set_ui_language`'s
   * `updateUiLanguage`): a fake write instead of a real Drizzle update. */
  updateCurrency?: typeof updateCurrencyInDb;
}

/**
 * AD-4/AD-27: `set_currency` as a plain deterministic Postgres write to
 * `user_settings.currency` — never registered as an agent-callable LangChain
 * tool (same boundary as `set_personality`/`set_model`/`set_ui_language`, see
 * their own comments). The only caller is `POST /api/settings/currency`
 * (`src/api/routes/settings.ts`), itself only reachable through the settings
 * screen's own API call (AC: "only ever called via the settings UI's API
 * calls"). Changing currency never alters a stored source value or citation
 * (AD-27) — this only writes the display-currency preference; conversion and
 * formatting happen client-side via `shared/money.ts`.
 */
export async function setCurrency(
  db: Db,
  userId: string,
  currency: CurrencyCode,
  deps: SetCurrencyDeps = {},
): Promise<void> {
  const parsed = setCurrencyRequestSchema.parse({ currency });
  const updateCurrency = deps.updateCurrency ?? updateCurrencyInDb;
  await updateCurrency(db, userId, parsed.currency);
}
