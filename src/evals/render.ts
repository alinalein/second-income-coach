import type { ReportData } from './build-report.js';
import type { ModelCostSummary } from './cost.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? 'n/a (no registered price)' : `$${value.toFixed(4)}`;
}

/**
 * Review Triage Log: `usageComplete`/`callCount` were computed in
 * `cost.ts` but never surfaced in the rendered report — a `$0.0000` row
 * read as a confirmed zero cost with no way to tell it apart from "never
 * ran" or "usage wasn't captured."
 */
function dataStatus(entry: ModelCostSummary): 'complete' | 'partial' | 'none' {
  if (entry.callCount === 0) return 'none';
  return entry.usageComplete ? 'complete' : 'partial';
}

function hasIncompleteCostData(perModel: readonly ModelCostSummary[]): boolean {
  return perModel.some((entry) => dataStatus(entry) !== 'complete');
}

/**
 * Story 6.3 AC: "a single command produces [the report] end to end ... no
 * manual assembly step." Both renderers below are pure functions of the
 * same `ReportData` `buildReport` already assembled — neither one
 * re-derives or re-fetches anything.
 */
export function renderMarkdown(report: ReportData): string {
  const lines: string[] = [];
  lines.push('# Second Income Coach — Evaluation Report');
  lines.push('');
  lines.push(`Run date: ${report.runDate}`);
  lines.push(`Report generated: ${report.reportGeneratedAt}`);
  lines.push(`Trajectory accuracy target: ${pct(report.trajectoryAccuracyTarget)} per model`);
  lines.push('');

  lines.push('## Tool-call accuracy per model');
  lines.push('');
  lines.push('| Model | Deterministic cases | Passed | Accuracy | Meets target? |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.perModelAccuracy) {
    lines.push(`| ${entry.modelId} | ${entry.deterministicCaseCount} | ${entry.passedCaseCount} | ${pct(entry.accuracy)} | ${entry.meetsTarget ? '✅' : '❌'} |`);
  }
  lines.push('');

  lines.push('## Safety / guardrail tests (100% bar, zero tolerance)');
  lines.push('');
  lines.push('| Suite | Total | Passed | Failed | 100%? |');
  lines.push('|---|---|---|---|---|');
  for (const suite of report.guardrails.suites) {
    lines.push(`| ${suite.label} (\`${suite.file}\`) | ${suite.total} | ${suite.passed} | ${suite.failed} | ${suite.allPassed ? '✅' : '❌'} |`);
  }
  lines.push('');
  lines.push(`Overall (built suites only): ${report.guardrails.allBuiltSuitesPassed ? '✅ all passed' : '❌ at least one failed'}`);
  lines.push('');
  lines.push('**Pending** (named by AD-23, not yet built — shown explicitly, never hidden):');
  lines.push('');
  for (const category of report.guardrails.pending) {
    lines.push(`- ${category.label} — ${category.reason}`);
  }
  lines.push('');

  lines.push('## Judges');
  lines.push('');
  lines.push(`Pinned judge models: ${report.judgeModelIds.join(', ')}`);
  lines.push('');
  lines.push('| Judge | Scored models |');
  lines.push('|---|---|');
  for (const judgeId of report.judgeModelIds) {
    lines.push(`| ${judgeId} | ${(report.judgeScoredModels[judgeId] ?? []).join(', ') || '(none this run)'} |`);
  }
  lines.push('');
  for (const entry of report.judgeRegistryOverlap.filter((o) => o.alsoRegistryEntry)) {
    lines.push(`Known limitation: \`${entry.judgeId}\` is both a pinned judge and a user-selectable registry entry — it can judge its own model's trajectories.`);
  }
  lines.push('');

  lines.push('## Quality (LLM-as-judge) scores');
  lines.push('');
  lines.push('| Model | Case | Judge | Score | Comment / error |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.qualityResults) {
    const scoreCell = entry.error !== undefined ? '⚠️ error' : String(entry.score);
    lines.push(`| ${entry.modelId} | ${entry.caseId} | ${entry.judgeId} | ${scoreCell} | ${entry.error ?? entry.comment ?? ''} |`);
  }
  lines.push('');

  lines.push('## Estimated run cost');
  lines.push('');
  lines.push(`Mechanism: ${report.cost.mechanism} (see Known limitations).`);
  lines.push('');
  lines.push('| Model | Input tokens | Output tokens | $/1M in | $/1M out | Estimated cost | Data |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const entry of report.cost.perModel) {
    lines.push(
      `| ${entry.modelId} | ${entry.inputTokens} | ${entry.outputTokens} | ${entry.pricePerMillionInputTokens ?? 'n/a'} | ${entry.pricePerMillionOutputTokens ?? 'n/a'} | ${usd(entry.estimatedCostUsd)} | ${dataStatus(entry)} |`,
    );
  }
  lines.push('');
  lines.push(`**Total estimated cost (priced models only): $${report.cost.totalEstimatedCostUsd.toFixed(4)}**`);
  if (hasIncompleteCostData(report.cost.perModel)) {
    lines.push('');
    lines.push('⚠️ At least one model above has `partial` or `none` usage data (see its "Data" column) — its token/cost figures are a floor, not a precise total.');
  }
  lines.push('');

  lines.push('## Known limitations');
  lines.push('');
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation.summary}`);
  }
  lines.push('');

  lines.push('## Known weaknesses & traceability');
  lines.push('');
  lines.push('See Epic 7, Story 7.4 (known-weaknesses/traceability documentation) — not yet written.');
  lines.push('');

  return lines.join('\n');
}

export function renderHtml(report: ReportData): string {
  const escape = (value: string | number): string => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const accuracyRows = report.perModelAccuracy
    .map(
      (entry) =>
        `<tr><td>${escape(entry.modelId)}</td><td>${entry.deterministicCaseCount}</td><td>${entry.passedCaseCount}</td><td>${pct(entry.accuracy)}</td><td>${entry.meetsTarget ? '✅' : '❌'}</td></tr>`,
    )
    .join('\n');

  const guardrailRows = report.guardrails.suites
    .map(
      (suite) =>
        `<tr><td>${escape(suite.label)} (<code>${escape(suite.file)}</code>)</td><td>${suite.total}</td><td>${suite.passed}</td><td>${suite.failed}</td><td>${suite.allPassed ? '✅' : '❌'}</td></tr>`,
    )
    .join('\n');

  const pendingItems = report.guardrails.pending.map((category) => `<li>${escape(category.label)} — ${escape(category.reason)}</li>`).join('\n');

  const judgeRows = report.judgeModelIds
    .map((judgeId) => `<tr><td>${escape(judgeId)}</td><td>${escape((report.judgeScoredModels[judgeId] ?? []).join(', ') || '(none this run)')}</td></tr>`)
    .join('\n');

  const qualityRows = report.qualityResults
    .map((entry) => {
      const scoreCell = entry.error !== undefined ? '⚠️ error' : escape(String(entry.score));
      return `<tr><td>${escape(entry.modelId)}</td><td>${escape(entry.caseId)}</td><td>${escape(entry.judgeId)}</td><td>${scoreCell}</td><td>${escape(entry.error ?? entry.comment ?? '')}</td></tr>`;
    })
    .join('\n');

  const costRows = report.cost.perModel
    .map(
      (entry) =>
        `<tr><td>${escape(entry.modelId)}</td><td>${entry.inputTokens}</td><td>${entry.outputTokens}</td><td>${entry.pricePerMillionInputTokens ?? 'n/a'}</td><td>${entry.pricePerMillionOutputTokens ?? 'n/a'}</td><td>${escape(usd(entry.estimatedCostUsd))}</td><td>${dataStatus(entry)}</td></tr>`,
    )
    .join('\n');
  const incompleteCostNote = hasIncompleteCostData(report.cost.perModel)
    ? '<p>⚠️ At least one model above has <code>partial</code> or <code>none</code> usage data (see its "Data" column) — its token/cost figures are a floor, not a precise total.</p>'
    : '';

  const limitationItems = report.limitations.map((limitation) => `<li>${escape(limitation.summary)}</li>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Second Income Coach — Evaluation Report</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #f0f0f0; }
  code { background: #f0f0f0; padding: 0 0.25rem; }
</style>
</head>
<body>
<h1>Second Income Coach — Evaluation Report</h1>
<p>Run date: ${escape(report.runDate)}<br/>Report generated: ${escape(report.reportGeneratedAt)}<br/>Trajectory accuracy target: ${pct(report.trajectoryAccuracyTarget)} per model</p>

<h2>Tool-call accuracy per model</h2>
<table><tr><th>Model</th><th>Deterministic cases</th><th>Passed</th><th>Accuracy</th><th>Meets target?</th></tr>
${accuracyRows}
</table>

<h2>Safety / guardrail tests (100% bar, zero tolerance)</h2>
<table><tr><th>Suite</th><th>Total</th><th>Passed</th><th>Failed</th><th>100%?</th></tr>
${guardrailRows}
</table>
<p>Overall (built suites only): ${report.guardrails.allBuiltSuitesPassed ? '✅ all passed' : '❌ at least one failed'}</p>
<p><strong>Pending</strong> (named by AD-23, not yet built — shown explicitly, never hidden):</p>
<ul>
${pendingItems}
</ul>

<h2>Judges</h2>
<p>Pinned judge models: ${escape(report.judgeModelIds.join(', '))}</p>
<table><tr><th>Judge</th><th>Scored models</th></tr>
${judgeRows}
</table>

<h2>Quality (LLM-as-judge) scores</h2>
<table><tr><th>Model</th><th>Case</th><th>Judge</th><th>Score</th><th>Comment / error</th></tr>
${qualityRows}
</table>

<h2>Estimated run cost</h2>
<p>Mechanism: ${escape(report.cost.mechanism)} (see Known limitations).</p>
<table><tr><th>Model</th><th>Input tokens</th><th>Output tokens</th><th>$/1M in</th><th>$/1M out</th><th>Estimated cost</th><th>Data</th></tr>
${costRows}
</table>
<p><strong>Total estimated cost (priced models only): $${report.cost.totalEstimatedCostUsd.toFixed(4)}</strong></p>
${incompleteCostNote}

<h2>Known limitations</h2>
<ul>
${limitationItems}
</ul>

<h2>Known weaknesses &amp; traceability</h2>
<p>See Epic 7, Story 7.4 (known-weaknesses/traceability documentation) — not yet written.</p>
</body>
</html>
`;
}

/** AC 6.3-5: "the same report run also emits a machine-readable JSON
 * summary with the same facts ... the source the public Quality &
 * Decisions page (Story 7.5) reads." `ReportData` already *is* that shape
 * — this just picks the stable public fields rather than exporting every
 * internal field verbatim. */
export function renderJsonSummary(report: ReportData): object {
  return {
    runDate: report.runDate,
    reportGeneratedAt: report.reportGeneratedAt,
    trajectoryAccuracyTarget: report.trajectoryAccuracyTarget,
    perModelAccuracy: report.perModelAccuracy,
    judges: {
      judgeModelIds: report.judgeModelIds,
      judgeScoredModels: report.judgeScoredModels,
      registryOverlap: report.judgeRegistryOverlap,
      qualityResults: report.qualityResults,
    },
    safety: {
      suites: report.guardrails.suites,
      allBuiltSuitesPassed: report.guardrails.allBuiltSuitesPassed,
      pending: report.guardrails.pending,
    },
    cost: {
      perModel: report.cost.perModel,
      totalEstimatedCostUsd: report.cost.totalEstimatedCostUsd,
      mechanism: report.cost.mechanism,
    },
    limitations: report.limitations,
  };
}
