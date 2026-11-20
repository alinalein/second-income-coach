import { describe, expect, it } from 'vitest';
import { computeModelCosts, groupCostTotals, totalEstimatedCostUsd, type ModelCallUsageRow, type ModelRoleKey } from './cost.js';
import { EVAL_ONLY_MODEL_ID, JUDGE_MODEL_IDS } from './constants.js';

const PRICED_MODEL_ID = 'openai/gpt-6-luna'; // $0.1/$0.5 per 1M (src/evals/eval-price-table.ts)
const UNPRICED_MODEL_ID = 'unknown-provider/not-in-the-eval-price-table';
const JUDGE_ONLY_MODEL_ID = JUDGE_MODEL_IDS[1]; // deepseek/deepseek-v4.1-flash — never a target model

/** AD-21 + evals.md report requirement: cost computed from the eval-only
 * price table (`eval-price-table.ts`, Job B — deliberately not
 * `MODEL_REGISTRY`) against the eval run's own actual token usage, split by
 * (model, role) so a model that is both a target-under-test and a judge
 * (`google/gemini-3.8-flash`) is never double-counted or merged. */
describe('computeModelCosts', () => {
  it("prices a model from the eval-only price table's per-1M rates", () => {
    const usages: ModelCallUsageRow[] = [{ modelId: PRICED_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' }];
    const [summary] = computeModelCosts(usages, [{ modelId: PRICED_MODEL_ID, role: 'target' }]);
    expect(summary).toMatchObject({ role: 'target', inputTokens: 1_000_000, outputTokens: 1_000_000, callCount: 1, estimatedCostUsd: 0.6, usageComplete: true });
  });

  // Job B: the eval-only model (never in MODEL_REGISTRY, AD-20) now has its
  // own real price in the eval-only table — a deliberate behavior change
  // from the registry-based mechanism this replaces.
  it('prices the eval-only Sonnet model from the eval-only table, not MODEL_REGISTRY', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: EVAL_ONLY_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' }];
    const [summary] = computeModelCosts(usages, [{ modelId: EVAL_ONLY_MODEL_ID, role: 'target' }]);
    expect(summary?.estimatedCostUsd).toBe(12); // $2/1M in + $10/1M out
  });

  it('never guesses a price for a model absent from the eval-only price table', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: UNPRICED_MODEL_ID, caseId: 'case-1', inputTokens: 500, outputTokens: 200, complete: true, role: 'target' }];
    const [summary] = computeModelCosts(usages, [{ modelId: UNPRICED_MODEL_ID, role: 'target' }]);
    expect(summary).toMatchObject({ inputTokens: 500, outputTokens: 200, estimatedCostUsd: null, pricePerMillionInputTokens: null, pricePerMillionOutputTokens: null });
  });

  it('a model with no recorded calls shows zero tokens and zero cost, not null', () => {
    const [summary] = computeModelCosts([], [{ modelId: PRICED_MODEL_ID, role: 'target' }]);
    expect(summary).toMatchObject({ inputTokens: 0, outputTokens: 0, callCount: 0, estimatedCostUsd: 0, usageComplete: false });
  });

  it('marks usageComplete false if any underlying call had incomplete usage', () => {
    const usages: ModelCallUsageRow[] = [
      { modelId: PRICED_MODEL_ID, caseId: 'case-1', inputTokens: 100, outputTokens: 50, complete: true, role: 'target' },
      { modelId: PRICED_MODEL_ID, caseId: 'case-2', inputTokens: 0, outputTokens: 0, complete: false, role: 'target' },
    ];
    const [summary] = computeModelCosts(usages, [{ modelId: PRICED_MODEL_ID, role: 'target' }]);
    expect(summary?.usageComplete).toBe(false);
  });

  it("a duplicate (modelId, role) pair in modelRoles never double-counts that entry's cost", () => {
    const usages: ModelCallUsageRow[] = [{ modelId: PRICED_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' }];
    const summaries = computeModelCosts(usages, [
      { modelId: PRICED_MODEL_ID, role: 'target' },
      { modelId: PRICED_MODEL_ID, role: 'target' },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.estimatedCostUsd).toBe(0.6);
  });

  // evals.md report requirement: `google/gemini-3.8-flash` is both a
  // target-under-test model and a pinned judge (Story 6.2 AC3/AC4's own
  // known overlap) — its two roles' token usage must never be folded into
  // one row, or "judges" cost would double-count (or hide) its target cost.
  it('the same model id in two roles (target vs. judge) is tracked as two separate rows, never merged', () => {
    const modelId = 'google/gemini-3.8-flash';
    const usages: ModelCallUsageRow[] = [
      { modelId, caseId: 'target-case', inputTokens: 1000, outputTokens: 100, complete: true, role: 'target' },
      { modelId, caseId: 'judge-case', inputTokens: 2000, outputTokens: 200, complete: true, role: 'judge' },
    ];
    const summaries = computeModelCosts(usages, [
      { modelId, role: 'target' },
      { modelId, role: 'judge' },
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.role === 'target')).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    expect(summaries.find((s) => s.role === 'judge')).toMatchObject({ inputTokens: 2000, outputTokens: 200 });
  });

  it('a row with no role recorded (a trajectory-results.json written before judge-call capture existed) is treated as "target"', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: PRICED_MODEL_ID, caseId: 'case-1', inputTokens: 100, outputTokens: 50, complete: true }];
    const [summary] = computeModelCosts(usages, [{ modelId: PRICED_MODEL_ID, role: 'target' }]);
    expect(summary).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
});

