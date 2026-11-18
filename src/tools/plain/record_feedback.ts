import { and, eq } from 'drizzle-orm';
import { feedbackRatingSchema, type FeedbackRating, type MessageFeedback } from '@app/shared';
import type { createDb } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { messageFeedback } from '../../db/schema/index.js';
import { defaultClassify, evaluateUserMessage, type ClassifyText } from '../../agent/moderation.js';
import { forgetFeedback, rememberFeedback, type MemoryDeleteStore, type MemoryPutStore } from '../../agent/memory.js';
import { recordFeedbackExample, type FeedbackDatasetDeps } from '../../agent/feedback-dataset.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * AD-11/AD-22: the optional comment's moderation branch, as a pure function
 * over an already-classified verdict (same "pure decision logic, unit-
 * testable without a real Mistral call" precedent as `moderation.ts`'s own
 * `evaluateUserMessage`) — `reject` drops the comment (rating still stored
 * by the caller; the incident is already logged inside `evaluateUserMessage`
 * itself), `redact` stores the cleaned text, `pass` stores it verbatim.
 */
export async function resolveFeedbackComment(
  comment: string | undefined,
  classify: ClassifyText,
  threadId: string | undefined,
): Promise<string | null> {
  if (!comment) return null;

  const verdict = await evaluateUserMessage(comment, classify, threadId);
  if (verdict.action === 'reject') return null;
  if (verdict.action === 'redact') return verdict.content;
  return comment;
}

export interface SetFeedbackParams {
  messageId: string;
  threadId: string;
  userId: string;
  rating: FeedbackRating;
  comment?: string;
}

export interface RecordFeedbackDeps {
  /** Test-only seam (same DI pattern as `createModerationMiddleware`'s
   * `classify`): a fake Mistral Moderation 2 call instead of a real one. */
  classify?: ClassifyText;
  /** Story 5.3b (AD-2): the per-user semantic memory store. Optional —
   * when omitted, no memory read/write happens at all (e.g. a test that
   * only cares about the DB write, or a deployment that hasn't finished
   * wiring it up). */
  memoryStore?: MemoryPutStore & MemoryDeleteStore;
  /** Story 5.3b (AD-22): test-only seam for the LangSmith dataset write —
   * see `FeedbackDatasetDeps`. */
  dataset?: FeedbackDatasetDeps['client'];
}

/**
 * Review fix: the route-level thread-ownership check (`chat.ts`'s session
 * scoping, `plan-chat.ts`'s `assertPlanOwnership`) only proves the caller
 * owns the *thread* — it never checks that the client-supplied `:messageId`
 * actually belongs to a message within it. Without this check, a caller who
 * supplies a `messageId` belonging to a different user's message would hit
 * `onConflictDoUpdate`'s unconditional `set`, silently overwriting that
 * other user's stored rating/comment. Same "ownership check throws, route
 * maps to 404" precedent as `set_idea_status.ts`'s `IdeaNotFoundError`.
 */
export class FeedbackOwnershipError extends Error {}

/**
 * AD-4/AD-22: a plain deterministic Postgres write — never agent-callable
 * (same boundary as every other `src/tools/plain/*` tool, e.g.
 * `set_idea_status.ts`). Reachable only via `POST .../messages/:messageId/
 * feedback` in `chat.ts`/`plan-chat.ts`. Never touches moderation/guardrail
 * state elsewhere (Boundary) — a rating has no effect on any hard-constraint
 * check.
 *
 * Upserts on `messageId` (one row per message, DB unique constraint) —
 * calling this again for the same message id changes the existing rating/
 * comment in place (I/O matrix: "Change/remove rating ... Upsert on
 * change") — but only when the existing row (if any) already belongs to this
 * same `userId`; otherwise throws `FeedbackOwnershipError` before writing
 * anything.
 *
 * Story 5.3b (AD-2/AD-22): once the Postgres write above has succeeded, a
 * moderated comment (I/O matrix: "Thumbs only, no comment -> no memory/
 * dataset write — nothing to embed") is upserted into the user's semantic
 * memory and added as a LangSmith example — both best-effort (Boundary:
 * "Memory/dataset writes never fail or block the feedback HTTP response").
 * Review fix: these calls are never `await`ed here — a live Mistral embed
 * call plus a LangSmith round trip would otherwise sit directly in this
 * function's own (and so the HTTP response's) critical path, which is
 * exactly what the Boundary forbids. `rememberFeedback`/`recordFeedbackExample`
 * already catch and log internally and never reject, so firing them without
 * awaiting can never produce an unhandled rejection either.
 */
export async function setFeedback(
  db: Db,
  env: Pick<Env, 'MISTRAL_API_KEY' | 'LANGSMITH_TRACING' | 'LANGSMITH_API_KEY' | 'LANGSMITH_FEEDBACK_DATASET'>,
  params: SetFeedbackParams,
  deps: RecordFeedbackDeps = {},
): Promise<MessageFeedback> {
  const rating = feedbackRatingSchema.parse(params.rating);
  const classify = deps.classify ?? defaultClassify(env);
  const comment = await resolveFeedbackComment(params.comment, classify, params.threadId);

  const [existing] = await db
    .select({ userId: messageFeedback.userId })
    .from(messageFeedback)
    .where(eq(messageFeedback.messageId, params.messageId))
    .limit(1);

  if (existing && existing.userId !== params.userId) {
    throw new FeedbackOwnershipError(`Message "${params.messageId}" has feedback owned by a different user`);
  }

  await db
    .insert(messageFeedback)
    .values({ messageId: params.messageId, threadId: params.threadId, userId: params.userId, rating, comment })
    .onConflictDoUpdate({
      target: messageFeedback.messageId,
      set: { rating, comment, updatedAt: new Date() },
    });

  if (comment) {
    if (deps.memoryStore) {
      void rememberFeedback(deps.memoryStore, { userId: params.userId, messageId: params.messageId, comment });
    }
    void recordFeedbackExample(
      env,
      { userId: params.userId, threadId: params.threadId, messageId: params.messageId, rating, comment },
      { client: deps.dataset },
    );
  } else if (deps.memoryStore) {
    // A rating that previously had a comment (and so a memory entry) can be
    // changed to a thumbs-only rating on the same message id — drop the
    // now-stale memory entry rather than leaving it behind under a rating
    // that no longer has a comment backing it.
    void forgetFeedback(deps.memoryStore, params.userId, params.messageId);
  }

  return { rating, comment };
}

/**
 * Removes an existing rating — a no-op (never throws) when none exists for
 * this message/user, same "harmless no-op" precedent as `set_idea_status.
 * ts`'s re-reject case (I/O matrix: "... row deleted on remove").
 *
 * Story 5.3b: also deletes that message's memory entry, if any (I/O
 * matrix: "Rating changed/removed ... memory entry updated / deleted to
 * match") — best-effort, same as `setFeedback`'s own memory write.
 */
export async function removeFeedback(
  db: Db,
  messageId: string,
  userId: string,
  deps: Pick<RecordFeedbackDeps, 'memoryStore'> = {},
): Promise<void> {
  await db.delete(messageFeedback).where(and(eq(messageFeedback.messageId, messageId), eq(messageFeedback.userId, userId)));
  if (deps.memoryStore) {
    void forgetFeedback(deps.memoryStore, userId, messageId);
  }
}
