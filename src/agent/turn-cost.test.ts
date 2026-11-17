import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { computeMessageCost, convertStoredCost, sumTurnUsage } from './turn-cost.js';
import { DEFAULT_MODEL_ID } from './registry.js';

function aiMessage(inputTokens: number, outputTokens: number): AIMessage {
  return new AIMessage({
    content: 'hi',
    usage_metadata: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  });
}

// AD-21 I/O matrix: "Multi-call turn ... sums every model call made during
// that turn's full agent-loop execution, not just the final response".
describe('sumTurnUsage', () => {
  it('sums tokens across every AI message in the turn, not just the last one', () => {
    const usage = sumTurnUsage([aiMessage(100, 20), aiMessage(50, 80)]);
    expect(usage).toEqual({ inputTokens: 150, outputTokens: 100, complete: true });
  });
});

// AD-21 I/O matrix: "No registry price ... cost.amount is null; token
// counts still shown; never a guessed/$0 figure".
describe('computeMessageCost: no registry price match', () => {
  it('returns token counts with a null amount for an unregistered model id', () => {
    const cost = computeMessageCost({ inputTokens: 1000, outputTokens: 500 }, 'some/unregistered-model', 'USD');

    expect(cost.amountMicroUnitsUsd).toBeNull();
    expect(cost.displayAmount).toBeNull();
    expect(cost.isEstimate).toBe(false);
    expect(cost).toMatchObject({ inputTokens: 1000, outputTokens: 500, modelId: 'some/unregistered-model' });
  });
});

// Bug fix (epics.md amendment: "a typical chat turn that costs a fraction
// of a cent ... stored as an integer in micro-units"). Table-driven across
// known (tokens, price) pairs, including the exact user-reported case
// (869/532 tokens on the default model) — proves the stored integer is
// micro-USD (`tokens * pricePerMillion`, since price is USD-per-1,000,000-
// tokens), not the old cents formula that rounded this same case to 0.
describe('computeMessageCost: stored micro-unit value (bug fix)', () => {
  it.each([
    ['the exact user-reported case: 869/532 tokens on gpt-6-luna ($0.10/$0.50 per 1M)', 869, 532, 353],
    ['a round number: 1,000,000/1,000,000 tokens', 1_000_000, 1_000_000, 600_000],
    ['zero tokens -> zero cost, no special-casing needed', 0, 0, 0],
  ] as const)('%s', (_label, inputTokens, outputTokens, expectedMicroUnitsUsd) => {
    const cost = computeMessageCost({ inputTokens, outputTokens }, DEFAULT_MODEL_ID, 'USD');
    expect(cost.amountMicroUnitsUsd).toBe(expectedMicroUnitsUsd);
  });
});

// AD-21/AD-27 I/O matrix: "EUR user ... isEstimate: true, labeled estimate"
// / "USD user ... no conversion, isEstimate: false" — the registry price is
// USD-native, so only a genuine EUR conversion is ever labeled an estimate.
describe('computeMessageCost: currency conversion', () => {
  it.each([
    ['USD', false],
    ['EUR', true],
  ] as const)('%s user -> isEstimate %s', (currency, expectedIsEstimate) => {
    const cost = computeMessageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, DEFAULT_MODEL_ID, currency);

    expect(cost.displayAmount?.currencyCode).toBe(currency);
    expect(cost.isEstimate).toBe(expectedIsEstimate);
    expect(cost.amountMicroUnitsUsd).not.toBeNull();
  });
});

// AD-27 Design Notes: "Display conversion happens fresh on every read ...
// without touching stored rows" — `convertStoredCost` re-derives the
// display pair from an already-persisted row, never re-pricing against the
// (possibly since-changed) registry.
describe('convertStoredCost', () => {
  it.each([
    ['a priced row', DEFAULT_MODEL_ID, 100, { amount: { currencyCode: 'EUR' }, isEstimate: true }],
    ['a row with no price snapshot (AD-21: never a guessed figure)', 'some/unregistered-model', null, { amount: null, isEstimate: false }],
  ] as const)('%s', (_label, modelId, amountMicroUnitsUsd, expected) => {
    const display = convertStoredCost({ modelId, inputTokens: 10, outputTokens: 10, amountMicroUnitsUsd }, 'EUR');
    expect(display).toMatchObject(expected);
  });
});
