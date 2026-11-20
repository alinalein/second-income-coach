import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { publishedEvalResultsSchema } from '@app/shared';
import { runGenerateReport } from './generate-report.js';
import type { GuardrailSuiteResult } from './guardrails.js';

const fixturePath = fileURLToPath(new URL('./report-fixtures/sample-trajectory-results.json', import.meta.url));
const sampleTrajectoryResultsRaw = fs.readFileSync(fixturePath, 'utf8');

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

    const result = runGenerateReport({
      trajectoryResultsPath: fixturePath,
      outDir: tmpDir,
      publishedResultsPath: path.join(tmpDir, 'published', 'eval-results.json'),
      runGuardrailSuites: () => fakeGuardrailResults,
    });

    expect(result.allBuiltSuitesPassed).toBe(true);
    expect(fs.readFileSync(result.reportMdPath, 'utf8')).toContain('53.8%');
    expect(fs.readFileSync(result.reportHtmlPath, 'utf8')).toContain('53.8%');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    expect(json.perModelAccuracy).toHaveLength(4);
  });

  it('a failing guardrail suite is reflected in the result, never silently swallowed', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const failing: GuardrailSuiteResult[] = [...fakeGuardrailResults.slice(0, 1), { ...fakeGuardrailResults[1]!, passed: 4, failed: 1, allPassed: false }];

    const result = runGenerateReport({
      trajectoryResultsPath: fixturePath,
      outDir: tmpDir,
      publishedResultsPath: path.join(tmpDir, 'published', 'eval-results.json'),
      runGuardrailSuites: () => failing,
    });

    expect(result.allBuiltSuitesPassed).toBe(false);
  });

  it('throws a clear, specific error when the trajectory results file is missing, instead of a raw ENOENT', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const missingPath = path.join(tmpDir, 'does-not-exist.json');

    expect(() =>
      runGenerateReport({
        trajectoryResultsPath: missingPath,
        outDir: tmpDir!,
        publishedResultsPath: path.join(tmpDir!, 'published', 'eval-results.json'),
        runGuardrailSuites: () => fakeGuardrailResults,
      }),
    ).toThrow(/No trajectory results found.*npm run eval/s);
  });

  // "Never from a partial run" rule (Stories 6.2/6.3 follow-up): the
  // committed sample fixture predates `mistralJailbreakFlagRate` (AD-23) —
  // exactly the shape a partial run also produces — so publishing must be
  // skipped and the reason surfaced, never a silent write of incomplete data.
  it('skips writing the published file for an incomplete (partial-run-shaped) trajectory-results.json, and says why', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const publishedResultsPath = path.join(tmpDir, 'published', 'eval-results.json');

    const result = runGenerateReport({ trajectoryResultsPath: fixturePath, outDir: tmpDir, publishedResultsPath, runGuardrailSuites: () => fakeGuardrailResults });

    expect(result.published).toEqual({ written: false, reason: expect.stringContaining('mistralJailbreakFlagRate') });
    expect(fs.existsSync(publishedResultsPath)).toBe(false);
  });

  // User-requested (2026-11-20, amended, epics.md Story 7.5): latency is
  // part of the one `trajectoryResultsPath` file, never a separate one —
  // `ackLatencyRows` present on it reaches the report JSON; the committed
  // sample fixture (predating that field) renders "not measured" instead
  // of crashing.
  it('carries ackLatencyRows from trajectoryResultsPath into the report JSON; its absence renders "not measured"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));

    const withAckLatencyPath = path.join(tmpDir, 'trajectory-results-with-ack-latency.json');
    fs.writeFileSync(
      withAckLatencyPath,
      JSON.stringify({
        ...JSON.parse(sampleTrajectoryResultsRaw),
        ackLatencyRows: [{ modelId: 'openai/gpt-6-luna', callDurationsMs: [500, 600], medianMs: 550, maxMs: 600, missingMessageCount: 0 }],
      }),
    );
    const withAckLatency = runGenerateReport({
      trajectoryResultsPath: withAckLatencyPath,
      outDir: tmpDir,
      publishedResultsPath: path.join(tmpDir, 'published', 'eval-results.json'),
      runGuardrailSuites: () => fakeGuardrailResults,
    });
    const jsonWithAckLatency = JSON.parse(fs.readFileSync(withAckLatency.reportJsonPath, 'utf8'));
    expect(jsonWithAckLatency.latency.ackByModel.find((entry: { modelId: string }) => entry.modelId === 'openai/gpt-6-luna')).toEqual({
      modelId: 'openai/gpt-6-luna',
      medianMs: 550,
      maxMs: 600,
      calls: 2,
    });

    const withoutAckLatency = runGenerateReport({
      trajectoryResultsPath: fixturePath,
      outDir: tmpDir,
      publishedResultsPath: path.join(tmpDir, 'published', 'eval-results.json'),
      runGuardrailSuites: () => fakeGuardrailResults,
    });
    const jsonWithoutAckLatency = JSON.parse(fs.readFileSync(withoutAckLatency.reportJsonPath, 'utf8'));
    expect(jsonWithoutAckLatency.latency.ackByModel.every((entry: { medianMs: unknown }) => entry.medianMs === null)).toBe(true);
  });

  it('writes the published file, schema-valid, only once the run is complete (all models, consistent case counts, AD-23 recorded)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
    const completeResultsPath = path.join(tmpDir, 'trajectory-results.json');
    const completeResults = {
      ...JSON.parse(sampleTrajectoryResultsRaw),
      mistralJailbreakFlagRate: {
        status: 'ok',
        total: 4,
        flaggedCount: 3,
        rows: [{ label: 'ignore/disregard instructions', flagged: true, jailbreakingScore: 0.92 }],
      },
    };
    fs.writeFileSync(completeResultsPath, JSON.stringify(completeResults));
    const publishedResultsPath = path.join(tmpDir, 'published', 'eval-results.json');

    const result = runGenerateReport({ trajectoryResultsPath: completeResultsPath, outDir: tmpDir, publishedResultsPath, runGuardrailSuites: () => fakeGuardrailResults });

    expect(result.published).toEqual({ written: true });
    const published = JSON.parse(fs.readFileSync(publishedResultsPath, 'utf8'));
    expect(() => publishedEvalResultsSchema.parse(published)).not.toThrow();
    expect(published.mistralJailbreakFlagRate).toEqual(completeResults.mistralJailbreakFlagRate);
  });
});
