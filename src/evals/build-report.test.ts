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

  it('AC 6.3-3: pending guardrail categories, never silently dropped when present', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    // Story 6.1: `hitl-bypass`/`guilt-streak-language` were removed from
    // `PENDING_GUARDRAIL_CATEGORIES` once CAP-4/Epic 3 shipped their own
    // guardrail suites (`guardrails.ts`); `mistral-flag-rate` was removed
    // (Stories 6.2/6.3 follow-up) once `trajectory.eval.ts` started actually
    // running it — nothing is left in this static list any more.
    expect(report.guardrails.pending).toEqual([]);
    expect(report.guardrails.pending.map((category) => category.id)).not.toContain('hitl-bypass');
  });

  // AD-23: the fixture predates this metric (no `mistralJailbreakFlagRate`
  // key) — must render as "pending", never a faked 0/4.
  it('AD-23: a trajectory-results.json without mistralJailbreakFlagRate renders as pending, never a faked count', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.mistralJailbreakFlagRate.status).toBe('pending');
  });

  it('AD-23: a recorded live run carries the real flagged count and rows through unchanged', () => {
    const report = buildReport(
      { ...sampleTrajectoryResults, mistralJailbreakFlagRate: { status: 'ok', total: 4, flaggedCount: 3, rows: [{ label: 'ignore/disregard instructions', flagged: true, jailbreakingScore: 0.92 }] } },
      passingGuardrails,
    );
    expect(report.mistralJailbreakFlagRate).toEqual({ status: 'ok', total: 4, flaggedCount: 3, rows: [{ label: 'ignore/disregard instructions', flagged: true, jailbreakingScore: 0.92 }] });
  });

  // "never from a partial run" rule's sibling case for this report: a failed
  // live call must render as pending/error, never as a silent 0 flagged.
  it('AD-23: a recorded classifier failure renders as pending with the real reason, never a faked count', () => {
    const report = buildReport(
      { ...sampleTrajectoryResults, mistralJailbreakFlagRate: { status: 'error', reason: 'MISTRAL_API_KEY is not set', rows: [] } },
      passingGuardrails,
    );
    expect(report.mistralJailbreakFlagRate).toEqual({ status: 'pending', reason: 'MISTRAL_API_KEY is not set' });
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

  // User-requested (2026-11-20, Job B): Sonnet is now priced from the
  // eval-only price table (never `MODEL_REGISTRY`, AD-20 still holds) — a
  // deliberate change from the old registry-based mechanism, where it was
  // always `null`. The headline total still excludes it by scope, not by
  // being unpriced (see the next test).
  it('AC 6.3-3: estimates run cost from the eval-only price table, pricing the eval-only Sonnet model too', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    const sonnet = report.cost.perModel.find((entry) => entry.modelId === 'anthropic/claude-sonnet-5.5' && entry.role === 'target');
    expect(sonnet?.estimatedCostUsd).toBeGreaterThan(0);
    expect(sonnet?.inputTokens).toBe(900);
    expect(report.cost.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.limitations.map((limitation) => limitation.id)).toEqual(
      expect.arrayContaining(['cost-mechanism-not-built', 'story-7-4-pending', 'judge-call-cost-excluded']),
    );
    expect(report.limitations.map((limitation) => limitation.id)).not.toContain('unpriced-eval-only-model');
  });

  // User-requested (2026-11-20, amended): "never present a partial sum as
  // the full cost" — the sample fixture predates judge-call usage capture
  // (no judge-role rows at all, so the judges group has 0 calls), so the
  // headline sums only the groups that were actually recorded and priced
  // (target models + Sonnet), and its label names the excluded group by
  // reason rather than silently widening or silently narrowing.
  it('the headline total sums every measured group and labels the excluded one by reason', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.cost.groups.judges.status).toBe('not-recorded');
    expect(report.cost.groups.judges.estimatedCostUsd).toBeNull();
    const sonnet = report.cost.perModel.find((entry) => entry.modelId === 'anthropic/claude-sonnet-5.5' && entry.role === 'target');
    expect(sonnet?.estimatedCostUsd).toBeGreaterThan(0);
    // The headline equals target models + Sonnet exactly — Sonnet's real,
    // nonzero cost is folded in; the judges group (not recorded) is not.
    expect(report.cost.totalEstimatedCostUsd).toBe((report.cost.groups.targetModels.estimatedCostUsd ?? 0) + (report.cost.groups.sonnet.estimatedCostUsd ?? 0));
    expect(report.cost.totalLabel).toBe('target models + Sonnet; judges not recorded');
  });

  // User-requested (2026-11-20, amended): the committed sample fixture
  // predates both latency sources (no `durationMs` on any row, no
  // `ackLatencyRows` field at all) — every model must render as "not
  // measured" (`null`), never a fabricated number, and every
  // `EVAL_MODEL_IDS` entry from the fixture's own `perModelAccuracy` must
  // be covered.
  it('no ackLatencyRows and no durationMs anywhere -> every model is "not measured"', () => {
    const report = buildReport(sampleTrajectoryResults, passingGuardrails);
    expect(report.latency.ackByModel).toEqual(
      sampleTrajectoryResults.perModelAccuracy.map((entry) => ({ modelId: entry.modelId, medianMs: null, maxMs: null, calls: 0 })),
    );
    expect(report.latency.deterministicByModel).toEqual(
      sampleTrajectoryResults.perModelAccuracy.map((entry) => ({ modelId: entry.modelId, medianMs: null })),
    );
  });

  // User-requested (2026-11-20, amended): once both sources carry real
  // data — both now written to the same `trajectory-results.json` by
  // `trajectory.eval.ts` itself, never a separate file — each reaches the
  // report under its own distinct field; the ack-call median and a full
  // trajectory-case's own agent-turn median must never be conflated into
  // one number.
  it('real ackLatencyRows and durationMs rows reach the report under their own distinct fields', () => {
    const withLatencyData = {
      ...sampleTrajectoryResults,
      rows: sampleTrajectoryResults.rows.map((row) =>
        row.modelId === 'openai/gpt-6-luna' && row.caseType === 'deterministic' ? { ...row, durationMs: 1200 } : row,
      ),
      ackLatencyRows: [{ modelId: 'openai/gpt-6-luna', callDurationsMs: [500, 600, 700, 800, 900], medianMs: 700, maxMs: 900, missingMessageCount: 1 }],
    };
    const report = buildReport(withLatencyData, passingGuardrails);

    expect(report.latency.ackByModel.find((entry) => entry.modelId === 'openai/gpt-6-luna')).toEqual({
      modelId: 'openai/gpt-6-luna',
      medianMs: 700,
      maxMs: 900,
      calls: 5,
    });
    expect(report.latency.deterministicByModel.find((entry) => entry.modelId === 'openai/gpt-6-luna')).toEqual({
      modelId: 'openai/gpt-6-luna',
      medianMs: 1200,
    });
  });
});
