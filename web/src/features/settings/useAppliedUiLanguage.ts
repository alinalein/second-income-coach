import * as React from 'react';
import { settingsResponseSchema, UI_LANGUAGE_TO_I18N_CODE } from '@app/shared';
import i18n from '../../i18n';

/**
 * AC: "a stored UI language preference ... persists across sessions" / "it
 * is applied when the app loads for a signed-in user." `App` calls this with
 * `enabled` set once the session is known to be authenticated; it reads the
 * same `GET /api/settings` the settings screen itself reads (backed by
 * `user_settings.uiLanguage`, English by default — never browser-detected,
 * AD-20) and switches `react-i18next`'s active language to match.
 */
export function useAppliedUiLanguage(enabled: boolean): void {
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    fetch('/api/settings', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = settingsResponseSchema.safeParse(body);
        if (!result.success) return;
        const code = UI_LANGUAGE_TO_I18N_CODE[result.data.uiLanguage];
        if (i18n.language !== code) void i18n.changeLanguage(code);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
