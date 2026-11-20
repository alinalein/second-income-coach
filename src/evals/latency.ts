/**
 * User-requested (2026-11-20, amended): latency visibility per eval model,
 * alongside the existing accuracy/cost figures — "Start this step" felt
 * slow, and nothing in the eval suite measured how much of that is the
 * model call itself, or how that differs across the 4 evaluated models.
 * Both measurements below (the ack-call rows and each deterministic case's
 * own `durationMs`) are produced by `trajectory.eval.ts` itself, as part of
 * the one `npm run eval` run — never a separate file or step.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** One row per evaluated model, written by `trajectory.eval.ts` into
 * `trajectory-results.json`'s own `ackLatencyRows` field — 5 real calls per
 * model to the same `buildStartStepAckMessage` the `/start-ack` route
 * calls. */
export interface AckLatencyRow {
  modelId: string;
  callDurationsMs: number[];
  medianMs: number | null;
  maxMs: number | null;
  /** How many of the `callDurationsMs.length` calls returned no message at
   * all (one of `buildStartStepAckMessage`'s own fail-open branches) —
   * visibility only, never excluded from the duration measurement itself
   * (the call still took that long either way). */
  missingMessageCount: number;
}

/**
 * Per model: `medianMs`/`maxMs` straight from the recorded row, `calls` the
 * number of real calls that row's median/max are drawn from. Both
 * `medianMs`/`maxMs` are `null` (and `calls` is `0`) when `ackLatencyRows`
 * is absent, or carries no row for that model (a `trajectory-results.json`
 * written before this field existed) — "not measured", never a fabricated
 * number.
 */
export function ackLatencyByModel(
  modelIds: readonly string[],
  ackLatencyRows: readonly AckLatencyRow[] | undefined,
): { modelId: string; medianMs: number | null; maxMs: number | null; calls: number }[] {
  return modelIds.map((modelId) => {
    const row = ackLatencyRows?.find((entry) => entry.modelId === modelId);
    return { modelId, medianMs: row?.medianMs ?? null, maxMs: row?.maxMs ?? null, calls: row?.callDurationsMs.length ?? 0 };
  });
}

/**
 * Per model: the median `durationMs` across this model's own deterministic
 * trajectory rows that actually recorded one. `null` when none did (a
 * `trajectory-results.json` written before this field existed, or every
 * one of this model's deterministic rows errored before timing started) —
 * "not measured", never a fabricated number.
 */
export function deterministicLatencyByModel(
  rows: readonly { modelId: string; caseType: string; durationMs?: number }[],
  modelIds: readonly string[],
): { modelId: string; medianMs: number | null }[] {
  return modelIds.map((modelId) => {
    const durations = rows
      .filter((row) => row.modelId === modelId && row.caseType === 'deterministic' && typeof row.durationMs === 'number')
      .map((row) => row.durationMs!);
    return { modelId, medianMs: median(durations) };
  });
}
