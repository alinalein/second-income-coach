import { z } from 'zod';
import { publishedEvalResultsSchema } from './eval-results.js';

/**
 * Story 7.5 (AD-29: every section is generated from an existing source,
 * never hand-copied). `decisionSchema` validates `src/content/decisions.json`
 * — the curated Key Decisions data file, one entry per cited `AD-n` id, kept
 * to a short reason and trade-off (2-3 lines) rather than restating the full
 * architecture spine text.
 */
export const decisionSchema = z.object({
  id: z.string().regex(/^AD-\d+$/),
  title: z.string().min(1),
  reason: z.string().min(1),
  tradeoff: z.string().min(1),
});

export type Decision = z.infer<typeof decisionSchema>;

export const decisionsFileSchema = z.array(decisionSchema);

/**
 * The three pipe tables in `docs/KNOWN-WEAKNESSES.md`, parsed server-side
 * (never hand-copied) — one row shape per table, matching that doc's own
 * columns.
 */
export const knownWeaknessRowSchema = z.object({
  id: z.string(),
  weakness: z.string(),
  impact: z.string(),
  suggestion: z.string(),
});

export const edgeCaseRowSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  whatHappens: z.string(),
  suggestion: z.string(),
});

export const codeImprovementRowSchema = z.object({
  id: z.string(),
  suggestion: z.string(),
  why: z.string(),
});

export const qualityWeaknessesSchema = z.object({
  knownWeaknesses: z.array(knownWeaknessRowSchema),
  edgeCases: z.array(edgeCaseRowSchema),
  codeImprovements: z.array(codeImprovementRowSchema),
});

export type QualityWeaknesses = z.infer<typeof qualityWeaknessesSchema>;

/** The "Agent vs. prompt engineering vs. RAG" section of
 * `docs/TECHNICAL-RATIONALE.md` — that section is itself a bulleted list
 * (UX fix, user-requested: "this in bullet points"), parsed into one
 * string per bullet rather than extracted as one prose blob, so the page
 * renders a real `<ul>` instead of literal "-" characters. The Reflection
 * section's weaknesses/edge-cases/improvements content is `weaknesses`
 * above, reused rather than duplicated here. */
export const qualityReflectionSchema = z.object({
  agentVsPromptEngineeringVsRag: z.array(z.string().min(1)).min(1),
});

export type QualityReflection = z.infer<typeof qualityReflectionSchema>;

/**
 * `GET /api/quality`'s response shape (AD-28: same auth as every other
 * route; AD-29: generated, never hand-copied). Validated both server-side
 * (before responding) and client-side (the `/quality` page).
 */
export const qualityResponseSchema = z.object({
  evals: publishedEvalResultsSchema,
  decisions: decisionsFileSchema,
  weaknesses: qualityWeaknessesSchema,
  reflection: qualityReflectionSchema,
});

export type QualityResponse = z.infer<typeof qualityResponseSchema>;
