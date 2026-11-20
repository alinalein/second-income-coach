import { buildCostTotal, computeModelCosts, groupCostTotals, type CostGroups, type ModelCallUsageRow, type ModelCostSummary, type ModelRoleKey } from './cost.js';
import { EVAL_PRICE_AS_OF, EVAL_PRICE_SOURCE } from './eval-price-table.js';
import { PENDING_GUARDRAIL_CATEGORIES, type GuardrailSuiteResult, type PendingGuardrailCategory } from './guardrails.js';
import { EVAL_MODEL_IDS, EVAL_ONLY_MODEL_ID, JUDGE_MODEL_IDS } from './constants.js';
import type { MistralJailbreakFlagRateResult, MistralJailbreakFlagRateRow } from './mistral-jailbreak-flag-rate.js';
import { ackLatencyByModel, deterministicLatencyByModel, type AckLatencyRow } from './latency.js';

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
  /** User-requested (2026-11-20): see `trajectory.eval.ts`'s own field of
   * the same name. */
  durationMs?: number;
}

export interface TrajectoryResults {
  generatedAt: string;
  trajectoryAccuracyTarget: number;
  perModelAccuracy: ModelAccuracy[];
  rows: ResultRow[];
  modelCallUsages?: ModelCallUsageRow[];
  /** AD-23's non-gating metric (Stories 6.2/6.3 follow-up). Optional for
   * backward compatibility with a `trajectory-results.json` written before
   * this field existed — `buildReport` below renders that absence the same
   * as a live run's own "Pending/error", never as a silent 0. */
  mistralJailbreakFlagRate?: MistralJailbreakFlagRateResult;
  /** User-requested (2026-11-20, amended): one row per `EVAL_MODEL_IDS`
   * entry, written by `trajectory.eval.ts`'s own dedicated `it`s as part of
   * this same run (epics.md Story 7.5: "no separate latency file or
   * step"). Optional for backward compatibility with a `trajectory-
   * results.json` written before this field existed. */
  ackLatencyRows?: AckLatencyRow[];
}

/** The report's own rendering of AD-23's non-gating metric — `'pending'`
 * covers both "the step errored" and "this results file predates the step",
 * deliberately collapsed into the same "Pending/error" wording rather than
 * distinguished, since neither case has a real number to show. */
export type MistralJailbreakFlagRateSection =
  | { status: 'ok'; total: number; flaggedCount: number; rows: MistralJailbreakFlagRateRow[] }
  | { status: 'pending'; reason: string };

function toMistralJailbreakFlagRateSection(raw: MistralJailbreakFlagRateResult | undefined): MistralJailbreakFlagRateSection {
  if (raw === undefined) {
    return { status: 'pending', reason: 'not recorded in this run (trajectory-results.json predates this metric, or the step did not run)' };
  }
  if (raw.status === 'error') {
    return { status: 'pending', reason: raw.reason };
  }
  return raw;
}

/**
 * Fix (2026-11-19): a quality case's judge score never made it past
 * `judgeScoredModels` (which only records *whether* a judge scored a model,
 * not what it scored) — the actual `score`/`comment`/`error` per
 * (model, case, judge) row was computed in `trajectory.eval.ts` and written
 * to `trajectory-results.json`, but `buildReport` never read it back out.
 * One row per quality `ResultRow`, verbatim — including a row whose judge
 * call itself failed (`error` set, `score: null`), so a judge timeout/error
 * is a visible recorded row here, never a silently dropped one.
 */
