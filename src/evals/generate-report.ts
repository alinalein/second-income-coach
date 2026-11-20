import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishedEvalResultsSchema } from '@app/shared';
import { assessRunCompleteness, buildReport, type TrajectoryResults } from './build-report.js';
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
  /** Story 7.5's input file (committed, not gitignored) — distinct from
   * `outDir`/`results/`, which stays gitignored generated output. */
  publishedResultsPath: string;
  /** Injectable seam (Review Triage Log: "no test exercised `main()` at
   * all") — the real default spawns real `vitest` child processes; tests
   * inject a fake so the pipeline is exercised without that cost. */
  runGuardrailSuites: () => GuardrailSuiteResult[];
}

export interface PublishResult {
  written: boolean;
  /** Only set when `written` is false — why the published file was left
   * untouched ("never from a partial run"). */
  reason?: string;
}

export interface RunGenerateReportResult {
  reportMdPath: string;
  reportHtmlPath: string;
  reportJsonPath: string;
  allBuiltSuitesPassed: boolean;
  published: PublishResult;
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
  const jsonSummary = renderJsonSummary(report);
  fs.writeFileSync(reportJsonPath, JSON.stringify(jsonSummary, null, 2));

  // "Never from a partial run": a `-t`-filtered `npm run eval` must never
  // overwrite the committed published file with incomplete data — checked
  // against the raw trajectory results (not the rendered report, which has
  // already smoothed a missing `mistralJailbreakFlagRate` into "pending").
  const completeness = assessRunCompleteness(trajectoryResults);
  let published: PublishResult;
  if (completeness.complete) {
    // Same numbers as report.json, nothing hand-copied — `jsonSummary` is
    // the exact object already written above. Validated against the shared
    // schema Story 7.5 also validates with, so a shape drift here fails
    // loudly now rather than silently breaking that page later.
    publishedEvalResultsSchema.parse(jsonSummary);
    fs.mkdirSync(path.dirname(options.publishedResultsPath), { recursive: true });
    fs.writeFileSync(options.publishedResultsPath, JSON.stringify(jsonSummary, null, 2));
    published = { written: true };
  } else {
    published = { written: false, reason: completeness.reason };
  }

  return { reportMdPath, reportHtmlPath, reportJsonPath, allBuiltSuitesPassed: report.guardrails.allBuiltSuitesPassed, published };
}

const evalsDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = path.join(evalsDir, '..');

function main(): void {
  try {
    const publishedResultsPath = path.join(evalsDir, 'published', 'eval-results.json');
    const result = runGenerateReport({
      trajectoryResultsPath: path.join(evalsDir, 'results', 'trajectory-results.json'),
      outDir: path.join(evalsDir, 'results'),
      publishedResultsPath,
      runGuardrailSuites: () => runGuardrailSuites(srcDir),
    });

    console.log(`Evaluation report written to:\n  ${result.reportMdPath}\n  ${result.reportHtmlPath}\n  ${result.reportJsonPath}`);
    if (result.published.written) {
      console.log(`Published results refreshed at:\n  ${publishedResultsPath}\nCommit this file.`);
    } else {
      console.warn(`Published results NOT refreshed (left untouched) — ${result.published.reason}`);
    }
    if (!result.allBuiltSuitesPassed) {
      console.error('Warning: at least one built guardrail suite failed — see the report for details.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Bug fix (discovered live, 2026-11-20): `main()` used to run unconditionally
// at module scope — every test importing `runGenerateReport` from this file
// (`generate-report.test.ts`) also ran a real `main()` as an unwanted
// side effect, overwriting the committed `published/eval-results.json`
// against whatever stale `results/trajectory-results.json` happened to be
// on disk every time `npm test` ran. Only runs when this file is the actual
// process entry point (`tsx evals/generate-report.ts`, `eval:report`'s own
// script), never on a plain import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
