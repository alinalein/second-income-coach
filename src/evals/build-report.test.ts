import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport, type TrajectoryResults } from './build-report.js';
import type { GuardrailSuiteResult } from './guardrails.js';

const fixturePath = fileURLToPath(new URL('./report-fixtures/sample-trajectory-results.json', import.meta.url));
const sampleTrajectoryResults: TrajectoryResults = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const passingGuardrails: GuardrailSuiteResult[] = [
  { file: 'agent/direct-prompt-injection.test.ts', label: 'Direct prompt-injection', total: 6, passed: 6, failed: 0, allPassed: true },
  { file: 'agent/moderation-web-search.test.ts', label: 'web_search moderation', total: 5, passed: 5, failed: 0, allPassed: true },
];

describe('buildReport', () => {
  it('AC 6.3-1: carries the real per-model accuracy through unchanged, even below the 80% target', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    const gemini = report.perModelAccuracy.find((entry) => entry.modelId === 'google/gemini-3.8-flash');
    expect(gemini).toMatchObject({ accuracy: 0.538, meetsTarget: false });
    expect(report.perModelAccuracy).toHaveLength(4);
  });

  it('AC 6.3-1: reports guardrail suites as-run and an overall pass flag derived from them', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.guardrails.suites).toEqual(passingGuardrails);
    expect(report.guardrails.allBuiltSuitesPassed).toBe(true);
  });

  it('AC 6.3-1: a failing guardrail suite flips the overall pass flag, never hidden', () => {
    const failing: GuardrailSuiteResult[] = [...passingGuardrails.slice(0, 1), { ...passingGuardrails[1]!, failed: 1, passed: 4, allPassed: false }];
    const report = buildReport(sampleTrajectoryResults, failing);
    expect(report.guardrails.allBuiltSuitesPassed).toBe(false);
  });

  it('AC 6.3-3: pending guardrail categories always appear, never silently dropped', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.guardrails.pending.length).toBeGreaterThan(0);
    // Story 6.1: `hitl-bypass`/`guilt-streak-language` were removed from
    // `PENDING_GUARDRAIL_CATEGORIES` once CAP-4/Epic 3 shipped their own
    // guardrail suites (`guardrails.ts`) — only `mistral-flag-rate` (still
    // blocked on a live Mistral run) remains.
    expect(report.guardrails.pending.map((category) => category.id)).toContain('mistral-flag-rate');
    expect(report.guardrails.pending.map((category) => category.id)).not.toContain('hitl-bypass');
  });

  it('AC 6.3-3: judge/registry overlap is disclosed for google/gemini-3.8-flash, not for the judge-only deepseek model', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.judgeRegistryOverlap).toEqual([
      { judgeId: 'google/gemini-3.8-flash', alsoRegistryEntry: true },
      { judgeId: 'deepseek/deepseek-v4.1-flash', alsoRegistryEntry: false },
    ]);
    expect(report.limitations.map((limitation) => limitation.id)).toContain('judge-registry-overlap');
  });

  it('AC 6.3-3: records which judge scored which model, excluding a row whose judge call itself failed', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    // The fixture's quality-generate-ideas-phrasing-en/gemini row has
    // `error` set (judge call failed) — gemini never actually scored
    // itself on that row, so it must not appear as "scored."
    expect(report.judgeScoredModels['google/gemini-3.8-flash']).toEqual(['openai/gpt-6-luna']);
    expect(report.judgeScoredModels['deepseek/deepseek-v4.1-flash']).toEqual(['google/gemini-3.8-flash', 'openai/gpt-6-luna']);
  });

  it('AC 6.3-1: an empty guardrailResults never reads as "all passed" (no vacuous truth)', () => {
    const report = buildReport(sampleTrajectoryResults, []);
    expect(report.guardrails.allBuiltSuitesPassed).toBe(false);
  });

  it('Fix (2026-11-19): surfaces each quality row\'s actual judge score, including an errored judge call as a visible row', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.qualityResults).toContainEqual(
      expect.objectContaining({ modelId: 'openai/gpt-6-luna', caseId: 'quality-ambiguous-intake-en', judgeId: 'google/gemini-3.8-flash', score: 0.9 }),
    );
    expect(report.qualityResults).toContainEqual(
      expect.objectContaining({
        modelId: 'google/gemini-3.8-flash',
        caseId: 'quality-generate-ideas-phrasing-en',
        judgeId: 'google/gemini-3.8-flash',
        score: null,
        error: 'judge call failed: 429 rate limited',
      }),
    );
  });

  it('AC 6.3-3: estimates run cost from the registry price list and flags the unpriced eval-only model as a limitation', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    const sonnet = report.cost.perModel.find((entry) => entry.modelId === 'anthropic/claude-sonnet-5.5');
    expect(sonnet?.estimatedCostUsd).toBeNull();
    expect(sonnet?.inputTokens).toBe(900);
    expect(report.cost.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.limitations.map((limitation) => limitation.id)).toEqual(
      expect.arrayContaining(['unpriced-eval-only-model', 'cost-mechanism-not-built', 'story-7-4-pending', 'judge-call-cost-excluded']),
    );
  });
});
