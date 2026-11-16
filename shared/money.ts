import { z } from 'zod';

/**
 * AD-27: "Money is stored as integer minor units plus an ISO currency code,
 * never a float." Story 2.2 is the first story to need money handling
 * (startup cost + sourced baseline rate on `generate_ideas`'s ideas) —
 * this is the one shared helper created here and reused by later stories
 * (4.4, 5.2, 5.5), never re-implemented per story.
 */
export const currencyCodeSchema = z.enum(['EUR', 'USD']);

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

export const moneySchema = z.object({
  amountMinorUnits: z.number().int(),
  currencyCode: currencyCodeSchema,
});

export type Money = z.infer<typeof moneySchema>;

/**
 * AD-27: "Conversion uses one configured EUR/USD rate with an as-of date
 * (same pattern as the model registry's `price_as_of`) — no live FX API
 * call." Expressed as "how many USD one EUR buys" — update both constants
 * together if this is ever manually refreshed.
 */
export const EUR_USD_RATE = 1.08;
export const EUR_USD_RATE_AS_OF = '2026-11-01';

export interface ConvertedMoney extends Money {
  /** AD-27: "every converted amount is visibly labeled as an estimate."
   * `false` for a same-currency "conversion" — that amount is exact, never
   * labeled an estimate. */
  isEstimate: boolean;
}

/**
 * Converts `money` into `targetCurrency` using the one configured EUR/USD
 * rate above — never a live FX call (AD-27). Same-currency input is
 * returned unchanged (and never marked an estimate); only a genuine
 * currency conversion sets `isEstimate: true`.
 */
export function convertMoney(money: Money, targetCurrency: CurrencyCode): ConvertedMoney {
  if (money.currencyCode === targetCurrency) {
    return { ...money, isEstimate: false };
  }

  const amountMinorUnits =
    money.currencyCode === 'EUR'
      ? Math.round(money.amountMinorUnits * EUR_USD_RATE)
      : Math.round(money.amountMinorUnits / EUR_USD_RATE);

  return { amountMinorUnits, currencyCode: targetCurrency, isEstimate: true };
}

/**
 * AD-27: "Formatting uses `Intl.NumberFormat` with the currency code and a
 * locale driven by the active UI language (AD-24) — locale and currency are
 * independent axes." `locale` is the caller's concern (e.g. the active UI
 * language's locale tag) — this helper never infers one from `currencyCode`.
 */
export function formatMoney(money: Money, locale: string): string {
  // `/ 100` assumes exactly 2 minor-unit decimal digits — true for both of
  // AD-27's currently-supported currencies (EUR, USD), but not universal
  // (e.g. JPY has 0, BHD has 3). A future currency addition must revisit
  // this divisor rather than assume it still holds.
  return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currencyCode }).format(
    money.amountMinorUnits / 100,
  );
}
