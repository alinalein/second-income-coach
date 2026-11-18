import { describe, expect, it, vi } from 'vitest';
import { recordFeedbackExample } from './feedback-dataset.js';

const ENV = { LANGSMITH_TRACING: 'true' as const, LANGSMITH_API_KEY: 'key', LANGSMITH_FEEDBACK_DATASET: 'ds' };

function fakeClient(hasDataset = true) {
  return {
    hasDataset: vi.fn().mockResolvedValue(hasDataset),
    createDataset: vi.fn().mockResolvedValue(undefined),
    createExample: vi.fn().mockResolvedValue(undefined),
  };
}

// I/O matrix: "LangSmith not tracing (`LANGSMITH_TRACING=false`) -> dataset
// write is a no-op with a log line."
describe('recordFeedbackExample (tracing disabled)', () => {
  it('never touches the client when LANGSMITH_TRACING is not "true"', async () => {
    const client = fakeClient();

    await recordFeedbackExample(
      { LANGSMITH_TRACING: 'false', LANGSMITH_API_KEY: 'key', LANGSMITH_FEEDBACK_DATASET: 'ds' },
      { userId: 'u1', threadId: 'discovery:u1', messageId: 'm1', rating: 'up', comment: 'great' },
      { client },
    );

    expect(client.hasDataset).not.toHaveBeenCalled();
    expect(client.createExample).not.toHaveBeenCalled();
  });
});

// I/O matrix: "Rating + comment stored -> ... LangSmith example added" —
// ensures the dataset via hasDataset/createDataset (both variants of the
// same dataset-ensure branch, table-driven per CLAUDE.md), then always
// writes the example with the already-moderated comment and rating.
describe('recordFeedbackExample (tracing enabled)', () => {
  it.each([
    ['the dataset is missing', false, true],
    ['the dataset already exists', true, false],
  ] as const)('when %s, createDataset is called: %s, then the example is always written', async (_label, hasDataset, expectCreateDataset) => {
    const client = fakeClient(hasDataset);

    await recordFeedbackExample(
      ENV,
      { userId: 'u1', threadId: 'discovery:u1', messageId: 'm1', rating: 'up', comment: 'great' },
      { client },
    );

    expect(client.createDataset).toHaveBeenCalledTimes(expectCreateDataset ? 1 : 0);
    expect(client.createExample).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset_name: 'ds',
        inputs: { threadId: 'discovery:u1' },
        reference_outputs: { comment: 'great', rating: 'up' },
        metadata: { userId: 'u1', messageId: 'm1' },
      }),
    );
  });

  // Boundary: "Memory/dataset writes never fail or block the feedback HTTP
  // response" / I/O matrix: "logged, never thrown to caller".
  it('never throws when the LangSmith client call fails', async () => {
    const client = {
      hasDataset: vi.fn().mockRejectedValue(new Error('network down')),
      createDataset: vi.fn(),
      createExample: vi.fn(),
    };

    await expect(
      recordFeedbackExample(
        ENV,
        { userId: 'u1', threadId: 'discovery:u1', messageId: 'm1', rating: 'up', comment: 'great' },
        { client },
      ),
    ).resolves.toBeUndefined();
  });
});
