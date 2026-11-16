import { z } from 'zod';

/**
 * Story 5.1 / AD-20: the one shared definition of the personality enum
 * (AD-16) — the `user_settings.personality` column's values, the agent's
 * `PERSONALITY_PROMPTS` keys (`src/agent/personality.ts`), and the settings
 * screen's option list all derive from this, never hand-copied separately.
 */
export const PERSONALITY_IDS = ['formal', 'friendly', 'terse'] as const;

export const personalitySchema = z.enum(PERSONALITY_IDS);

export type Personality = z.infer<typeof personalitySchema>;

/**
 * The subset of a model registry entry (`src/agent/registry.ts`) the
 * settings screen needs to render an option: never the provider or category,
 * since moderation/transcription entries are filtered out before this shape
 * is built (AC: "moderation/transcription models never appear as options").
 */
export const selectableModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pricePerMillionInputTokens: z.number().nonnegative(),
  pricePerMillionOutputTokens: z.number().nonnegative(),
  priceAsOf: z.string().min(1),
});

export type SelectableModel = z.infer<typeof selectableModelSchema>;

/**
 * Story 5.4 / AD-20/AD-24: the `user_settings.uiLanguage` column's values —
 * words, not i18next's `en`/`de` codes, matching the column's own `'English'`
 * default (Story 1.2). `UI_LANGUAGE_TO_I18N_CODE` below is the one place that
 * translates a stored value into the code `i18n.changeLanguage` expects.
 */
export const UI_LANGUAGE_IDS = ['English', 'German'] as const;

export const uiLanguageSchema = z.enum(UI_LANGUAGE_IDS);

export type UiLanguage = z.infer<typeof uiLanguageSchema>;

/** Matches `user_settings.uiLanguage`'s own column default (Story 1.2). */
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'English';

/**
 * AC: "a first-time visit with no stored preference -> defaults to English",
 * never browser-detected (AD-20) — same resolution principle as
 * `resolvePersonality`/`resolveModelId`, applied to whatever
 * `user_settings.uiLanguage` currently holds.
 */
export function resolveUiLanguage(value: string | null | undefined): UiLanguage {
  const result = uiLanguageSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_UI_LANGUAGE;
}

export const UI_LANGUAGE_TO_I18N_CODE: Record<UiLanguage, 'en' | 'de'> = {
  English: 'en',
  German: 'de',
};

export const settingsResponseSchema = z.object({
  personality: personalitySchema,
  model: z.string().min(1),
  selectableModels: z.array(selectableModelSchema),
  uiLanguage: uiLanguageSchema,
});

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const setPersonalityRequestSchema = z.object({
  personality: personalitySchema,
});

export type SetPersonalityRequest = z.infer<typeof setPersonalityRequestSchema>;

export const setModelRequestSchema = z.object({
  model: z.string().min(1),
});

export type SetModelRequest = z.infer<typeof setModelRequestSchema>;

export const setUiLanguageRequestSchema = z.object({
  uiLanguage: uiLanguageSchema,
});

export type SetUiLanguageRequest = z.infer<typeof setUiLanguageRequestSchema>;
