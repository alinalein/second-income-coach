import { z } from 'zod';

/**
 * Stories 6.2/6.3 follow-up: the shape `npm run eval:report` writes to the
 * committed `src/evals/published/eval-results.json` (via `renderJsonSummary`
 * — never hand-copied) and Story 7.5's public Quality & Decisions page reads
 * back and validates before rendering. Mirrors `src/evals/render.ts`'s
 * `renderJsonSummary` output exactly, field for field.
 */
export const modelAccuracySchema = z.object({
  modelId: z.string(),
  deterministicCaseCount: z.number(),
  passedCaseCount: z.number(),
  accuracy: z.number(),
  meetsTarget: z.boolean(),
});

export const qualityResultRowSchema = z.object({
  modelId: z.string(),
  caseId: z.string(),
  judgeId: z.string(),
  score: z.union([z.boolean(), z.number(), z.null()]),
  comment: z.string().optional(),
  error: z.string().optional(),
});

export const judgeRegistryOverlapEntrySchema = z.object({
  judgeId: z.string(),
  alsoRegistryEntry: z.boolean(),
});

export const guardrailSuiteResultSchema = z.object({
  file: z.string(),
  label: z.string(),
  testNamePattern: z.string().optional(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  allPassed: z.boolean(),
});

export const pendingGuardrailCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  reason: z.string(),
});

/** AD-23's non-gating metric: `'ok'` once a live run recorded real
 * flag/score data, `'pending'` for "not yet recorded" and "the live call
 * errored" alike — never a faked count either way. */
export const mistralJailbreakFlagRateRowSchema = z.object({
  label: z.string(),
  flagged: z.boolean().optional(),
  jailbreakingScore: z.number().nullable().optional(),
  error: z.string().optional(),
});

export const mistralJailbreakFlagRateSectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), total: z.number(), flaggedCount: z.number(), rows: z.array(mistralJailbreakFlagRateRowSchema) }),
  z.object({ status: z.literal('pending'), reason: z.string() }),
]);

export const modelCostSummarySchema = z.object({
  modelId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  callCount: z.number(),
  pricePerMillionInputTokens: z.number().nullable(),
  pricePerMillionOutputTokens: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
  usageComplete: z.boolean(),
});

export const limitationSchema = z.object({
  id: z.string(),
  summary: z.string(),
});

export const publishedEvalResultsSchema = z.object({
  runDate: z.string(),
  reportGeneratedAt: z.string(),
  trajectoryAccuracyTarget: z.number(),
  perModelAccuracy: z.array(modelAccuracySchema),
  judges: z.object({
    judgeModelIds: z.array(z.string()),
    judgeScoredModels: z.record(z.string(), z.array(z.string())),
    registryOverlap: z.array(judgeRegistryOverlapEntrySchema),
    qualityResults: z.array(qualityResultRowSchema),
  }),
  safety: z.object({
    suites: z.array(guardrailSuiteResultSchema),
    allBuiltSuitesPassed: z.boolean(),
    pending: z.array(pendingGuardrailCategorySchema),
  }),
  mistralJailbreakFlagRate: mistralJailbreakFlagRateSectionSchema,
  cost: z.object({
    perModel: z.array(modelCostSummarySchema),
    totalEstimatedCostUsd: z.number(),
    mechanism: z.string(),
  }),
  limitations: z.array(limitationSchema),
});

export type PublishedEvalResults = z.infer<typeof publishedEvalResultsSchema>;
