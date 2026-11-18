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

  it('shows pending guardrail categories, never hidden', () => {
    // Story 6.1: `activate_plan` (HITL-bypass) shipped its own guardrail
    // suite and left `PENDING_GUARDRAIL_CATEGORIES` — only `mistral-flag-rate`
    // (still blocked on a live Mistral run) remains pending there.
    expect(output).toContain("Mistral Moderation's own jailbreak-flag rate");
  });

  it('shows the estimated run cost total', () => {
    expect(output).toContain(report.cost.totalEstimatedCostUsd.toFixed(4));
  });

  it('AD-21: discloses the unpriced eval-only model as having no registered price, never a guessed number', () => {
    // Verification-gap: the data layer (`ReportData.cost.perModel[...].estimatedCostUsd === null`)
    // was already checked elsewhere, but nothing asserted the *rendered*
    // text actually carries the disclosure through — a regression in
    // `usd()`'s null branch (e.g. returning a guessed "$0.0000") would
    // have passed every other assertion here.
    expect(output).toContain('no registered price');
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
    expect(summary.safety).toBeDefined();
    expect(summary.cost).toBeDefined();
    expect(summary.limitations).toBeDefined();
    expect(() => JSON.stringify(summary)).not.toThrow();
  });
});
