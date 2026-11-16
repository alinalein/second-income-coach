import { personalitySchema, type Personality } from '@app/shared';

export type { Personality };

/**
 * AD-20: "Personality (formal/friendly/terse) is a prompt layer only - it
 * never changes the tool boundary (AD-4) or bypasses any constraint." These
 * are plain tone descriptions only — no mention of moderation/guardrails, so
 * there is nothing here for a personality to weaken (AC: "no personality
 * weakens or bypasses" AD-11/AD-12). Keyed by the shared `personalitySchema`
 * enum (AD-16), not a locally hand-copied union.
 */
export const PERSONALITY_PROMPTS: Record<Personality, string> = {
  formal: 'Keep a formal, professional tone — no slang, no exclamation points.',
  friendly: 'Keep a warm, encouraging, friendly tone, like a supportive coach.',
  terse: 'Keep replies short and to the point — no filler, no pleasantries.',
};

/** Matches `user_settings.personality`'s own column default (Story 1.2). */
export const DEFAULT_PERSONALITY: Personality = 'friendly';

/**
 * AC: "an unknown ... id resolves to the default ... rather than erroring"
 * — same resolution principle Story 5.1 applies to the model id
 * (`src/agent/registry.ts`'s `resolveModelId`), applied here to whatever
 * `user_settings.personality` currently holds.
 */
export function resolvePersonality(value: string | null | undefined): Personality {
  const result = personalitySchema.safeParse(value);
  return result.success ? result.data : DEFAULT_PERSONALITY;
}
