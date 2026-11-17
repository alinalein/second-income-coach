import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, type TrajectoryResults } from './build-report.js';
import { runGuardrailSuites, type GuardrailSuiteResult } from './guardrails.js';
import { renderHtml, renderJsonSummary, renderMarkdown } from './render.js';

/**
 * Story 6.3 AC: "a single command produces [the report] end to end (e.g.
 * `npm run eval:report`) — no manual assembly step." Reads Story 6.2's
 * already-written `trajectory-results.json` (never re-runs the paid
 * trajectory suite itself) and actually runs Story 6.1's committed,
 * deterministic guardrail suites (no cost, no network call) to measure
 * their pass/fail rather than hand-typing it.
 */
export interface RunGenerateReportOptions {
  trajectoryResultsPath: string;
  outDir: string;
  /** Injectable seam (Review Triage Log: "no test exercised `main()` at
   * all") — the real default spawns real `vitest` child processes; tests
   * inject a fake so the pipeline is exercised without that cost. */
  runGuardrailSuites: () => GuardrailSuiteResult[];
}

export interface RunGenerateReportResult {
  reportMdPath: string;
  reportHtmlPath: string;
  reportJsonPath: string;
  allBuiltSuitesPassed: boolean;
}

/**
 * The one function `main()` below wires to real paths/process. Pulled out
 * so it's callable directly from a test with a temp `outDir` and a fake
 * `runGuardrailSuites`, instead of only being exercisable by actually
 * invoking the CLI.
 */
export function runGenerateReport(options: RunGenerateReportOptions): RunGenerateReportResult {
  if (!fs.existsSync(options.trajectoryResultsPath)) {
    throw new Error(
      `No trajectory results found at ${options.trajectoryResultsPath}.\nRun \`npm run eval\` first (Story 6.2's trajectory suite) — this script never runs it for you.`,
    );
  }

  const trajectoryResults = JSON.parse(fs.readFileSync(options.trajectoryResultsPath, 'utf8')) as TrajectoryResults;
  const guardrailResults = options.runGuardrailSuites();
  const report = buildReport(trajectoryResults, guardrailResults);

  const reportMdPath = path.join(options.outDir, 'report.md');
  const reportHtmlPath = path.join(options.outDir, 'report.html');
  const reportJsonPath = path.join(options.outDir, 'report.json');

  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(reportMdPath, renderMarkdown(report));
  fs.writeFileSync(reportHtmlPath, renderHtml(report));
  fs.writeFileSync(reportJsonPath, JSON.stringify(renderJsonSummary(report), null, 2));

  return { reportMdPath, reportHtmlPath, reportJsonPath, allBuiltSuitesPassed: report.guardrails.allBuiltSuitesPassed };
}

const evalsDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = path.join(evalsDir, '..');

function main(): void {
  try {
    const result = runGenerateReport({
      trajectoryResultsPath: path.join(evalsDir, 'results', 'trajectory-results.json'),
      outDir: path.join(evalsDir, 'results'),
      runGuardrailSuites: () => runGuardrailSuites(srcDir),
    });

    console.log(`Evaluation report written to:\n  ${result.reportMdPath}\n  ${result.reportHtmlPath}\n  ${result.reportJsonPath}`);
    if (!result.allBuiltSuitesPassed) {
      console.error('Warning: at least one built guardrail suite failed — see the report for details.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
