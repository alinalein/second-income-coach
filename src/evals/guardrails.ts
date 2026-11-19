import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Story 6.3 (AC: "whether the 100%-bar safety/guardrail tests passed"):
 * the committed guardrail suites Story 6.1 added — safe to actually run,
 * every time, rather than hand-typed into the report. Most are deterministic
 * and free of any real network call (see their own doc comments); the
 * `activate_plan` entry is the one exception (Story 6.1's own AC requires
 * the HITL-bypass property to be proven against a real checkpointer/
 * Postgres, not a mock) — `testNamePattern` scopes that entry to only its
 * one HITL-bypass test, never the rest of that file's own (non-guardrail)
 * integration tests, so an unrelated failure there (e.g. the unique-index
 * test) is never misreported as a guardrail failure.
 */
export interface GuardrailSuiteDef {
  file: string;
  label: string;
  /** Review Triage Log: `vitest run`'s own `-t` filter — restricts this
   * entry to the one matching test name, when the file also contains
   * unrelated tests that aren't part of this guardrail category. */
  testNamePattern?: string;
}

export interface GuardrailSuiteResult extends GuardrailSuiteDef {
  total: number;
  passed: number;
  failed: number;
  allPassed: boolean;
}

export interface PendingGuardrailCategory {
  id: string;
  label: string;
  reason: string;
}

export const GUARDRAIL_SUITES: readonly GuardrailSuiteDef[] = [
  { file: 'agent/direct-prompt-injection.test.ts', label: 'Direct prompt-injection outcome (ignore instructions / output system prompt / list tools / injected check-in message, EN+DE)' },
  { file: 'agent/moderation-web-search.test.ts', label: 'web_search moderation, incl. simulated prompt injection via a search result (AD-11)' },
  { file: 'agent/moderation.test.ts', label: 'General moderation (AD-11): jailbreak, PII, unsafe-output, EN+DE' },
  { file: 'agent/guilt-language.test.ts', label: 'Guilt/streak-language guardrail (AD-12), EN+DE, once per personality' },
  {
    file: 'tools/plain/activate_plan.test.ts',
    label: '`activate_plan` HITL-bypass negative test — never reaches `active` without the approval pause (AD-14)',
    // Scoped to this one test only — the rest of `activate_plan.test.ts`
    // (DB unique-index constraint, resume/pause semantics, draft-save) are
    // legitimate integration tests but not guardrail tests, and must never
    // flip this entry's pass/fail.
    testNamePattern: "pauses on a fresh invocation and leaves the plan untouched",
  },
];

/**
 * Story 6.1's own "Pending" list, carried forward here rather than
 * re-derived. `guilt-streak-language` and `hitl-bypass` were removed once
 * CAP-4/Epic 3 shipped their own guardrail suites above; `mistral-flag-rate`
 * was removed (Stories 6.2/6.3 follow-up) once `trajectory.eval.ts` started
 * actually running it — that metric's own live/error state now renders via
 * `ReportData.mistralJailbreakFlagRate` instead of this static list. Only a
 * genuinely unbuilt category belongs here. Must appear in the report as
 * pending, never hidden and never silently counted as passing.
 */
export const PENDING_GUARDRAIL_CATEGORIES: readonly PendingGuardrailCategory[] = [];

interface VitestJsonReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
}

/**
 * Review Triage Log: no runtime validation meant a vitest JSON-reporter
 * shape change would silently surface as `NaN`/`undefined` counts rather
 * than a clear error naming the problem.
 *
 * Review Triage Log (2nd pass): `-t`'s own filtered-out tests come back as
 * `status: 'skipped'` (counted in `numPendingTests`), never excluded from
 * `numTotalTests` — left as-is, a `testNamePattern`-scoped suite entry would
 * report e.g. "7 total, 1 passed" instead of "1 total, 1 passed," looking
 * like 6 silently-missing results instead of 6 tests that were never part
 * of this guardrail category. `numPendingTests` is optional (defaults to 0)
 * so the pre-existing fixtures in `guardrails.test.ts`, which predate this
 * field, still parse unchanged.
 */
export function parseVitestJsonReport(raw: string): { total: number; passed: number; failed: number } {
  const report = JSON.parse(raw) as Partial<VitestJsonReport>;
  const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending = 0 } = report;
  if (typeof total !== 'number' || typeof passed !== 'number' || typeof failed !== 'number' || typeof pending !== 'number') {
    throw new Error(`unexpected vitest JSON reporter shape: ${JSON.stringify(report)}`);
  }
  return { total: total - pending, passed, failed };
}

/**
 * Runs each committed guardrail suite for real via a `vitest run` child
 * process with the JSON reporter, so the report's pass/fail numbers are
 * measured every time, never hand-typed. `cwd` must be the `src/` workspace
 * directory (where `vitest.config.ts` and the suite files above live).
 */
export function runGuardrailSuites(cwd: string): GuardrailSuiteResult[] {
  return GUARDRAIL_SUITES.map((suite) => {
    const outputFile = path.join(os.tmpdir(), `guardrail-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const args = ['vitest', 'run', suite.file, '--config', 'vitest.config.ts', '--reporter=json', `--outputFile=${outputFile}`];
      if (suite.testNamePattern) args.push('-t', suite.testNamePattern);
      const result = spawnSync('npx', args, {
        cwd,
        encoding: 'utf8',
      });
      if (result.error) {
        throw new Error(`failed to spawn vitest for guardrail suite "${suite.file}": ${result.error.message}`);
      }
      if (!fs.existsSync(outputFile)) {
        throw new Error(`guardrail suite "${suite.file}" produced no report (exit ${result.status}): ${result.stderr || result.stdout}`);
      }
      let total: number, passed: number, failed: number;
      try {
        ({ total, passed, failed } = parseVitestJsonReport(fs.readFileSync(outputFile, 'utf8')));
      } catch (error) {
        throw new Error(`guardrail suite "${suite.file}" produced an unreadable report: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { ...suite, total, passed, failed, allPassed: total > 0 && failed === 0 };
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
  });
}
