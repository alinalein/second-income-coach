import { describe, expect, it } from 'vitest';
import { convertMoney, formatMoney, moneySchema, EUR_USD_RATE } from './money.js';

// AD-27: "Money is stored as integer minor units ... never a float." Story
// 6.1 AC: "confirming integer-minor-units storage (never floats)" - the
// boundary this schema enforces, not just the happy path other tests assume.
describe('moneySchema (AD-27/Story 6.1: amountMinorUnits must be an integer, never a float)', () => {
  it('rejects a non-integer amountMinorUnits', () => {
    expect(() => moneySchema.parse({ amountMinorUnits: 10.5, currencyCode: 'EUR' })).toThrow();
  });

  it('accepts an integer amountMinorUnits', () => {
    expect(() => moneySchema.parse({ amountMinorUnits: 10, currencyCode: 'EUR' })).not.toThrow();
  });
});

// AD-27: "Money is stored as integer minor units ... Conversion uses one
// configured EUR/USD rate ... every converted amount is visibly labeled as
// an estimate" / "a same-currency amount is exact, never labeled an
// estimate". Table-driven: same function, same-currency vs. cross-currency
// branches.
describe('convertMoney (AD-27: configured-rate conversion + estimate labeling)', () => {
  it.each([
    ['same currency (EUR -> EUR): exact, not an estimate', { amountMinorUnits: 10_000, currencyCode: 'EUR' as const }, 'EUR' as const, 10_000, false],
    ['cross currency (EUR -> USD): uses the configured rate, labeled an estimate', { amountMinorUnits: 10_000, currencyCode: 'EUR' as const }, 'USD' as const, Math.round(10_000 * EUR_USD_RATE), true],
  ])('%s', (_label, money, target, expectedAmount, expectedIsEstimate) => {
    const result = convertMoney(money, target);

    expect(result.amountMinorUnits).toBe(expectedAmount);
    expect(result.currencyCode).toBe(target);
    expect(result.isEstimate).toBe(expectedIsEstimate);
  });
});

// AD-27: "Formatting uses `Intl.NumberFormat` with the currency code and a
// locale driven by the active UI language." Story 6.1 AC: "both EUR and USD
// are covered, each formatted under both the de-DE and en-US locales" -
// table-driven across the full 2x2 matrix (currency x locale are
// independent axes per this function's own contract).
describe('formatMoney (AD-27/Story 6.1: both currencies under both locales)', () => {
  it.each([
    ['EUR', 'en-US', '€150.00'],
    ['EUR', 'de-DE', '150,00 €'],
    ['USD', 'en-US', '$150.00'],
    ['USD', 'de-DE', '150,00 $'],
  ] as const)('formats %s minor units under %s locale', (currencyCode, locale, expected) => {
    const formatted = formatMoney({ amountMinorUnits: 150_00, currencyCode }, locale);

    expect(formatted).toBe(expected);
  });
});
