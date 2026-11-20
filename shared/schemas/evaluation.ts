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

export const evaluationWeaknessesSchema = z.object({
  knownWeaknesses: z.array(knownWeaknessRowSchema),
  edgeCases: z.array(edgeCaseRowSchema),
  codeImprovements: z.array(codeImprovementRowSchema),
});

export type EvaluationWeaknesses = z.infer<typeof evaluationWeaknessesSchema>;

/** The "Agent vs. prompt engineering vs. RAG" section of
 * `docs/TECHNICAL-RATIONALE.md` — that section is itself a bulleted list
 * (UX fix, user-requested: "this in bullet points"), parsed into one
 * string per bullet rather than extracted as one prose blob, so the page
 * renders a real `<ul>` instead of literal "-" characters. The Reflection
 * section's weaknesses/edge-cases/improvements content is `weaknesses`
 * above, reused rather than duplicated here. */
export const evaluationReflectionSchema = z.object({
  agentVsPromptEngineeringVsRag: z.array(z.string().min(1)).min(1),
});

export type EvaluationReflection = z.infer<typeof evaluationReflectionSchema>;

/**
 * Story 7.5/7.2: the two `### `-level tables under `docs/TECHNICAL-
 * RATIONALE.md`'s own "Tool boundary: LLM-backed vs. plain-code vs. MCP"
 * section, parsed server-side (never hand-copied) — one row shape per
 * table, matching that doc's own columns verbatim (including its raw
 * backtick-quoted code spans, same precedent as `evaluationWeaknessesSchema`
 * above's cells from `docs/KNOWN-WEAKNESSES.md`).
 */
export const toolAgentRowSchema = z.object({
  whereUserIs: z.string(),
  agentThread: z.string(),
  toolsModelCanCall: z.string(),
});

export const toolDetailRowSchema = z.object({
  tool: z.string(),
  kind: z.string(),
  whoCallsIt: z.string(),
  whereInFlow: z.string(),
  whatItDoes: z.string(),
  writesState: z.string(),
});

export const evaluationToolsSchema = z.object({
  agentTools: z.array(toolAgentRowSchema),
  toolDetails: z.array(toolDetailRowSchema),
});

export type EvaluationTools = z.infer<typeof evaluationToolsSchema>;

/**
 * `GET /api/evaluation`'s response shape (AD-28: same auth as every other
 * route; AD-29: generated, never hand-copied). Validated both server-side
 * (before responding) and client-side (the `/evaluation` page).
 */
export const evaluationResponseSchema = z.object({
  evals: publishedEvalResultsSchema,
  decisions: decisionsFileSchema,
  weaknesses: evaluationWeaknessesSchema,
  reflection: evaluationReflectionSchema,
  tools: evaluationToolsSchema,
});

export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>;
