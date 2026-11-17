import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { setCurrency } from './set_currency.js';

// AC1: "the user picks EUR or USD -> set_currency persists the choice in the
// currency column" / AD-4/AD-27: "a plain deterministic Postgres write - not
// an LLM decision".
describe('setCurrency (AC1: plain deterministic Postgres write)', () => {
  it.each([['EUR'], ['USD']] as const)('writes the validated currency %s for the given user', async (currency) => {
    const updateCurrency = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;

    await setCurrency(db, 'user-1', currency, { updateCurrency });

    expect(updateCurrency).toHaveBeenCalledWith(db, 'user-1', currency);
  });
});