describe('totalEstimatedCostUsd', () => {
  it('sums only priced entries, never folding an unpriced null in as zero-masking-unknown', () => {
    const costs = computeModelCosts(
      [
        { modelId: PRICED_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' },
        { modelId: UNPRICED_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' },
      ],
      [
        { modelId: PRICED_MODEL_ID, role: 'target' },
        { modelId: UNPRICED_MODEL_ID, role: 'target' },
      ],
    );
    expect(totalEstimatedCostUsd(costs)).toBe(0.6);
  });
});

/** evals.md report requirement: "report cost per group: target models,
 * Sonnet, judges, total." */
describe('groupCostTotals', () => {
  it('splits target models (excluding Sonnet), Sonnet, and judges into separate subtotals', () => {
    const usages: ModelCallUsageRow[] = [
      { modelId: PRICED_MODEL_ID, caseId: 'c1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' },
      { modelId: EVAL_ONLY_MODEL_ID, caseId: 'c1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'target' },
      { modelId: JUDGE_ONLY_MODEL_ID, caseId: 'c1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true, role: 'judge' },
    ];
    const modelRoles: ModelRoleKey[] = [
      { modelId: PRICED_MODEL_ID, role: 'target' },
      { modelId: EVAL_ONLY_MODEL_ID, role: 'target' },
      { modelId: JUDGE_ONLY_MODEL_ID, role: 'judge' },
    ];
    const costs = computeModelCosts(usages, modelRoles);
    const groups = groupCostTotals(costs, EVAL_ONLY_MODEL_ID);

    expect(groups.targetModels).toMatchObject({ estimatedCostUsd: 0.6, allPriced: true, allRecorded: true });
    expect(groups.sonnet).toMatchObject({ estimatedCostUsd: 12, allPriced: true, allRecorded: true });
    expect(groups.judges).toMatchObject({ allPriced: true, allRecorded: true });
  });

  it('a group with nothing recorded this run reports allRecorded: false, never a guessed $0 total', () => {
    const modelRoles: ModelRoleKey[] = JUDGE_MODEL_IDS.map((modelId) => ({ modelId, role: 'judge' }));
    const costs = computeModelCosts([], modelRoles);
    const groups = groupCostTotals(costs, EVAL_ONLY_MODEL_ID);
    expect(groups.judges.allRecorded).toBe(false);
  });
});
