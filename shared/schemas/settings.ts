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

export const settingsResponseSchema = z.object({
  personality: personalitySchema,
  model: z.string().min(1),
  selectableModels: z.array(selectableModelSchema),
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
