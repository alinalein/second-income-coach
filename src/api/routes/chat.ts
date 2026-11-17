import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  chatHistoryResponseSchema,
  chatMessageSchema,
  progressEventSchema,
  recordFeedbackRequestSchema,
  resultEventSchema,
  sendMessageRequestSchema,
  type ChatMessage,
  type CurrencyCode,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import type { TurnUsageWithModel } from '../../agent/index.js';
import { buildDiscoveryThreadId } from '../../agent/index.js';
import { classifyAssistantMessageKind } from '../../agent/moderation.js';
import { MODEL_FAILURE_MESSAGE, MODEL_FAILURE_MESSAGE_DE } from '../../agent/resilience.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';
import { getUserSettings } from '../../db/settings-repository.js';
import { computeMessageCost, convertStoredCost, toMessageCostDisplay } from '../../agent/turn-cost.js';
import { getMessageCosts, saveMessageCost } from '../../db/message-cost-repository.js';
import { FeedbackOwnershipError, removeFeedback, setFeedback } from '../../tools/plain/record_feedback.js';

export interface ChatRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'MISTRAL_API_KEY'>;
  agent: CoachAgent;
  /** Story 5.2/5.3: reads `user_settings.currency` for cost conversion
   * (AD-27) and persists/reads `message_costs`/`message_feedback` rows. */
  db: ReturnType<typeof createDb>['db'];
}

/** AD-27: the default when a user has no settings row yet — same default
 * `user_settings.currency` itself carries (Story 1.2). */
const DEFAULT_CURRENCY: CurrencyCode = 'EUR';

function toChatMessage(message: BaseMessage): ChatMessage | undefined {
  const type = message._getType();
  if (type !== 'human' && type !== 'ai') return undefined;

  const content = message.text;
  if (!content) return undefined;

  return chatMessageSchema.parse({
    id: message.id ?? randomUUID(),
    role: type === 'human' ? 'user' : 'assistant',
    kind: type === 'human' ? 'message' : classifyAssistantMessageKind(content),
    content,
    // The checkpointer persists conversational context, not a fact store
    // (Design Notes: "a thread's message history is exactly that, not a hard
    // fact another capability depends on being exact") — it doesn't carry a
    // per-message timestamp, so history read-back uses the read time for all
    // messages rather than fabricating a per-message one.
    createdAt: new Date().toISOString(),
  });
}

/**
 * `createChatRouter`: `POST /api/chat/messages` (validate, invoke the agent
 * for the session's thread, return the reply) and `GET /api/chat/messages`
 * (the thread's checkpointed state as history). Both routes rely on the
 * blanket `requireAuth` gate already applied in `app.ts` before this router
 * is mounted (Code Map: "mount the chat router after `app.use(requireAuth)`")
 * — neither route re-applies it itself.
 */
