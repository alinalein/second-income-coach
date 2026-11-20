import { z } from 'zod';

/**
 * Stories 6.2/6.3 follow-up: the shape `npm run eval:report` writes to the
 * committed `src/evals/published/eval-results.json` (via `renderJsonSummary`
 * — never hand-copied) and Story 7.5's public Evaluation & Decisions page reads
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
  /** User-requested (2026-11-20): a short, real example of what this suite
   * tests — copied verbatim from its own fixture/test file. Optional for
   * backward compatibility with a published file written before this field
   * existed. */
  example: z.string().optional(),
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
  /** Optional for backward compatibility with a published `eval-results.json`
   * written before per-role cost splitting existed (every row written back
   * then was a target-model-under-test call). */
  role: z.enum(['target', 'judge']).optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  callCount: z.number(),
  pricePerMillionInputTokens: z.number().nullable(),
  pricePerMillionOutputTokens: z.number().nullable(),
  estimatedCostUsd: z.number().nullable(),
  usageComplete: z.boolean(),
});

/** Job B (amended 2026-11-20): one group's own subtotal ("target models" /
 * "Sonnet" / "judges"). `estimatedCostUsd` is `null` whenever `status` isn't
 * `'measured'` — a group that wasn't recorded this run shows as
 * `'not-recorded'`, never a guessed/confirmed-looking `$0.0000` (AD-21). */
export const costGroupSchema = z.object({
  estimatedCostUsd: z.number().nullable(),
  allPriced: z.boolean(),
  allRecorded: z.boolean(),
  /** Optional for backward compatibility with a published file written
   * before this field existed. */
  status: z.enum(['measured', 'not-recorded', 'not-priced']).optional(),
});

export const limitationSchema = z.object({
  id: z.string(),
  summary: z.string(),
});

/**
 * User-requested (2026-11-20): per-model latency visibility — mirrors
 * `src/evals/build-report.ts`'s own `ReportData['latency']` exactly.
 * `medianMs`/`maxMs` are `null` for "not measured" (the relevant eval step
 * hasn't been run for this results file yet), never a fabricated number.
 */
export const ackLatencyModelRowSchema = z.object({
  modelId: z.string(),
  medianMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  /** Optional for backward compatibility with a published `eval-results.json`
   * written before this field existed. */
  calls: z.number().optional(),
});

export const deterministicLatencyModelRowSchema = z.object({
  modelId: z.string(),
  medianMs: z.number().nullable(),
});

export const latencySchema = z.object({
  ackByModel: z.array(ackLatencyModelRowSchema),
  deterministicByModel: z.array(deterministicLatencyModelRowSchema),
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
    /** User-requested (2026-11-20, amended): plain English stating exactly
     * what `totalEstimatedCostUsd` covers, e.g. "target models + Sonnet;
     * judges not recorded" — computed by `buildCostTotal`, never hand-typed.
     * Optional for backward compatibility with a published file written
     * before this field existed. */
    totalLabel: z.string().optional(),
    mechanism: z.string(),
    priceAsOf: z.string().optional(),
    priceSource: z.string().optional(),
    groups: z
      .object({
        targetModels: costGroupSchema,
        sonnet: costGroupSchema,
        judges: costGroupSchema,
      })
      .optional(),
  }),
  /** Optional for backward compatibility with a published `eval-results.json`
   * written before this field existed (same precedent as
   * `mistralJailbreakFlagRate` above) — the Evaluation page renders its
   * absence as "not shown yet", never a parse failure on the whole page. */
  latency: latencySchema.optional(),
  limitations: z.array(limitationSchema),
});

export type PublishedEvalResults = z.infer<typeof publishedEvalResultsSchema>;
