import { computeModelCosts, totalEstimatedCostUsd, type ModelCallUsageRow, type ModelCostSummary } from './cost.js';
import { PENDING_GUARDRAIL_CATEGORIES, type GuardrailSuiteResult, type PendingGuardrailCategory } from './guardrails.js';
import { JUDGE_MODEL_IDS } from './constants.js';

/** The shape `trajectory.eval.ts` (Story 6.2, extended by Story 6.3 with
 * `modelCallUsages`) writes to `src/evals/results/trajectory-results.json`.
 * Declared independently here rather than imported from `trajectory.eval.ts`
 * itself — that file runs real env loading and fixture discovery as a
 * module-load side effect (it's a Vitest spec, not a library module). */
export interface ModelAccuracy {
  modelId: string;
  deterministicCaseCount: number;
  passedCaseCount: number;
  accuracy: number;
  meetsTarget: boolean;
}

export interface ResultRow {
  modelId: string;
  caseId: string;
  caseType: 'deterministic' | 'quality';
  language: 'en' | 'de';
  toolUnderTest: string;
  judgeId?: string;
  score: boolean | number | null;
  comment?: string;
  error?: string;
  langsmithProject?: string;
  langsmithRunId?: string;
}

export interface TrajectoryResults {
  generatedAt: string;
  trajectoryAccuracyTarget: number;
  perModelAccuracy: ModelAccuracy[];
  rows: ResultRow[];
  modelCallUsages?: ModelCallUsageRow[];
}

export interface Limitation {
  id: string;
  summary: string;
}

export interface ReportData {
  runDate: string;
  reportGeneratedAt: string;
  trajectoryAccuracyTarget: number;
  perModelAccuracy: ModelAccuracy[];
  judgeModelIds: readonly string[];
  judgeScoredModels: Record<string, string[]>;
  judgeRegistryOverlap: { judgeId: string; alsoRegistryEntry: boolean }[];
  guardrails: {
    suites: GuardrailSuiteResult[];
    allBuiltSuitesPassed: boolean;
    pending: readonly PendingGuardrailCategory[];
  };
  cost: {
    perModel: ModelCostSummary[];
    totalEstimatedCostUsd: number;
    mechanism: string;
  };
  limitations: Limitation[];
}

function judgeScoredModels(rows: readonly ResultRow[]): Record<string, string[]> {
  const byJudge = new Map<string, Set<string>>();
  for (const row of rows) {
    // Review Triage Log: a row with `error` set means the judge call
    // itself failed — it never produced a score, so it never "scored"
    // this model, no matter how `judgeId`/`caseType` read.
    if (row.caseType !== 'quality' || !row.judgeId || row.error !== undefined) continue;
    const models = byJudge.get(row.judgeId) ?? new Set<string>();
    models.add(row.modelId);
    byJudge.set(row.judgeId, models);
  }
  return Object.fromEntries(Array.from(byJudge.entries()).map(([judgeId, models]) => [judgeId, Array.from(models).sort()]));
}

/**
 * Story 6.3 AC: "known limitations (cross-referencing Epic 7's Story 7.4,
 * plus the judge/registry-overlap note ... from Story 6.2) and the eval
 * run's own estimated cost." Pure function — takes the already-produced
 * results of Stories 6.1 (guardrails) and 6.2 (trajectory), never runs
 * either itself.
 */
export function buildReport(trajectoryResults: TrajectoryResults, guardrailResults: GuardrailSuiteResult[]): ReportData {
  const modelIds = trajectoryResults.perModelAccuracy.map((entry) => entry.modelId);
  const judgeRegistryOverlap = JUDGE_MODEL_IDS.map((judgeId) => ({ judgeId, alsoRegistryEntry: modelIds.includes(judgeId) }));
  const overlappingJudges = judgeRegistryOverlap.filter((entry) => entry.alsoRegistryEntry).map((entry) => entry.judgeId);

  const cost = computeModelCosts(trajectoryResults.modelCallUsages ?? [], modelIds);
  const unpricedModelIds = cost.filter((entry) => entry.estimatedCostUsd === null).map((entry) => entry.modelId);

  const limitations: Limitation[] = [];

  if (overlappingJudges.length > 0) {
    limitations.push({
      id: 'judge-registry-overlap',
      summary: `${overlappingJudges.join(', ')} is both a pinned judge and a user-selectable registry entry — when it judges its own model's trajectories, the "which judge scored which model" table above shows that overlap rather than hiding it.`,
    });
  }

  if (PENDING_GUARDRAIL_CATEGORIES.length > 0) {
    limitations.push({
      id: 'pending-guardrail-categories',
      summary: `${PENDING_GUARDRAIL_CATEGORIES.length} safety/guardrail categories named by AD-23 are not yet built and are listed as pending above, not counted toward the 100% pass bar.`,
    });
  }

  if (unpricedModelIds.length > 0) {
    limitations.push({
      id: 'unpriced-eval-only-model',
      summary: `${unpricedModelIds.join(', ')} has no registered price in MODEL_REGISTRY (intentionally excluded as eval-only, AD-20) — token usage is shown, cost is not estimated (AD-21: never a guessed price).`,
    });
  }

  limitations.push({
    id: 'cost-mechanism-not-built',
    summary: 'This cost estimate is computed directly from the model registry price list, not the CAP-8 token/cost mechanism (Story 5.2), which is not yet built.',
  });

  limitations.push({
    id: 'judge-call-cost-excluded',
    summary: `Judge models (${JUDGE_MODEL_IDS.join(', ')}) also spend real tokens scoring quality cases — this estimate covers target-model-under-test calls only, not the judges' own calls.`,
  });

  limitations.push({
    id: 'story-7-4-pending',
    summary: 'Known-weaknesses/traceability documentation (Epic 7, Story 7.4) does not exist yet — this report will cross-reference it once written.',
  });

  return {
    runDate: trajectoryResults.generatedAt,
    reportGeneratedAt: new Date().toISOString(),
    trajectoryAccuracyTarget: trajectoryResults.trajectoryAccuracyTarget,
    perModelAccuracy: trajectoryResults.perModelAccuracy,
    judgeModelIds: JUDGE_MODEL_IDS,
    judgeScoredModels: judgeScoredModels(trajectoryResults.rows),
    judgeRegistryOverlap,
    guardrails: {
      suites: guardrailResults,
      // `.every()` on an empty array is vacuously true — an empty
      // `guardrailResults` must never read as "all passed."
      allBuiltSuitesPassed: guardrailResults.length > 0 && guardrailResults.every((suite) => suite.allPassed),
      pending: PENDING_GUARDRAIL_CATEGORIES,
    },
    cost: {
      perModel: cost,
      totalEstimatedCostUsd: totalEstimatedCostUsd(cost),
      mechanism: 'model-registry-price-list',
    },
    limitations,
  };
}
