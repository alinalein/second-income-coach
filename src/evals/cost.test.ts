import { describe, expect, it } from 'vitest';
import { computeModelCosts, totalEstimatedCostUsd, type ModelCallUsageRow } from './cost.js';
import { EVAL_ONLY_MODEL_ID } from './constants.js';

const REGISTRY_MODEL_ID = 'openai/gpt-6-luna'; // $0.1/$0.5 per 1M (src/agent/registry.ts)

/** AC 6.3-3: cost computed from the registry price list against the eval
 * run's own actual token usage, and AD-21's "no registered price -> token
 * count only, never a guessed or zero cost" for the eval-only model. */
describe('computeModelCosts', () => {
  it('prices a registry model from its registered per-1M rates', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: REGISTRY_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true }];
    const [summary] = computeModelCosts(usages, [REGISTRY_MODEL_ID]);
    expect(summary).toMatchObject({ inputTokens: 1_000_000, outputTokens: 1_000_000, callCount: 1, estimatedCostUsd: 0.6, usageComplete: true });
  });

  it('never guesses a price for a model absent from the registry (eval-only model)', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: EVAL_ONLY_MODEL_ID, caseId: 'case-1', inputTokens: 500, outputTokens: 200, complete: true }];
    const [summary] = computeModelCosts(usages, [EVAL_ONLY_MODEL_ID]);
    expect(summary).toMatchObject({ inputTokens: 500, outputTokens: 200, estimatedCostUsd: null, pricePerMillionInputTokens: null, pricePerMillionOutputTokens: null });
  });

  it('a model with no recorded calls shows zero tokens and zero cost, not null', () => {
    const [summary] = computeModelCosts([], [REGISTRY_MODEL_ID]);
    expect(summary).toMatchObject({ inputTokens: 0, outputTokens: 0, callCount: 0, estimatedCostUsd: 0, usageComplete: false });
  });

  it('marks usageComplete false if any underlying call had incomplete usage', () => {
    const usages: ModelCallUsageRow[] = [
      { modelId: REGISTRY_MODEL_ID, caseId: 'case-1', inputTokens: 100, outputTokens: 50, complete: true },
      { modelId: REGISTRY_MODEL_ID, caseId: 'case-2', inputTokens: 0, outputTokens: 0, complete: false },
    ];
    const [summary] = computeModelCosts(usages, [REGISTRY_MODEL_ID]);
    expect(summary?.usageComplete).toBe(false);
  });

  it('a duplicate model id in modelIds never double-counts that model\'s cost', () => {
    const usages: ModelCallUsageRow[] = [{ modelId: REGISTRY_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true }];
    const summaries = computeModelCosts(usages, [REGISTRY_MODEL_ID, REGISTRY_MODEL_ID]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.estimatedCostUsd).toBe(0.6);
  });
});

describe('totalEstimatedCostUsd', () => {
  it('sums only priced entries, never folding an unpriced null in as zero-masking-unknown', () => {
    const costs = computeModelCosts(
      [
        { modelId: REGISTRY_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true },
        { modelId: EVAL_ONLY_MODEL_ID, caseId: 'case-1', inputTokens: 1_000_000, outputTokens: 1_000_000, complete: true },
      ],
      [REGISTRY_MODEL_ID, EVAL_ONLY_MODEL_ID],
    );
    expect(totalEstimatedCostUsd(costs)).toBe(0.6);
  });
});
