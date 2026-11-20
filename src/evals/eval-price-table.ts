/**
 * User-requested (2026-11-20, Job B): eval-only pricing, deliberately
 * separate from `src/agent/registry.ts`'s `MODEL_REGISTRY` — that registry's
 * prices are the user-facing, currency-converted figures (AD-21/AD-27);
 * this table exists only so the eval report can price every model it
 * actually calls (including `anthropic/claude-sonnet-5.5`, intentionally
 * absent from the registry as eval-only, AD-20, and the two judge models,
 * which are never registry entries at all) from one real, dated source.
 * Values below are `pricing.prompt`/`pricing.completion` (USD per token)
 * from `GET https://openrouter.ai/api/v1/models` (no key required),
 * converted to USD per 1M tokens, fetched on `EVAL_PRICE_AS_OF`. A model
 * absent from this table (or from a future refetch) prices as `null` —
 * AD-21: "never a guessed or zero cost."
 */
export const EVAL_PRICE_AS_OF = '2026-11-20';

export const EVAL_PRICE_SOURCE = 'OpenRouter public models endpoint (GET https://openrouter.ai/api/v1/models, no key required)';

export interface EvalPriceEntry {
  modelId: string;
  pricePerMillionInputTokens: number;
  pricePerMillionOutputTokens: number;
}

export const EVAL_PRICE_TABLE: readonly EvalPriceEntry[] = [
  { modelId: 'openai/gpt-6-luna', pricePerMillionInputTokens: 0.1, pricePerMillionOutputTokens: 0.5 },
  { modelId: 'google/gemini-3.8-flash', pricePerMillionInputTokens: 0.825, pricePerMillionOutputTokens: 4.125 },
  { modelId: 'anthropic/claude-haiku-4.5', pricePerMillionInputTokens: 1, pricePerMillionOutputTokens: 5 },
  { modelId: 'anthropic/claude-sonnet-5.5', pricePerMillionInputTokens: 2, pricePerMillionOutputTokens: 10 },
  { modelId: 'deepseek/deepseek-v4.1-flash', pricePerMillionInputTokens: 0.3, pricePerMillionOutputTokens: 1.2 },
];

export function findEvalPrice(modelId: string): EvalPriceEntry | undefined {
  return EVAL_PRICE_TABLE.find((entry) => entry.modelId === modelId);
}
