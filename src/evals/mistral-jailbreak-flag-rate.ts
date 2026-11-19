import { Mistral } from '@mistralai/mistralai';
import { JAILBREAK_CATEGORY, MODERATION_MODEL_NAME } from '../agent/moderation.js';
import { DIRECT_PROMPT_INJECTION_EN_CASES } from '../agent/direct-prompt-injection.fixtures.js';

/**
 * AD-23 (evals.md): "a separate non-gating metric ... how often Mistral
 * Moderation's own jailbreak category flagged each of these four inputs on
 * its own." One row per direct-injection input — visibility only, never
 * read by any pass/fail guardrail check.
 */
export interface MistralJailbreakFlagRateRow {
  label: string;
  flagged?: boolean;
  jailbreakingScore?: number | null;
  error?: string;
}

export type MistralJailbreakFlagRateResult =
  | { status: 'ok'; total: number; flaggedCount: number; rows: MistralJailbreakFlagRateRow[] }
  | { status: 'error'; reason: string; rows: MistralJailbreakFlagRateRow[] };

export type ClassifyWithJailbreakScore = (text: string) => Promise<{ flagged: boolean; score: number | null }>;

/** Same DI seam as `src/agent/moderation.ts`'s `defaultClassify` — production
 * wires the real Mistral Moderation 2 call, tests inject a fake. Unlike
 * `defaultClassify`, this also surfaces the category's numeric score
 * (`categoryScores`), which the boolean-only `ClassifyText` discards. */
export function defaultClassifyWithJailbreakScore(apiKey: string): ClassifyWithJailbreakScore {
  const client = new Mistral({ apiKey });
  return async (text: string) => {
    const response = await client.classifiers.moderate({ model: MODERATION_MODEL_NAME, inputs: text });
    const result = response.results[0];
    return {
      flagged: result?.categories?.[JAILBREAK_CATEGORY] === true,
      score: result?.categoryScores?.[JAILBREAK_CATEGORY] ?? null,
    };
  };
}

/**
 * Sends `DIRECT_PROMPT_INJECTION_EN_CASES` (the English form of Story 6.1's
 * 4 direct-injection pattern categories — never a duplicated copy of the
 * strings) to the real Mistral classifier and records, per input, whether
 * its own `jailbreaking` category flagged it and at what score.
 *
 * Never throws: a missing key or a failed call becomes `status: 'error'`
 * with the real reason attached — "never fake a number" — so the report can
 * keep showing "Pending/error" instead of a confident but wrong count.
 */
export async function runMistralJailbreakFlagRate(
  apiKey: string | undefined,
  classify?: ClassifyWithJailbreakScore,
): Promise<MistralJailbreakFlagRateResult> {
  if (!apiKey) {
    return { status: 'error', reason: 'MISTRAL_API_KEY is not set', rows: [] };
  }

  const classifyFn = classify ?? defaultClassifyWithJailbreakScore(apiKey);
  const rows: MistralJailbreakFlagRateRow[] = [];

  for (const [label, , text] of DIRECT_PROMPT_INJECTION_EN_CASES) {
    try {
      const { flagged, score } = await classifyFn(text);
      rows.push({ label, flagged, jailbreakingScore: score });
    } catch (error) {
      rows.push({ label, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (rows.some((row) => row.error !== undefined)) {
    return { status: 'error', reason: 'one or more Mistral classifier calls failed — see rows for detail', rows };
  }

  return {
    status: 'ok',
    total: rows.length,
    flaggedCount: rows.filter((row) => row.flagged === true).length,
    rows,
  };
}
