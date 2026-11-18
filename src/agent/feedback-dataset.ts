import { Client } from 'langsmith';
import type { Env } from '../config/env.js';
import type { FeedbackRating } from '@app/shared';

export interface RecordFeedbackExampleParams {
  userId: string;
  threadId: string;
  messageId: string;
  rating: FeedbackRating;
  /** Design Notes: always the already-moderated comment — never raw user
   * input (same text already stored in `messageFeedback.comment`). */
  comment: string;
}

/** Test-only seam (same DI pattern as `RecordFeedbackDeps.classify`): a
 * fake LangSmith `Client` instead of a real network call. */
export interface FeedbackDatasetDeps {
  client?: Pick<Client, 'hasDataset' | 'createDataset' | 'createExample'>;
}

/**
 * Code Map: "`recordFeedbackExample(env, {...})` using `langsmith`'s
 * `Client`; no-op + log when `LANGSMITH_TRACING !== 'true'`; ensures
 * dataset via `hasDataset`/`createDataset`." Boundary: never throws to the
 * caller (`record_feedback.ts`'s `setFeedback`/`removeFeedback`) — every
 * failure is caught and logged (I/O matrix: "Embedding/store call fails ...
 * logged, never thrown to caller").
 *
 * Design Notes: this dataset is "used only for offline prompt improvement,
 * never model training" (AC) — the text written here is always the
 * already-moderated comment, the same anonymization boundary
 * `resolveFeedbackComment` already enforces before it ever reaches this
 * function.
 */
export async function recordFeedbackExample(
  env: Pick<Env, 'LANGSMITH_TRACING' | 'LANGSMITH_API_KEY' | 'LANGSMITH_FEEDBACK_DATASET'>,
  params: RecordFeedbackExampleParams,
  deps: FeedbackDatasetDeps = {},
): Promise<void> {
  // I/O matrix: "LangSmith not tracing (`LANGSMITH_TRACING=false`) -> dataset
  // write is a no-op with a log line."
  if (env.LANGSMITH_TRACING !== 'true') {
    console.log('[feedback-dataset] tracing disabled — skipping dataset write', { messageId: params.messageId });
    return;
  }

  try {
    const client = deps.client ?? new Client({ apiKey: env.LANGSMITH_API_KEY });
    const datasetName = env.LANGSMITH_FEEDBACK_DATASET;

    // Review fix: isolated from the `createExample` call below — two
    // concurrent first-ever writes can both see `hasDataset` false and race
    // on `createDataset` (one loses with an "already exists" conflict). That
    // race must never drop this example, so it's swallowed here rather than
    // left to the outer catch, which would skip `createExample` entirely.
    try {
      const exists = await client.hasDataset({ datasetName });
      if (!exists) {
        await client.createDataset(datasetName, {
          description: 'Rated chat traces (thumbs + moderated comment) for offline prompt improvement — never model training.',
        });
      }
    } catch (error) {
      console.error('[feedback-dataset] dataset ensure failed (continuing to write the example):', {
        messageId: params.messageId,
        error: (error as Error)?.message,
      });
    }

    await client.createExample({
      dataset_name: datasetName,
      inputs: { threadId: params.threadId },
      reference_outputs: { comment: params.comment, rating: params.rating },
      metadata: { userId: params.userId, messageId: params.messageId },
    });
  } catch (error) {
    console.error('[feedback-dataset] write failed:', { messageId: params.messageId, error: (error as Error)?.message });
  }
}
