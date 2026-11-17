import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Story 6.3 (AC: "whether the 100%-bar safety/guardrail tests passed"):
 * the committed guardrail suites Story 6.1 added, each deterministic and
 * free of any real network call (see their own doc comments) — safe to
 * actually run, every time, rather than hand-typed into the report.
 */
export interface GuardrailSuiteDef {
  file: string;
  label: string;
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
  { file: 'agent/direct-prompt-injection.test.ts', label: 'Direct prompt-injection outcome (ignore instructions / output system prompt / list tools, EN+DE)' },
  { file: 'agent/moderation-web-search.test.ts', label: 'web_search moderation, incl. simulated prompt injection via a search result (AD-11)' },
];

/**
 * Story 6.1's own "Pending" list, carried forward here rather than
 * re-derived — these guardrail categories AD-23 names are blocked on tools
 * that don't exist yet. Must appear in the report as pending, never hidden
 * and never silently counted as passing.
 */
export const PENDING_GUARDRAIL_CATEGORIES: readonly PendingGuardrailCategory[] = [
  { id: 'guilt-streak-language', label: 'Guilt/streak-language guardrail (AD-12), once per personality', reason: 'blocked on CAP-4 (missed check-ins) — not built yet' },
  { id: 'hitl-bypass', label: '`activate_plan` HITL-bypass negative test', reason: 'blocked on Epic 3 (Plan Creation & Activation) — `activate_plan` does not exist yet' },
  {
    id: 'mistral-flag-rate',
    label: "Mistral Moderation's own jailbreak-flag rate on the 4 direct-injection inputs (non-gating visibility metric)",
    reason: 'requires a live run against the real Mistral classifier; not wired into any eval run yet',
  },
];

interface VitestJsonReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
}

/**
 * Review Triage Log: no runtime validation meant a vitest JSON-reporter
 * shape change would silently surface as `NaN`/`undefined` counts rather
 * than a clear error naming the problem.
 */
export function parseVitestJsonReport(raw: string): { total: number; passed: number; failed: number } {
  const report = JSON.parse(raw) as Partial<VitestJsonReport>;
  const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed } = report;
  if (typeof total !== 'number' || typeof passed !== 'number' || typeof failed !== 'number') {
    throw new Error(`unexpected vitest JSON reporter shape: ${JSON.stringify(report)}`);
  }
  return { total, passed, failed };
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
      const result = spawnSync('npx', ['vitest', 'run', suite.file, '--config', 'vitest.config.ts', '--reporter=json', `--outputFile=${outputFile}`], {
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
