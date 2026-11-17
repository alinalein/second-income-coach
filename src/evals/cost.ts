import { findModelEntry } from '../agent/registry.js';

/** One real model call the eval run itself made (deterministic case: one
 * per (model, fixture); quality case: one per (model, fixture), shared by
 * both judges — see `trajectory.eval.ts`'s memoized generation). */
export interface ModelCallUsageRow {
  modelId: string;
  caseId: string;
  inputTokens: number;
  outputTokens: number;
  complete: boolean;
}

/**
 * AD-21: "A model with no registered price shows token count only, never a
 * guessed or zero cost." `anthropic/claude-sonnet-5.5` is intentionally
 * absent from `MODEL_REGISTRY` (eval-only, AD-20), so it always lands in
 * the `estimatedCostUsd: null` branch here — that's a known limitation the
 * report must disclose, not a bug to work around with a hardcoded price.
 */
export interface ModelCostSummary {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  pricePerMillionInputTokens: number | null;
  pricePerMillionOutputTokens: number | null;
  estimatedCostUsd: number | null;
  usageComplete: boolean;
}

export function computeModelCosts(usages: readonly ModelCallUsageRow[], modelIds: readonly string[]): ModelCostSummary[] {
  // Dedupe defensively — a duplicate id in `modelIds` would otherwise
  // double-count that model's tokens/cost in the per-model list and the
  // total.
  return Array.from(new Set(modelIds)).map((modelId) => {
    const rows = usages.filter((row) => row.modelId === modelId);
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const usageComplete = rows.length > 0 && rows.every((row) => row.complete);
    const entry = findModelEntry(modelId);

    if (!entry) {
      return { modelId, inputTokens, outputTokens, callCount: rows.length, pricePerMillionInputTokens: null, pricePerMillionOutputTokens: null, estimatedCostUsd: null, usageComplete };
    }

    const estimatedCostUsd =
      (inputTokens / 1_000_000) * entry.pricePerMillionInputTokens + (outputTokens / 1_000_000) * entry.pricePerMillionOutputTokens;

    return {
      modelId,
      inputTokens,
      outputTokens,
      callCount: rows.length,
      pricePerMillionInputTokens: entry.pricePerMillionInputTokens,
      pricePerMillionOutputTokens: entry.pricePerMillionOutputTokens,
      estimatedCostUsd,
      usageComplete,
    };
  });
}

/** Sums only the priced entries — an unpriced model's `null` never silently
 * becomes a 0 inside the total (AD-21). */
export function totalEstimatedCostUsd(costs: readonly ModelCostSummary[]): number {
  return costs.reduce((sum, cost) => sum + (cost.estimatedCostUsd ?? 0), 0);
}
