import { describe, expect, it } from 'vitest';
import { runMistralJailbreakFlagRate, type ClassifyWithJailbreakScore } from './mistral-jailbreak-flag-rate.js';
import { DIRECT_PROMPT_INJECTION_EN_CASES } from '../agent/direct-prompt-injection.fixtures.js';

/**
 * AD-23 (evals.md non-gating metric): deterministic unit tests over an
 * injected `classify` fake — never a real Mistral call (that's the one
 * real-call verification run separately via `trajectory.eval.ts -t`).
 */
describe('runMistralJailbreakFlagRate (AD-23)', () => {
  it('AD-23: records one row per direct-injection input, with its flagged status and score', async () => {
    const classify: ClassifyWithJailbreakScore = async (text) => ({ flagged: text.includes('system prompt'), score: 0.87 });

    const result = await runMistralJailbreakFlagRate('real-key', classify);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.total).toBe(DIRECT_PROMPT_INJECTION_EN_CASES.length);
    expect(result.flaggedCount).toBe(result.rows.filter((row) => row.flagged).length);
    expect(result.rows).toHaveLength(DIRECT_PROMPT_INJECTION_EN_CASES.length);
    expect(result.rows.every((row) => row.jailbreakingScore === 0.87)).toBe(true);
  });

  it('AD-23: missing MISTRAL_API_KEY never fakes a number — reports an error, not a count', async () => {
    const result = await runMistralJailbreakFlagRate(undefined);

    expect(result).toEqual({ status: 'error', reason: 'MISTRAL_API_KEY is not set', rows: [] });
  });

  it('AD-23: a failed classifier call never fakes a number — reports an error row, not a partial count', async () => {
    const classify: ClassifyWithJailbreakScore = async () => {
      throw new Error('mistral: 500 upstream error');
    };

    const result = await runMistralJailbreakFlagRate('real-key', classify);

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toContain('one or more Mistral classifier calls failed');
    expect(result.rows[0]).toMatchObject({ error: 'mistral: 500 upstream error' });
  });
});
