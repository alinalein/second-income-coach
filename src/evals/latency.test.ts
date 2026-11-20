import { describe, expect, it } from 'vitest';
import { ackLatencyByModel, deterministicLatencyByModel, median } from './latency.js';

// User-requested (2026-11-20): report/schema mapping for the new per-model
// latency visibility — one test per distinct branch (empty input, odd/even
// count, a model with no recorded data renders "not measured" (`null`),
// never a fabricated number).
describe('median', () => {
  it.each([
    ['empty list -> null (never a fabricated 0)', [], null],
    ['odd count -> the middle value', [300, 100, 200], 200],
    ['even count -> the average of the two middle values', [100, 200, 300, 400], 250],
  ] as const)('%s', (_name, values, expected) => {
    expect(median(values)).toBe(expected);
  });
});

describe('ackLatencyByModel', () => {
  it('a model with a recorded row carries its medianMs/maxMs/calls through unchanged', () => {
    const result = ackLatencyByModel(
      ['model-a', 'model-b'],
      [{ modelId: 'model-a', callDurationsMs: [100, 200], medianMs: 150, maxMs: 200, missingMessageCount: 0 }],
    );
    expect(result).toEqual([
      { modelId: 'model-a', medianMs: 150, maxMs: 200, calls: 2 },
      { modelId: 'model-b', medianMs: null, maxMs: null, calls: 0 },
    ]);
  });

  it('ackLatencyRows entirely absent -> every model is "not measured" with 0 calls', () => {
    expect(ackLatencyByModel(['model-a'], undefined)).toEqual([{ modelId: 'model-a', medianMs: null, maxMs: null, calls: 0 }]);
  });
});

describe('deterministicLatencyByModel', () => {
  it('computes the median only from this model\'s own deterministic rows that recorded a durationMs', () => {
    const rows = [
      { modelId: 'model-a', caseType: 'deterministic', durationMs: 1000 },
      { modelId: 'model-a', caseType: 'deterministic', durationMs: 2000 },
      // A quality row for the same model must never be folded into its
      // deterministic latency median.
      { modelId: 'model-a', caseType: 'quality', durationMs: 9999 },
      // A deterministic row with no durationMs (predates the field, or its
      // case errored before timing started) must be excluded, not treated
      // as 0.
      { modelId: 'model-a', caseType: 'deterministic' },
    ];
    expect(deterministicLatencyByModel(rows, ['model-a', 'model-b'])).toEqual([
      { modelId: 'model-a', medianMs: 1500 },
      { modelId: 'model-b', medianMs: null },
    ]);
  });
});
