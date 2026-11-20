import { findEvalPrice } from './eval-price-table.js';

/** One real model call the eval run itself made (deterministic case: one
 * per (model, fixture); quality case: one per (model, fixture), shared by
 * both judges — see `trajectory.eval.ts`'s memoized generation; a judge's
 * own scoring call is a separate row, `role: 'judge'`, tagged via the
 * `createJudgeModels` callback seam in `judges.ts`). `role` is optional
 * only for backward compatibility with a `trajectory-results.json` written
 * before judge-call usage was captured — `computeModelCosts` below treats
 * an absent `role` as `'target'` (every row ever written before this field
 * existed was a target-model-under-test call). */
export interface ModelCallUsageRow {
  modelId: string;
  caseId: string;
  inputTokens: number;
  outputTokens: number;
  complete: boolean;
  role?: 'target' | 'judge';
}

/**
 * AD-21: "A model with no registered price shows token count only, never a
 * guessed or zero cost." Priced from `eval-price-table.ts` (a real, dated
 * OpenRouter fetch), never `MODEL_REGISTRY` (that's the user-facing,
 * currency-converted price list — a different concern, AD-27).
 */
export interface ModelCostSummary {
  modelId: string;
  role: 'target' | 'judge';
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  pricePerMillionInputTokens: number | null;
  pricePerMillionOutputTokens: number | null;
  estimatedCostUsd: number | null;
  usageComplete: boolean;
}

export interface ModelRoleKey {
  modelId: string;
  role: 'target' | 'judge';
}

/**
 * One row per (modelId, role) — deliberately keyed by both, not just
 * `modelId`: `google/gemini-3.8-flash` is both one of the 3 priced
 * target-under-test models and one of the 2 pinned judges (Story 6.2
 * AC3/AC4's own known overlap), and its target-call tokens must never be
 * folded into its judge-call tokens (or vice versa) when the report groups
 * cost by "target models" / "sonnet" / "judges" (`groupCostTotals` below).
 */
