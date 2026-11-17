import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGenerateReport } from './generate-report.js';
import type { GuardrailSuiteResult } from './guardrails.js';

const fixturePath = fileURLToPath(new URL('./report-fixtures/sample-trajectory-results.json', import.meta.url));

const fakeGuardrailResults: GuardrailSuiteResult[] = [
  { file: 'agent/direct-prompt-injection.test.ts', label: 'Direct prompt-injection', total: 6, passed: 6, failed: 0, allPassed: true },
  { file: 'agent/moderation-web-search.test.ts', label: 'web_search moderation', total: 5, passed: 5, failed: 0, allPassed: true },
];

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

/** AC 6.3-2 ("a single command produces it end to end"): exercises the
 * actual pipeline `main()` wires up — real file reads/writes against a
 * temp dir and the committed sample fixture, with a fake guardrail runner
 * so no subprocess is spawned. */
describe('runGenerateReport', () => {
  it('writes markdown, HTML, and JSON reports end to end from the committed sample fixture', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));

    const result = runGenerateReport({ trajectoryResultsPath: fixturePath, outDir: tmpDir, runGuardrailSuites: () => fakeGuardrailResults });

    expect(result.allBuiltSuitesPassed).toBe(true);
    expect(fs.readFileSync(result.reportMdPath, 'utf8')).toContain('53.8%');
    expect(fs.readFileSync(result.reportHtmlPath, 'utf8')).toContain('53.8%');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    expect(json.perModelAccuracy).toHaveLength(4);
  });

  it('a failing guardrail suite is reflected in the result, never silently swallowed', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const failing: GuardrailSuiteResult[] = [...fakeGuardrailResults.slice(0, 1), { ...fakeGuardrailResults[1]!, passed: 4, failed: 1, allPassed: false }];

    const result = runGenerateReport({ trajectoryResultsPath: fixturePath, outDir: tmpDir, runGuardrailSuites: () => failing });

    expect(result.allBuiltSuitesPassed).toBe(false);
  });

  it('throws a clear, specific error when the trajectory results file is missing, instead of a raw ENOENT', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const missingPath = path.join(tmpDir, 'does-not-exist.json');

    expect(() => runGenerateReport({ trajectoryResultsPath: missingPath, outDir: tmpDir!, runGuardrailSuites: () => fakeGuardrailResults })).toThrow(
      /No trajectory results found.*npm run eval/s,
    );
  });
});
