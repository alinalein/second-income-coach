import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { publishedEvalResultsSchema, type PublishedEvalResults } from '@app/shared';
import { loadEvalEnv } from './env.js';
import { createChatModel } from '../agent/model.js';
import { buildStartStepAckMessage } from '../api/routes/plans.js';
import { ackLatencyByModel, median, type AckLatencyRow } from './latency.js';
import { ACK_LATENCY_CALLS_PER_MODEL, ACK_LATENCY_STEP_TITLE, EVAL_MODEL_IDS } from './constants.js';

/**
 * User-requested (2026-11-20, Job A): "make the latency table appear now —
 * do not wait for a full eval." The same measurement `trajectory.eval.ts`'s
 * own dedicated `it`s make (4 models x `ACK_LATENCY_CALLS_PER_MODEL` real
 * `buildStartStepAckMessage` calls), run standalone via `npm run
 * eval:latency` so this one cheap number doesn't have to wait on the full,
 * expensive trajectory matrix. Merges into the committed
 * `src/evals/published/eval-results.json` — never a second file — and
 * leaves every other field untouched; a later `npm run eval` + `npm run
 * eval:report` fills the exact same `latency` block, same shape.
 */
export function mergeLatencyIntoPublishedResults(
  current: PublishedEvalResults,
  ackLatencyRows: readonly AckLatencyRow[],
  modelIds: readonly string[] = EVAL_MODEL_IDS,
): PublishedEvalResults {
  return {
    ...current,
    latency: {
      ackByModel: ackLatencyByModel(modelIds, ackLatencyRows),
      // Never measured by this standalone script (that's a full
      // `npm run eval` run's own deterministic trajectory cases) — carries
      // forward whatever the published file already had, or "not measured"
      // on a first run, never a fabricated number.
      deterministicByModel: current.latency?.deterministicByModel ?? modelIds.map((modelId) => ({ modelId, medianMs: null })),
    },
  };
}

async function measureAckLatencyForModel(env: ReturnType<typeof loadEvalEnv>, modelId: string): Promise<AckLatencyRow> {
  const model = createChatModel(env, modelId);
  const callDurationsMs: number[] = [];
  let missingMessageCount = 0;

  for (let callIndex = 0; callIndex < ACK_LATENCY_CALLS_PER_MODEL; callIndex += 1) {
    const threadId = `discovery:eval-latency-${modelId}-${callIndex}`;
    const startedAt = performance.now();
    const message = await buildStartStepAckMessage(model, async () => ({}), threadId, 'en', ACK_LATENCY_STEP_TITLE, []);
    callDurationsMs.push(performance.now() - startedAt);
    if (!message) missingMessageCount += 1;
  }

  return {
    modelId,
    callDurationsMs,
    medianMs: median(callDurationsMs),
    maxMs: callDurationsMs.length > 0 ? Math.max(...callDurationsMs) : null,
    missingMessageCount,
  };
}

const evalsDir = fileURLToPath(new URL('.', import.meta.url));

async function main(): Promise<void> {
  // Same precedent as `vitest.eval.config.ts`: loads the repo-root `.env`,
  // never overriding a variable already set inline, and never logging it.
  loadDotenv({ path: path.join(evalsDir, '..', '..', '.env'), quiet: true });
  const env = loadEvalEnv();

  const publishedPath = path.join(evalsDir, 'published', 'eval-results.json');
  const existingRaw = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
  const existing = publishedEvalResultsSchema.safeParse(existingRaw);
  if (!existing.success) {
    console.error(`Refusing to write: ${publishedPath} does not currently match the published schema.`);
    console.error(existing.error.message);
    process.exitCode = 1;
    return;
  }

  console.log(`Measuring start-step ack latency for ${EVAL_MODEL_IDS.length} models (${ACK_LATENCY_CALLS_PER_MODEL} real calls each)...`);
  const ackLatencyRows: AckLatencyRow[] = [];
  for (const modelId of EVAL_MODEL_IDS) {
    ackLatencyRows.push(await measureAckLatencyForModel(env, modelId));
  }

  const merged = mergeLatencyIntoPublishedResults(existing.data, ackLatencyRows);
  const validated = publishedEvalResultsSchema.safeParse(merged);
  if (!validated.success) {
    console.error('Refusing to write: the merged result failed schema validation.');
    console.error(validated.error.message);
    process.exitCode = 1;
    return;
  }

  // Atomic write — a crash mid-write never leaves a corrupt published file.
  const tmpPath = `${publishedPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(validated.data, null, 2));
  fs.renameSync(tmpPath, publishedPath);

  console.log(`Latency measured and merged into:\n  ${publishedPath}`);
  for (const row of ackLatencyRows) {
    const medianLabel = row.medianMs === null ? 'not measured' : `${Math.round(row.medianMs)} ms`;
    const maxLabel = row.maxMs === null ? 'not measured' : `${Math.round(row.maxMs)} ms`;
    console.log(`  ${row.modelId}: median ${medianLabel}, max ${maxLabel}, calls ${row.callDurationsMs.length}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