export function computeModelCosts(usages: readonly ModelCallUsageRow[], modelRoles: readonly ModelRoleKey[]): ModelCostSummary[] {
  // Dedupe defensively — a duplicate (modelId, role) pair in `modelRoles`
  // would otherwise double-count that entry's tokens/cost.
  const seenKeys = new Set<string>();
  const uniqueRoles = modelRoles.filter(({ modelId, role }) => {
    const key = `${modelId}::${role}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  return uniqueRoles.map(({ modelId, role }) => {
    const rows = usages.filter((row) => row.modelId === modelId && (row.role ?? 'target') === role);
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const usageComplete = rows.length > 0 && rows.every((row) => row.complete);
    const priceEntry = findEvalPrice(modelId);

    if (!priceEntry) {
      return {
        modelId,
        role,
        inputTokens,
        outputTokens,
        callCount: rows.length,
        pricePerMillionInputTokens: null,
        pricePerMillionOutputTokens: null,
        estimatedCostUsd: null,
        usageComplete,
      };
    }

    const estimatedCostUsd =
      (inputTokens / 1_000_000) * priceEntry.pricePerMillionInputTokens + (outputTokens / 1_000_000) * priceEntry.pricePerMillionOutputTokens;

    return {
      modelId,
      role,
      inputTokens,
      outputTokens,
      callCount: rows.length,
      pricePerMillionInputTokens: priceEntry.pricePerMillionInputTokens,
      pricePerMillionOutputTokens: priceEntry.pricePerMillionOutputTokens,
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

/**
 * User-requested (2026-11-20, amended): a group's own three-way status —
 * `'not-recorded'` (at least one of this group's rows never had a single
 * real call this run — the actual reason the "Judges" group used to show a
 * confirmed-looking `$0.0000`) takes priority over `'not-priced'` (every
 * call happened, but at least one row has no price); only `'measured'`
 * groups ever carry a real `estimatedCostUsd` or feed into the headline
 * total (AD-21 + "never show a partial sum as the total, and never present
 * 'not recorded' as $0.0000").
 */
export type CostGroupStatus = 'measured' | 'not-recorded' | 'not-priced';

/** One group's own subtotal (Job B: "report cost per group: target models,
 * Sonnet, judges, total"). `estimatedCostUsd` is `null` whenever `status`
 * isn't `'measured'` — a `0.0000`-looking number is never shown for a group
 * that simply wasn't recorded or priced. */
export interface GroupCostSummary {
  estimatedCostUsd: number | null;
  allPriced: boolean;
  allRecorded: boolean;
  status: CostGroupStatus;
}

function summarizeGroup(rows: readonly ModelCostSummary[]): GroupCostSummary {
  const allRecorded = rows.length > 0 && rows.every((row) => row.callCount > 0);
  const allPriced = rows.length > 0 && rows.every((row) => row.estimatedCostUsd !== null);
  const status: CostGroupStatus = !allRecorded ? 'not-recorded' : !allPriced ? 'not-priced' : 'measured';
  return {
    estimatedCostUsd: status === 'measured' ? totalEstimatedCostUsd(rows) : null,
    allPriced,
    allRecorded,
    status,
  };
}

export interface CostGroups {
  targetModels: GroupCostSummary;
  sonnet: GroupCostSummary;
  judges: GroupCostSummary;
}

/**
 * Splits `computeModelCosts`'s per-(model, role) rows into the three groups
 * Job B's report requirement names. `sonnetModelId` is pulled out of
 * "target models" into its own group rather than counted twice.
 */
export function groupCostTotals(costs: readonly ModelCostSummary[], sonnetModelId: string): CostGroups {
  return {
    targetModels: summarizeGroup(costs.filter((cost) => cost.role === 'target' && cost.modelId !== sonnetModelId)),
    sonnet: summarizeGroup(costs.filter((cost) => cost.role === 'target' && cost.modelId === sonnetModelId)),
    judges: summarizeGroup(costs.filter((cost) => cost.role === 'judge')),
  };
}

const COST_GROUP_LABELS: Record<keyof CostGroups, string> = {
  targetModels: 'target models',
  sonnet: 'Sonnet',
  judges: 'judges',
};

export interface CostTotal {
  totalEstimatedCostUsd: number;
  /** Plain English, computed — never hand-typed (AD-29's "generated, never
   * hand-copied" precedent) — e.g. "target models + Sonnet; judges not
   * recorded", or once every group is measured, just "target models +
   * Sonnet + judges" with no exclusion clause at all. The one label both
   * the headline card and the detail "Total (...)" line reuse verbatim, so
   * the two can never say different things about the same number. */
  totalLabel: string;
}

/**
 * User-requested (2026-11-20, amended): "sum every group that has a price
 * ... and label it exactly what it covers ... never present a partial sum
 * as the full cost." Only `'measured'` groups are summed; every excluded
 * group is named in the label with its own reason, so the label alone
 * always discloses whether the number is partial.
 */
export function buildCostTotal(groups: CostGroups): CostTotal {
  const keys = ['targetModels', 'sonnet', 'judges'] as const;
  const includedLabels: string[] = [];
  const excludedParts: string[] = [];
  let totalEstimatedCostUsd = 0;

  for (const key of keys) {
    const group = groups[key];
    const label = COST_GROUP_LABELS[key];
    if (group.status === 'measured') {
      includedLabels.push(label);
      totalEstimatedCostUsd += group.estimatedCostUsd ?? 0;
    } else {
      excludedParts.push(`${label} ${group.status === 'not-recorded' ? 'not recorded' : 'not priced'}`);
    }
  }

  const includedPart = includedLabels.join(' + ');
  const totalLabel =
    excludedParts.length === 0 ? includedPart : includedPart.length === 0 ? excludedParts.join('; ') : `${includedPart}; ${excludedParts.join('; ')}`;

  return { totalEstimatedCostUsd, totalLabel };
}
