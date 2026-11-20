import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport, type TrajectoryResults } from './build-report.js';
import { renderHtml, renderJsonSummary, renderMarkdown } from './render.js';
import type { GuardrailSuiteResult } from './guardrails.js';

const fixturePath = fileURLToPath(new URL('./report-fixtures/sample-trajectory-results.json', import.meta.url));
const sampleTrajectoryResults: TrajectoryResults = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const guardrailResults: GuardrailSuiteResult[] = [
  { file: 'agent/direct-prompt-injection.test.ts', label: 'Direct prompt-injection', total: 6, passed: 6, failed: 0, allPassed: true },
  { file: 'agent/moderation-web-search.test.ts', label: 'web_search moderation', total: 5, passed: 5, failed: 0, allPassed: true },
];

const report = buildReport(sampleTrajectoryResults, guardrailResults);

/** AC 6.3-1: "produces a markdown/HTML report" — both renderers are pure
 * functions of the same `ReportData`, checked here against the same
 * fixture for the facts the AC names: the real below-target accuracy
 * number (never hidden), guardrail pass/fail, and the run date. */
describe.each([
  ['markdown', renderMarkdown],
  ['html', renderHtml],
] as const)('%s report', (_label, render) => {
  const output = render(report);

  it('shows the real per-model accuracy even below the 80% target', () => {
    expect(output).toContain('53.8%');
  });

  it('shows the run date', () => {
    expect(output).toContain('2026-11-15T09:30:00.000Z');
  });

  it('shows guardrail suite pass counts', () => {
    expect(output).toContain('agent/direct-prompt-injection.test.ts');
    expect(output).toContain('agent/moderation-web-search.test.ts');
  });

  it('AD-23: shows the Mistral jailbreak-flag-rate section, pending when the results file has none recorded', () => {
    expect(output).toContain("Mistral Moderation's own jailbreak-flag rate");
    expect(output).toContain('Pending/error');
  });

  it('shows the estimated run cost total', () => {
    expect(output).toContain(report.cost.totalEstimatedCostUsd.toFixed(4));
  });

  it('Fix (2026-11-19): shows each quality case\'s per-judge score, including a judge-call error row', () => {
    expect(output).toContain('quality-ambiguous-intake-en');
    expect(output).toContain('0.9');
    expect(output).toContain('judge call failed: 429 rate limited');
  });

  // User-requested (2026-11-20, Job B): the eval-only price table now
  // actually prices every model this fixture names (including the
  // Sonnet/eval-only model and both judges) — the null-price branch is
  // only reachable for a model truly absent from that table, so this test
  // adds one rather than relying on the fixture's own (now-priced) models.
  it('AD-21: discloses a model absent from the eval-only price table as having no registered price, never a guessed number', () => {
    const unpricedModelId = 'unknown-provider/not-in-the-eval-price-table';
    const reportWithUnpricedModel = buildReport(
      { ...sampleTrajectoryResults, perModelAccuracy: [...sampleTrajectoryResults.perModelAccuracy, { modelId: unpricedModelId, deterministicCaseCount: 0, passedCaseCount: 0, accuracy: 0, meetsTarget: false }] },
      guardrailResults,
    );
    // Verification-gap: the data layer (`ReportData.cost.perModel[...].estimatedCostUsd === null`)
    // was already checked elsewhere, but nothing asserted the *rendered*
    // text actually carries the disclosure through — a regression in
    // `usd()`'s null branch (e.g. returning a guessed "$0.0000") would
    // have passed every other assertion here.
    expect(render(reportWithUnpricedModel)).toContain('no registered price');
  });
});

describe.each([
  ['markdown', renderMarkdown],
  ['html', renderHtml],
] as const)('%s report — AD-23 recorded flag-rate run', (_label, render) => {
  it('shows "flagged X of 4" and the per-input table, never a Pending line, once a live run is recorded', () => {
    const recordedReport = buildReport(
      {
        ...sampleTrajectoryResults,
        mistralJailbreakFlagRate: {
          status: 'ok',
          total: 4,
          flaggedCount: 3,
          rows: [
            { label: 'ignore/disregard instructions', flagged: true, jailbreakingScore: 0.92 },
            { label: 'output system prompt', flagged: true, jailbreakingScore: 0.95 },
            { label: 'list your tools', flagged: false, jailbreakingScore: 0.1 },
            { label: 'injected instruction inside a normal check-in message', flagged: true, jailbreakingScore: 0.88 },
          ],
        },
      },
      guardrailResults,
    );
    const output = render(recordedReport);
    expect(output).toContain('flagged 3 of 4');
    expect(output).not.toContain('Pending/error');
    expect(output).toContain('list your tools');
  });
});

describe('renderJsonSummary', () => {
  it('AC 6.3-5: includes per-model accuracy, safety pass/fail, run date, judge models, run cost, and limitations', () => {
    const summary = renderJsonSummary(report) as Record<string, unknown>;
    expect(summary).toMatchObject({
      runDate: sampleTrajectoryResults.generatedAt,
      perModelAccuracy: sampleTrajectoryResults.perModelAccuracy,
    });
    expect(summary.judges).toBeDefined();
    expect((summary.judges as Record<string, unknown>).qualityResults).toEqual(report.qualityResults);
    expect(summary.safety).toBeDefined();
    expect(summary.mistralJailbreakFlagRate).toEqual(report.mistralJailbreakFlagRate);
    expect(summary.cost).toBeDefined();
    expect(summary.limitations).toBeDefined();
    expect(() => JSON.stringify(summary)).not.toThrow();
  });
});