export function createChatRouter({ env, agent, db }: ChatRouterDeps) {
  const router = Router();
  // Intent: "`POST /api/chat/messages` uses `createStrictRateLimiter`" — the
  // first LLM-backed, cost-bearing route to consume the stricter tier
  // (Design Notes).
  const strictLimiter = createStrictRateLimiter(env);

  router.post('/messages', strictLimiter, async (req, res) => {
    const parseResult = sendMessageRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      // I/O matrix: "Over-length message" -> "Rejected at the schema
      // boundary (4xx)" / "Never silently truncated". Rejected before any SSE
      // headers are written, so this still round-trips as a normal 4xx JSON
      // response, not a stream.
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    const threadId = buildDiscoveryThreadId(req.session.userId!);
    const userMessage = new HumanMessage(parseResult.data.content);
    // I/O matrix: "Model call exhausts retries, German message" -> the fixed
    // failure text is picked via `detectReplyLanguage` on the submitted
    // content, same as moderation's own DE/EN picks (AC2) — computed once so
    // both fallback sites below (no-usable-reply / catch) stay consistent.
    const modelFailureMessage =
      detectReplyLanguage(parseResult.data.content) === 'de' ? MODEL_FAILURE_MESSAGE_DE : MODEL_FAILURE_MESSAGE;

    // AC6: "progress events for one turn ... arrive over one turn-scoped SSE
    // connection". Code Map: write SSE headers, then stream `'custom'`-mode
    // chunks (progress events only, never partial answer text — AD-19) as
    // `event: progress` frames, and close with one `event: result` frame.
    // `X-Accel-Buffering: no` is a reverse-proxy-buffering opt-out (nginx and
    // similar) — harmless on proxies that ignore it.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Design Notes: "Guarding res.write/res.end against a mid-turn client
    // disconnect" — the connection stays open for the whole turn, long enough
    // for a tab close/navigation to land mid-stream. A write to an
    // already-ended/destroyed response doesn't necessarily throw into a
    // surrounding try/catch, so every write goes through this guard instead
    // of a bare `res.write`/`res.end` call.
    function safeWrite(chunk: string): void {
      if (res.writableEnded) return;
      try {
        res.write(chunk);
      } catch (error) {
        console.warn('[chat] SSE write failed (client likely disconnected):', { threadId, error: (error as Error)?.message });
      }
    }

    // Guards its own body (not just the write) so either call site -- the
    // happy path or the catch block below -- can never leave the connection
    // open indefinitely, the one guarantee this whole feature must keep.
    function writeResultEvent(message: ChatMessage): void {
      try {
        const event = resultEventSchema.parse({ type: 'result', message });
        safeWrite(`event: result\ndata: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        console.error('[chat] failed to build/write the terminal result event:', { threadId, error: (error as Error)?.message });
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Already-closed connection — nothing left to do.
        }
      }
    }

    // Design Notes: "No early termination of agent.stream()'s iteration on
    // client disconnect" -- stops consuming/writing once the client is gone;
    // does not claim to abort the underlying model/moderation call already
    // in flight, only to stop wasted local iteration and no-op writes.
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    try {
      // Design Notes: "Why streamMode: ['custom', 'values'], not 'custom' +
      // a separate agent.getState(...) read" — a separate getState() call
      // after the stream ends reads the *thread's* current state, which can
      // race a concurrent request on the same thread_id. Requesting 'values'
      // alongside 'custom' on this same stream() call instead yields this
      // invocation's own state after each superstep as `['values', payload]`
      // tuples, scoped to only this call.
      const stream = await agent.stream(
        { messages: [userMessage] },
        { configurable: { thread_id: threadId }, streamMode: ['custom', 'values'] },
      );

      let lastValuesPayload: { messages?: BaseMessage[]; turnUsage?: TurnUsageWithModel } | undefined;

      for await (const [mode, payload] of stream as AsyncIterable<[string, unknown]>) {
        if (clientDisconnected) break; // triggers the loop's own iterator.return()

        if (mode === 'custom') {
          // Only forward chunks that actually match the progress wire
          // contract — defensive against any other custom-stream writer that
          // might ever be added — never a raw/unvalidated passthrough.
          const parsed = progressEventSchema.safeParse(payload);
          if (parsed.success) {
            safeWrite(`event: progress\ndata: ${JSON.stringify(parsed.data)}\n\n`);
          }
        } else if (mode === 'values') {
          lastValuesPayload = payload as { messages?: BaseMessage[]; turnUsage?: TurnUsageWithModel };
        }
      }

      // AC4: the final answer is only released after `afterModel` moderation
      // has resolved — `lastValuesPayload` is this invocation's own final
      // state (the last superstep the stream emitted before completing), not
      // a separate thread-wide read, so no concurrent request can race it.
      const messages = lastValuesPayload?.messages ?? [];
      const lastMessage = messages[messages.length - 1];
      let reply = lastMessage ? toChatMessage(lastMessage) : undefined;

      if (!reply) {
        // The agent resolved without throwing but produced nothing usable
        // (no messages, or a last message with no renderable text/type) —
        // log it the same way the catch branch below logs a thrown failure,
        // so this fallback path isn't silent (thread id + count only).
        console.error('[chat] agent produced no usable reply:', { threadId, messageCount: messages.length });
      }

      // Story 5.2 (AD-21): persist + attach this turn's cost — only when a
      // reply actually exists and the turn produced at least one AI message
      // with a resolved model id (a moderation short-circuit has neither).
      // Never blocks delivery of the reply itself on this: a persistence
      // failure here is logged and swallowed, same "the turn's own result
      // is never gated on this" treatment the feedback routes below get.
      const turnUsage = lastValuesPayload?.turnUsage;
      if (reply && turnUsage?.modelId) {
        try {
          const settings = await getUserSettings(db, req.session.userId!);
          const currency = (settings?.currency as CurrencyCode | undefined) ?? DEFAULT_CURRENCY;
          const cost = computeMessageCost({ inputTokens: turnUsage.inputTokens, outputTokens: turnUsage.outputTokens }, turnUsage.modelId, currency);

          await saveMessageCost(db, {
            messageId: reply.id,
            threadId,
            userId: req.session.userId!,
            modelId: cost.modelId,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            amountMinorUnitsUsd: cost.amountMinorUnitsUsd,
            pricePerMillionInputTokens: cost.pricePerMillionInputTokens,
            pricePerMillionOutputTokens: cost.pricePerMillionOutputTokens,
            priceAsOf: cost.priceAsOf,
          });

          reply = { ...reply, cost: toMessageCostDisplay(cost) };
        } catch (error) {
          console.error('[chat] cost persistence failed:', { threadId, error: (error as Error)?.message });
        }
      }

      writeResultEvent(
        reply ??
          chatMessageSchema.parse({
            id: randomUUID(),
            role: 'assistant',
            kind: 'error',
            content: modelFailureMessage,
            createdAt: new Date().toISOString(),
          }),
      );
    } catch (error) {
      // Boundary: "No log destination ... ever contains raw user message
      // text" — only the thread id is logged, never `parseResult.data.content`.
      console.error('[chat] agent invocation failed:', { threadId, error: (error as Error)?.message });

      // I/O matrix: "Model call exhausts retries" -> "stream ends with
      // `result` (kind 'error', fixed EN/DE fallback) ... stream still ends
      // cleanly (no crash)". Written as the terminal SSE event, not a JSON
      // body — the stream is already open by the time any failure can occur
      // here.
      writeResultEvent(
        chatMessageSchema.parse({
          id: randomUUID(),
          role: 'assistant',
          kind: 'error',
          content: modelFailureMessage,
          createdAt: new Date().toISOString(),
        }),
      );
    }
  });

  router.get('/messages', async (req, res) => {
    const threadId = buildDiscoveryThreadId(req.session.userId!);

    try {
      const state = await agent.getState({ configurable: { thread_id: threadId } });
      const messages = (state.values.messages ?? []) as BaseMessage[];
      const mapped = messages.map(toChatMessage);
      const history = mapped.filter((message): message is ChatMessage => message !== undefined);
      const skipped = mapped.length - history.length;

      if (skipped > 0) {
        // A checkpointed message `toChatMessage` couldn't render (wrong
        // type, or no text) is silently dropped from history below — log
        // that it happened (count only, never which message or its content).
        console.warn('[chat] history read skipped unusable message(s):', { threadId, skipped });
      }

      // Story 5.2 (AD-27 "Reload" row): re-converts each persisted cost row
      // to the user's *current* currency on every read — never the currency
      // that happened to be active when the turn was first answered.
      try {
        // Review fix: neither read depends on the other's result — issuing
        // them in parallel instead of sequentially halves this hot read
        // path's round-trip count.
        const [settings, costs] = await Promise.all([
          getUserSettings(db, req.session.userId!),
          getMessageCosts(
            db,
            history.map((message) => message.id),
          ),
        ]);
        const currency = (settings?.currency as CurrencyCode | undefined) ?? DEFAULT_CURRENCY;
        for (const message of history) {
          const row = costs.get(message.id);
          if (row) message.cost = convertStoredCost(row, currency);
        }
      } catch (error) {
        console.error('[chat] cost attach failed:', { threadId, error: (error as Error)?.message });
      }

      res.json(chatHistoryResponseSchema.parse({ messages: history }));
    } catch (error) {
      console.error('[chat] history read failed:', { threadId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  // Story 5.3 (AD-4/AD-22): the discovery thread is already scoped to
  // `req.session.userId` the same way the message routes above are — the
  // caller can only ever act on their own thread. `setFeedback` itself still
  // checks that a client-supplied `messageId` doesn't already have feedback
  // owned by a different user (review fix: `FeedbackOwnershipError` -> 404,
  // same precedent as `set_idea_status.ts`'s `IdeaNotFoundError`).
  router.post('/messages/:messageId/feedback', async (req, res) => {
    const userId = req.session.userId!;
    const messageId = req.params.messageId;
    const parseResult = recordFeedbackRequestSchema.safeParse(req.body);
    if (!messageId || !parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    const threadId = buildDiscoveryThreadId(userId);
    try {
      const feedback = await setFeedback(db, env, {
        messageId,
        threadId,
        userId,
        rating: parseResult.data.rating,
        comment: parseResult.data.comment,
      });
      res.json({ feedback });
    } catch (error) {
      if (error instanceof FeedbackOwnershipError) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      console.error('[chat] feedback write failed:', { threadId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  router.delete('/messages/:messageId/feedback', async (req, res) => {
    const userId = req.session.userId!;
    const messageId = req.params.messageId;
    if (!messageId) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    try {
      await removeFeedback(db, messageId, userId);
      res.status(204).end();
    } catch (error) {
      console.error('[chat] feedback removal failed:', { error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  return router;
}
