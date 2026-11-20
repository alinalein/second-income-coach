import { describe, expect, it } from 'vitest';
import type { PublishedEvalResults } from '@app/shared';
import { mergeLatencyIntoPublishedResults } from './measure-latency.js';
import type { AckLatencyRow } from './latency.js';

const basePublished: PublishedEvalResults = {
  runDate: '2026-11-19T19:31:00.000Z',
  reportGeneratedAt: '2026-11-19T19:31:05.000Z',
  trajectoryAccuracyTarget: 0.8,
  perModelAccuracy: [{ modelId: 'openai/gpt-6-luna', deterministicCaseCount: 10, passedCaseCount: 9, accuracy: 0.9, meetsTarget: true }],
  judges: { judgeModelIds: ['google/gemini-3.8-flash'], judgeScoredModels: {}, registryOverlap: [], qualityResults: [] },
  safety: { suites: [], allBuiltSuitesPassed: false, pending: [] },
  mistralJailbreakFlagRate: { status: 'pending', reason: 'not recorded' },
  cost: { perModel: [], totalEstimatedCostUsd: 0.1168, mechanism: 'eval-only-price-table' },
  limitations: [{ id: 'story-7-4-pending', summary: 'pending' }],
};

const sampleAckLatencyRows: AckLatencyRow[] = [
  { modelId: 'openai/gpt-6-luna', callDurationsMs: [100, 200, 300, 400, 500], medianMs: 300, maxMs: 500, missingMessageCount: 0 },
];

/** User-requested (2026-11-20, Job A): `npm run eval:latency`'s own merge
 * must only ever touch the `latency` block — every other already-published
 * field (cost, accuracy, safety, ...) reaches the output byte-for-byte
 * unchanged. */
describe('mergeLatencyIntoPublishedResults', () => {
  it('fills in the latency block from the freshly measured ackLatencyRows', () => {
    const merged = mergeLatencyIntoPublishedResults(basePublished, sampleAckLatencyRows, ['openai/gpt-6-luna']);
    expect(merged.latency).toEqual({
      ackByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: 300, maxMs: 500, calls: 5 }],
      deterministicByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: null }],
    });
  });

  it('every other field (cost, accuracy, safety, limitations, run dates) reaches the output unchanged', () => {
    const merged = mergeLatencyIntoPublishedResults(basePublished, sampleAckLatencyRows, ['openai/gpt-6-luna']);
    const { latency, ...mergedWithoutLatency } = merged;
    expect(latency).toBeDefined();
    expect(mergedWithoutLatency).toEqual(basePublished);
  });

  it("a published file that already has a deterministicByModel carries it forward, never resetting it to null", () => {
    const publishedWithDeterministic: PublishedEvalResults = {
      ...basePublished,
      latency: { ackByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: 999, maxMs: 999, calls: 5 }], deterministicByModel: [{ modelId: 'openai/gpt-6-luna', medianMs: 1234 }] },
    };
    const merged = mergeLatencyIntoPublishedResults(publishedWithDeterministic, sampleAckLatencyRows, ['openai/gpt-6-luna']);
    expect(merged.latency?.deterministicByModel).toEqual([{ modelId: 'openai/gpt-6-luna', medianMs: 1234 }]);
    expect(merged.latency?.ackByModel).toEqual([{ modelId: 'openai/gpt-6-luna', medianMs: 300, maxMs: 500, calls: 5 }]);
  });
});
