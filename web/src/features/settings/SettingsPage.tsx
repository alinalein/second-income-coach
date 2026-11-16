import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  settingsResponseSchema,
  PERSONALITY_IDS,
  UI_LANGUAGE_IDS,
  UI_LANGUAGE_TO_I18N_CODE,
  type SettingsResponse,
  type Personality,
  type UiLanguage,
} from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * AC: "settings persist per user in the `user_settings` table ... surfaced
 * through an actual settings screen - not just a backend default." Covers
 * Story 5.1 (personality + model) and Story 5.4 (UI language; currency lands
 * with Story 5.5 on this same screen/table). Every string goes through
 * `useTranslation('settings')` (AD-24) — including the model price label and
 * the fallback-behavior notice, never a literal.
 */
export function SettingsPage() {
  const { t, i18n } = useTranslation('settings');
  const [settings, setSettings] = React.useState<SettingsResponse | undefined>();
  const [personality, setPersonalityValue] = React.useState<Personality>('friendly');
  const [model, setModelValue] = React.useState('');
  const [uiLanguage, setUiLanguageValue] = React.useState<UiLanguage>('English');
  const [status, setStatus] = React.useState<SaveStatus>('idle');
  // Disables the selects during the initial fetch instead of swapping the
  // form out for a loading placeholder — the selects stay mounted the whole
  // time, just non-interactive until there's something to show.
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/settings', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = settingsResponseSchema.safeParse(body);
        if (!result.success) return;
        setSettings(result.data);
        setPersonalityValue(result.data.personality);
        setModelValue(result.data.model);
        setUiLanguageValue(result.data.uiLanguage);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handlePersonalityChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as Personality;
    setPersonalityValue(next);
    setStatus('saving');

    fetch('/api/settings/personality', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personality: next }),
    })
      .then((res) => setStatus(res.ok ? 'saved' : 'error'))
      .catch(() => setStatus('error'));
  }, []);

  const handleModelChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    setModelValue(next);
    setStatus('saving');

    fetch('/api/settings/model', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: next }),
    })
      .then((res) => setStatus(res.ok ? 'saved' : 'error'))
      .catch(() => setStatus('error'));
  }, []);

  // AC1: "the whole UI (via the i18n layer) switches immediately" — flips
  // the active `react-i18next` language right away, not only once the save
  // request round-trips.
  const handleUiLanguageChange = React.useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value as UiLanguage;
      setUiLanguageValue(next);
      setStatus('saving');
      void i18n.changeLanguage(UI_LANGUAGE_TO_I18N_CODE[next]);

      fetch('/api/settings/ui-language', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uiLanguage: next }),
      })
        .then((res) => setStatus(res.ok ? 'saved' : 'error'))
        .catch(() => setStatus('error'));
    },
    [i18n],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-personality" className="text-sm font-medium">
            {t('personality.label')}
          </label>
          <select
            id="settings-personality"
            value={personality}
            onChange={handlePersonalityChange}
            disabled={loading || status === 'saving'}
            className="h-10 rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {PERSONALITY_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`personality.options.${id}`)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t(`personality.helperText.${personality}`)}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-model" className="text-sm font-medium">
            {t('model.label')}
          </label>
          <select
            id="settings-model"
            value={model}
            onChange={handleModelChange}
            disabled={loading || status === 'saving'}
            className="h-10 rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {(settings?.selectableModels ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName} —{' '}
                {t('model.priceLabel', {
                  input: entry.pricePerMillionInputTokens,
                  output: entry.pricePerMillionOutputTokens,
                })}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t('model.fallbackNotice')}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-ui-language" className="text-sm font-medium">
            {t('uiLanguage.label')}
          </label>
          <select
            id="settings-ui-language"
            value={uiLanguage}
            onChange={handleUiLanguageChange}
            disabled={loading || status === 'saving'}
            className="h-10 rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {UI_LANGUAGE_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`uiLanguage.options.${id}`)}
              </option>
            ))}
          </select>
        </div>

        {status === 'error' ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {t('error')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
