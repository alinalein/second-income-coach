import { z } from 'zod';
import { replyLanguageSchema, rationaleSchema, DEMAND_EVIDENCE_NOTE_MAX_LENGTH, GROWTH_PATH_MAX_LENGTH } from './ideas.js';

/**
 * Story 2.7: one cached translation of an idea's displayable text fields
 * into a language other than the one it was generated in
 * (`ideaResponseSchema.language`). Reuses `rationaleSchema`/
 * `DEMAND_EVIDENCE_NOTE_MAX_LENGTH`/`GROWTH_PATH_MAX_LENGTH` from
 * `shared/schemas/ideas.ts` — a translated field is held to the exact same
 * shape/length constraints as the original, never a looser one. Never
 * includes `baselineRateQuote`/`demandEvidenceQuote`/citations/URLs/numbers
 * (Boundary: those are never sent to or returned by the translation call —
 * they stay exactly as generated, in every language).
 */
export const ideaTranslationSchema = z.object({
  ideaId: z.string().min(1),
  language: replyLanguageSchema,
  title: z.string().min(1).max(200),
  rationale: rationaleSchema,
  demandEvidenceNote: z.string().min(1).max(DEMAND_EVIDENCE_NOTE_MAX_LENGTH).nullable(),
  growthPath: z.string().min(1).max(GROWTH_PATH_MAX_LENGTH).nullable(),
});

export type IdeaTranslation = z.infer<typeof ideaTranslationSchema>;

/** `POST /api/ideas/translate`'s request body: the visible ideas whose
 * language differs from the UI, translated as one batch. */
export const translateIdeasRequestSchema = z.object({
  ideaIds: z.array(z.uuid()).min(1).max(20),
  language: replyLanguageSchema,
});

export type TranslateIdeasRequest = z.infer<typeof translateIdeasRequestSchema>;

/** `POST /api/ideas/translate`'s response — one translation per requested
 * idea id, from the cache or freshly generated and cached this call. */
export const translateIdeasResponseSchema = z.object({
  translations: z.array(ideaTranslationSchema),
});

export type TranslateIdeasResponse = z.infer<typeof translateIdeasResponseSchema>;
