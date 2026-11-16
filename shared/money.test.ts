import { describe, expect, it } from 'vitest';
import { convertMoney, formatMoney, EUR_USD_RATE } from './money.js';

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
// locale driven by the active UI language."
describe('formatMoney (AD-27: Intl.NumberFormat with the stored currency code)', () => {
  it('formats minor units as a currency string using the given locale and currency code', () => {
    const formatted = formatMoney({ amountMinorUnits: 150_00, currencyCode: 'EUR' }, 'en-US');

    expect(formatted).toBe('€150.00');
  });
});
