import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  chatHistoryResponseSchema,
  chatMessageSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  type ChatMessage,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildDiscoveryThreadId } from '../../agent/index.js';
import { classifyAssistantMessageKind } from '../../agent/moderation.js';
import { MODEL_FAILURE_MESSAGE } from '../../agent/resilience.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';

export interface ChatRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS'>;
  agent: CoachAgent;
}

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
export function createChatRouter({ env, agent }: ChatRouterDeps) {
  const router = Router();
  // Intent: "`POST /api/chat/messages` uses `createStrictRateLimiter`" — the
  // first LLM-backed, cost-bearing route to consume the stricter tier
  // (Design Notes).
  const strictLimiter = createStrictRateLimiter(env);

  router.post('/messages', strictLimiter, async (req, res) => {
    const parseResult = sendMessageRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      // I/O matrix: "Over-length message" -> "Rejected at the schema
      // boundary (4xx)" / "Never silently truncated".
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    const threadId = buildDiscoveryThreadId(req.session.userId!);
    const userMessage = new HumanMessage(parseResult.data.content);

    try {
      const result = await agent.invoke({ messages: [userMessage] }, { configurable: { thread_id: threadId } });
      const lastMessage = result.messages[result.messages.length - 1];
      const reply = lastMessage ? toChatMessage(lastMessage) : undefined;

      if (!reply) {
        // The agent resolved without throwing but produced nothing usable
        // (no messages, or a last message with no renderable text/type) —
        // log it the same way the catch branch below logs a thrown failure,
        // so this fallback path isn't silent (thread id + count only).
        console.error('[chat] agent produced no usable reply:', { threadId, messageCount: result.messages.length });
      }

      res.json(
        sendMessageResponseSchema.parse({
          message:
            reply ??
            chatMessageSchema.parse({
              id: randomUUID(),
              role: 'assistant',
              kind: 'error',
              content: MODEL_FAILURE_MESSAGE,
              createdAt: new Date().toISOString(),
            }),
        }),
      );
    } catch (error) {
      // Boundary: "No log destination ... ever contains raw user message
      // text" — only the thread id is logged, never `parseResult.data.content`.
      console.error('[chat] agent invocation failed:', { threadId, error: (error as Error)?.message });

      // I/O matrix: "Model call exhausts retries" -> "User sees the fixed
      // generic error message" / "App keeps running, no crash". Returned as
      // a normal, schema-conformant reply (not a 5xx) so the frontend renders
      // it the same way as any other reply, just with `kind: 'error'`.
      res.json(
        sendMessageResponseSchema.parse({
          message: chatMessageSchema.parse({
            id: randomUUID(),
            role: 'assistant',
            kind: 'error',
            content: MODEL_FAILURE_MESSAGE,
            createdAt: new Date().toISOString(),
          }),
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

      res.json(chatHistoryResponseSchema.parse({ messages: history }));
    } catch (error) {
      console.error('[chat] history read failed:', { threadId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  return router;
}
