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
 *
 * Returns `ready` (live fix, post-handoff — user-reported: a user whose
 * stored preference is German saw a fresh "Generate new ideas" click write
 * English ideas, because nothing stopped that click from firing before this
 * fetch had applied the real language; `i18n.language` was still its
 * built-in `'en'` default at that moment). `App` now keeps its existing
 * loading placeholder up until `ready`, the same pattern it already uses
 * for `hasIntake === null` — never lets any UI-language-dependent action
 * fire against the wrong, not-yet-applied default.
 */
export function useAppliedUiLanguage(enabled: boolean): boolean {
  const [ready, setReady] = React.useState(!enabled);

  React.useEffect(() => {
    if (!enabled) {
      setReady(true);
      return;
    }
    let cancelled = false;

    fetch('/api/settings', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = settingsResponseSchema.safeParse(body);
        if (!result.success) return;
        const code = UI_LANGUAGE_TO_I18N_CODE[result.data.uiLanguage];
        if (i18n.language !== code) await i18n.changeLanguage(code);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return ready;
}
