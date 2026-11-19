import { describe, expect, it } from 'vitest';
import { parseVitestJsonReport } from './guardrails.js';

/**
 * AC 6.3-1 (guardrail pass/fail): `parseVitestJsonReport` is the pure
 * piece of `runGuardrailSuites`'s real-run path, tested without spawning a
 * process.
 *
 * `runGuardrailSuites` itself (the real `vitest run` child-process path)
 * was manually verified this session (see spec Verification) rather than
 * covered by an automated test here: a real-subprocess test here would
 * re-run the same two guardrail files `npm test` already runs directly via
 * `src/vitest.config.ts`'s default glob, adding ~12s to every `npm test`
 * for zero net regression coverage (Review Triage Log). Re-verify manually
 * if `guardrails.ts`'s spawn/parse wiring changes.
 */
describe('parseVitestJsonReport', () => {
  it.each([
    ['all passed', '{"numTotalTests":11,"numPassedTests":11,"numFailedTests":0}', { total: 11, passed: 11, failed: 0 }],
    ['some failed', '{"numTotalTests":6,"numPassedTests":4,"numFailedTests":2}', { total: 6, passed: 4, failed: 2 }],
    // Review Triage Log: a `testNamePattern`-filtered run — the 6
    // non-matching tests come back `numPendingTests: 6`, never excluded
    // from `numTotalTests` by vitest itself; `total` must subtract them so
    // a scoped suite entry reports "1 total, 1 passed," not "7 total, 1
    // passed."
    ['testNamePattern-filtered run (pending tests excluded from total)', '{"numTotalTests":7,"numPassedTests":1,"numFailedTests":0,"numPendingTests":6}', { total: 1, passed: 1, failed: 0 }],
  ])('%s', (_label, raw, expected) => {
    expect(parseVitestJsonReport(raw)).toEqual(expected);
  });

  it('throws a specific error when the reporter shape does not match, instead of returning NaN/undefined counts', () => {
    expect(() => parseVitestJsonReport('{"someOtherShape":true}')).toThrow(/unexpected vitest JSON reporter shape/);
  });
});