export interface QualityResultRow {
  modelId: string;
  caseId: string;
  judgeId: string;
  score: boolean | number | null;
  comment?: string;
  error?: string;
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
  qualityResults: QualityResultRow[];
  guardrails: {
    suites: GuardrailSuiteResult[];
    allBuiltSuitesPassed: boolean;
    pending: readonly PendingGuardrailCategory[];
  };
  mistralJailbreakFlagRate: MistralJailbreakFlagRateSection;
  cost: {
    perModel: ModelCostSummary[];
    totalEstimatedCostUsd: number;
    /** Plain English, computed by `buildCostTotal` — what `totalEstimatedCostUsd`
     * actually covers, e.g. "target models + Sonnet; judges not recorded".
     * The headline card and the detail "Total (...)" line both show this
     * exact string, so they can never disagree about what the number means. */
    totalLabel: string;
    mechanism: string;
    priceAsOf: string;
    priceSource: string;
    groups: CostGroups;
  };
  /** User-requested (2026-11-20): per-model latency visibility — "Start
   * this step" felt slow, and nothing else here measured how much of that
   * is the model call itself, or how that differs by model. Every entry
   * covers every `EVAL_MODEL_IDS` id; a model with nothing measured yet
   * gets `null` fields, never a fabricated number. */
  latency: {
    /** The direct `/steps/:stepId/start-ack` model call (`start-step-ack-
     * latency.eval.ts`'s own dedicated, cheap step) — `null` when that
     * step hasn't been run for this results file. */
    ackByModel: { modelId: string; medianMs: number | null; maxMs: number | null; calls: number }[];
    /** A full deterministic trajectory case's own agent turn — `null` when
     * no row for that model recorded a `durationMs` (a `trajectory-
     * results.json` predating that field, or every row errored). */
    deterministicByModel: { modelId: string; medianMs: number | null }[];
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

function qualityResults(rows: readonly ResultRow[]): QualityResultRow[] {
  return rows
    .filter((row): row is ResultRow & { judgeId: string } => row.caseType === 'quality' && row.judgeId !== undefined)
    .map((row) => ({ modelId: row.modelId, caseId: row.caseId, judgeId: row.judgeId, score: row.score, comment: row.comment, error: row.error }));
}

/**
 * Story 6.3 AC: "known limitations (cross-referencing Epic 7's Story 7.4,
 * plus the judge/registry-overlap note ... from Story 6.2) and the eval
 * run's own estimated cost." Pure function — takes the already-produced
 * results of Stories 6.1 (guardrails) and 6.2 (trajectory), never runs
 * either itself.
 */
export interface RunCompletenessResult {
  complete: boolean;
  reason?: string;
}

/**
 * "Never publish from a partial run" rule (Stories 6.2/6.3 follow-up): a
 * `-t`-filtered `npm run eval` writes a `trajectory-results.json` with
 * fewer rows than a real full run (missing model(s), a filtered-down
 * deterministic case count, or the AD-23 step skipped entirely) —
 * `generate-report.ts` checks this before writing the committed
 * `src/evals/published/eval-results.json`, never after.
 */
export function assessRunCompleteness(trajectoryResults: TrajectoryResults): RunCompletenessResult {
  const modelIds = trajectoryResults.perModelAccuracy.map((entry) => entry.modelId);
  const missingModels = EVAL_MODEL_IDS.filter((id) => !modelIds.includes(id));
  if (missingModels.length > 0) {
    return { complete: false, reason: `missing model(s) in perModelAccuracy: ${missingModels.join(', ')} (looks like a partial, -t-filtered run)` };
  }

  const caseCounts = new Set(trajectoryResults.perModelAccuracy.map((entry) => entry.deterministicCaseCount));
  if (caseCounts.has(0) || caseCounts.size > 1) {
    return {
      complete: false,
      reason: `deterministicCaseCount is zero or inconsistent across models (${[...caseCounts].join(', ')}) (looks like a partial, -t-filtered run)`,
    };
  }

  if (trajectoryResults.mistralJailbreakFlagRate === undefined) {
    return { complete: false, reason: 'mistralJailbreakFlagRate (AD-23) is missing from the results file (looks like a partial, -t-filtered run)' };
  }

  return { complete: true };
}

export function buildReport(trajectoryResults: TrajectoryResults, guardrailResults: GuardrailSuiteResult[]): ReportData {
  const modelIds = trajectoryResults.perModelAccuracy.map((entry) => entry.modelId);
  const judgeRegistryOverlap = JUDGE_MODEL_IDS.map((judgeId) => ({ judgeId, alsoRegistryEntry: modelIds.includes(judgeId) }));
  const overlappingJudges = judgeRegistryOverlap.filter((entry) => entry.alsoRegistryEntry).map((entry) => entry.judgeId);

  const modelRoles: ModelRoleKey[] = [
    ...modelIds.map((modelId): ModelRoleKey => ({ modelId, role: 'target' })),
    ...JUDGE_MODEL_IDS.map((modelId): ModelRoleKey => ({ modelId, role: 'judge' })),
  ];
  const cost = computeModelCosts(trajectoryResults.modelCallUsages ?? [], modelRoles);
  const groups = groupCostTotals(cost, EVAL_ONLY_MODEL_ID);
  // User-requested (2026-11-20, amended): "sum every group that has a
  // price ... label it exactly what it covers ... never present a partial
  // sum as the full cost" — only `'measured'` groups are summed, and
  // `totalLabel` names every excluded group with its own reason.
  const { totalEstimatedCostUsd, totalLabel } = buildCostTotal(groups);
  const allGroupsMeasured = groups.targetModels.status === 'measured' && groups.sonnet.status === 'measured' && groups.judges.status === 'measured';
  const unpricedModelIds = cost.filter((entry) => entry.estimatedCostUsd === null).map((entry) => `${entry.modelId} (${entry.role})`);

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
      summary: `${unpricedModelIds.join(', ')} has no price in the eval-only price table (${EVAL_PRICE_SOURCE}, as of ${EVAL_PRICE_AS_OF}) — token usage is shown, cost is not estimated (AD-21: never a guessed price).`,
    });
  }

  limitations.push({
    id: 'cost-mechanism-not-built',
    summary: 'This cost estimate is computed directly from an eval-only price table, not the CAP-8 token/cost mechanism (Story 5.2), which is not yet built.',
  });

  if (!allGroupsMeasured) {
    limitations.push({
      id: 'judge-call-cost-excluded',
      summary: `The "Estimated cost" total covers ${totalLabel} — see the cost groups above for exactly which calls were recorded and priced this run.`,
    });
  }

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
    qualityResults: qualityResults(trajectoryResults.rows),
    guardrails: {
      suites: guardrailResults,
      // `.every()` on an empty array is vacuously true — an empty
      // `guardrailResults` must never read as "all passed."
      allBuiltSuitesPassed: guardrailResults.length > 0 && guardrailResults.every((suite) => suite.allPassed),
      pending: PENDING_GUARDRAIL_CATEGORIES,
    },
    mistralJailbreakFlagRate: toMistralJailbreakFlagRateSection(trajectoryResults.mistralJailbreakFlagRate),
    cost: {
      perModel: cost,
      totalEstimatedCostUsd,
      totalLabel,
      mechanism: 'eval-only-price-table',
      priceAsOf: EVAL_PRICE_AS_OF,
      priceSource: EVAL_PRICE_SOURCE,
      groups,
    },
    latency: {
      ackByModel: ackLatencyByModel(modelIds, trajectoryResults.ackLatencyRows),
      deterministicByModel: deterministicLatencyByModel(trajectoryResults.rows, modelIds),
    },
    limitations,
  };
}
