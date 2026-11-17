import { isAIMessage, type BaseMessage } from '@langchain/core/messages';
import { convertMoney, type CurrencyCode, type Money } from '@app/shared';
import { findModelEntry } from './registry.js';

/**
 * Story 5.2 (AD-21): "sums every model call made during that turn's full
 * agent-loop execution, not just the final response." Mirrors
 * `src/evals/usage.ts`'s `sumUsage` exactly (same shape, same precedent: a
 * seen AI message with no `usage_metadata` makes the turn's total a floor,
 * not a precise figure) — deliberately re-implemented here rather than
 * imported, per Boundary ("not imported cross-module — evals stays
 * untouched").
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  complete: boolean;
}

export function sumTurnUsage(newMessages: readonly BaseMessage[]): TurnUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let sawAiMessage = false;
  let complete = true;

  for (const message of newMessages) {
    if (!isAIMessage(message)) continue;
    sawAiMessage = true;
    const usage = message.usage_metadata;
    if (usage) {
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
    } else {
      complete = false;
    }
  }

  return { inputTokens, outputTokens, complete: sawAiMessage && complete };
}

/**
 * The persistable + displayable shape for one turn's cost. `amountMinorUnitsUsd`/
 * `pricePerMillion*`/`priceAsOf` are the USD-native price snapshot persisted
 * verbatim (Design Notes: "never a pre-converted figure" — a later registry
 * price change must never retroactively alter a past message's recorded
 * cost). `displayAmount`/`isEstimate` are the one-time conversion to
 * `userCurrency` at the moment this was computed — the caller persists the
 * snapshot fields, not this converted pair, and recomputes the converted
 * pair fresh on every read via `convertStoredCost` below.
 */
export interface MessageCost {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  pricePerMillionInputTokens: number | null;
  pricePerMillionOutputTokens: number | null;
  priceAsOf: string | null;
  amountMinorUnitsUsd: number | null;
  displayAmount: Money | null;
  isEstimate: boolean;
}

/**
 * AD-21: "a model with no registered price shows token count only, never a
 * guessed or zero cost" — mirrors `src/evals/cost.ts`'s own null-on-no-price
 * branch. `modelId` is the turn's *actually-used* model (the resolved id
 * `src/agent/model.ts` tags onto every `AIMessage.response_metadata`, read
 * back by `src/agent/index.ts`'s outer node), not necessarily the one the
 * user had selected.
 *
 * AD-27: the registry price is USD-native; `userCurrency` only affects
 * `displayAmount`/`isEstimate` (a genuine conversion labels itself an
 * estimate; same-currency never does, per `convertMoney`) — never the
 * persisted `amountMinorUnitsUsd` snapshot.
 */
export function computeMessageCost(
  usage: Pick<TurnUsage, 'inputTokens' | 'outputTokens'>,
  modelId: string,
  userCurrency: CurrencyCode,
): MessageCost {
  const entry = findModelEntry(modelId);

  if (!entry) {
    return {
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricePerMillionInputTokens: null,
      pricePerMillionOutputTokens: null,
      priceAsOf: null,
      amountMinorUnitsUsd: null,
      displayAmount: null,
      isEstimate: false,
    };
  }

  const amountMinorUnitsUsd = Math.round(
    (usage.inputTokens / 1_000_000) * entry.pricePerMillionInputTokens * 100 +
      (usage.outputTokens / 1_000_000) * entry.pricePerMillionOutputTokens * 100,
  );
  const converted = convertMoney({ amountMinorUnits: amountMinorUnitsUsd, currencyCode: 'USD' }, userCurrency);

  return {
    modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    pricePerMillionInputTokens: entry.pricePerMillionInputTokens,
    pricePerMillionOutputTokens: entry.pricePerMillionOutputTokens,
    priceAsOf: entry.priceAsOf,
    amountMinorUnitsUsd,
    displayAmount: { amountMinorUnits: converted.amountMinorUnits, currencyCode: converted.currencyCode },
    isEstimate: converted.isEstimate,
  };
}

/**
 * The display-only pair (`amount`/`isEstimate`) embedded on a `ChatMessage`,
 * shared by both the POST reply (`computeMessageCost`'s own result, just
 * computed) and a `GET /messages` history read-back (re-derived here from
 * the already-persisted row). Kept as its own type so both call sites
 * produce the exact same shape without one importing the other's full
 * `MessageCost`.
 */
export interface MessageCostDisplay {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  amount: Money | null;
  isEstimate: boolean;
}

export function toMessageCostDisplay(cost: MessageCost): MessageCostDisplay {
  return { modelId: cost.modelId, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, amount: cost.displayAmount, isEstimate: cost.isEstimate };
}

/**
 * Design Notes/AD-27: "Display conversion happens fresh on every read ...
 * so a later currency-setting change changes what reloading shows without
 * touching stored rows." Converts an already-persisted cost row — never
 * re-looks-up the registry (that would let a since-changed registry price
 * retroactively alter a past message's figure, exactly what the Boundary
 * forbids) — so this is deliberately *not* built on top of
 * `computeMessageCost`.
 */
export function convertStoredCost(
  row: { modelId: string; inputTokens: number; outputTokens: number; amountMinorUnitsUsd: number | null },
  userCurrency: CurrencyCode,
): MessageCostDisplay {
  if (row.amountMinorUnitsUsd === null) {
    return { modelId: row.modelId, inputTokens: row.inputTokens, outputTokens: row.outputTokens, amount: null, isEstimate: false };
  }

  const converted = convertMoney({ amountMinorUnits: row.amountMinorUnitsUsd, currencyCode: 'USD' }, userCurrency);
  return {
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    amount: { amountMinorUnits: converted.amountMinorUnits, currencyCode: converted.currencyCode },
    isEstimate: converted.isEstimate,
  };
}
