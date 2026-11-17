import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  chatHistoryResponseSchema,
  chatMessageSchema,
  progressEventSchema,
  resultEventSchema,
  sendMessageRequestSchema,
  type ChatMessage,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildPlanThreadId } from '../../agent/index.js';
import { classifyAssistantMessageKind } from '../../agent/moderation.js';
import { MODEL_FAILURE_MESSAGE, MODEL_FAILURE_MESSAGE_DE } from '../../agent/resilience.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';
import { plans } from '../../db/schema/index.js';

export interface PlanChatRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS'>;
  db: ReturnType<typeof createDb>['db'];
  /** The plans-only compiled agent (`plansAgent`) — so a free-form
   * follow-up in the plan thread can still call `get_current_step`. */
  agent: CoachAgent;
}

type Db = PlanChatRouterDeps['db'];

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
    createdAt: new Date().toISOString(),
  });
}

/**
 * AC: "an existing plan thread ... a free-form follow-up question ... the
 * agent answers it in context within that same plan thread". Checked
 * against `plans.userId` (Code Map) before any read/write against that
 * thread — a plan id that exists but belongs to another user, or doesn't
 * exist at all, is a 404 either way (never distinguished, same precedent as
 * `set_idea_status.ts`'s `IdeaNotFoundError` handling).
 */
async function assertPlanOwnership(db: Db, userId: string, planId: string): Promise<boolean> {
  const [plan] = await db.select({ userId: plans.userId }).from(plans).where(eq(plans.id, planId)).limit(1);
  return plan?.userId === userId;
}

/**
 * `createPlanChatRouter`: mirrors `chat.ts`'s SSE pattern exactly (Code
 * Map) — the only difference is the thread id it resolves (`plan:${planId}`
 * instead of `discovery:${userId}`) and the ownership check that gates it.
 */
export function createPlanChatRouter({ env, db, agent }: PlanChatRouterDeps) {
  const router = Router();
  const strictLimiter = createStrictRateLimiter(env);

  router.post('/:planId/messages', strictLimiter, async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const parseResult = sendMessageRequestSchema.safeParse(req.body);
    if (!planIdParse.success || !parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    // Review fix: a thrown error here (e.g. a transient DB failure) must
    // surface as a logged 503, same vocabulary as every other route's own
    // try/catch-to-503 pattern for a DB read — not be swallowed into an
    // un-logged 404 that looks identical to a genuine "not found/not
    // owned" result.
    let owned: boolean;
    try {
      owned = await assertPlanOwnership(db, userId, planId);
    } catch (error) {
      console.error('[plan-chat] ownership check failed:', { planId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
      return;
    }
    if (!owned) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    const threadId = buildPlanThreadId(planId);
    const userMessage = new HumanMessage(parseResult.data.content);
    const modelFailureMessage =
      detectReplyLanguage(parseResult.data.content) === 'de' ? MODEL_FAILURE_MESSAGE_DE : MODEL_FAILURE_MESSAGE;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    function safeWrite(chunk: string): void {
      if (res.writableEnded) return;
      try {
        res.write(chunk);
      } catch (error) {
        console.warn('[plan-chat] SSE write failed (client likely disconnected):', { threadId, error: (error as Error)?.message });
      }
    }

    function writeResultEvent(message: ChatMessage): void {
      try {
        const event = resultEventSchema.parse({ type: 'result', message });
        safeWrite(`event: result\ndata: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        console.error('[plan-chat] failed to build/write the terminal result event:', { threadId, error: (error as Error)?.message });
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Already-closed connection — nothing left to do.
        }
      }
    }

    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    try {
      const stream = await agent.stream(
        { messages: [userMessage] },
        { configurable: { thread_id: threadId }, streamMode: ['custom', 'values'] },
      );

      let lastValuesMessages: BaseMessage[] | undefined;

      for await (const [mode, payload] of stream as AsyncIterable<[string, unknown]>) {
        if (clientDisconnected) break;

        if (mode === 'custom') {
          const parsed = progressEventSchema.safeParse(payload);
          if (parsed.success) {
            safeWrite(`event: progress\ndata: ${JSON.stringify(parsed.data)}\n\n`);
          }
        } else if (mode === 'values') {
          lastValuesMessages = (payload as { messages?: BaseMessage[] })?.messages;
        }
      }

      const messages = lastValuesMessages ?? [];
      const lastMessage = messages[messages.length - 1];
      const reply = lastMessage ? toChatMessage(lastMessage) : undefined;

      if (!reply) {
        console.error('[plan-chat] agent produced no usable reply:', { threadId, messageCount: messages.length });
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
      console.error('[plan-chat] agent invocation failed:', { threadId, error: (error as Error)?.message });

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

  router.get('/:planId/messages', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    // Same distinction as the POST handler above: a thrown error is a
    // logged 503, never collapsed into a 404.
    let owned: boolean;
    try {
      owned = await assertPlanOwnership(db, userId, planId);
    } catch (error) {
      console.error('[plan-chat] ownership check failed:', { planId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
      return;
    }
    if (!owned) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    const threadId = buildPlanThreadId(planId);

    try {
      const state = await agent.getState({ configurable: { thread_id: threadId } });
      const messages = (state.values.messages ?? []) as BaseMessage[];
      const mapped = messages.map(toChatMessage);
      const history = mapped.filter((message): message is ChatMessage => message !== undefined);
      const skipped = mapped.length - history.length;

      if (skipped > 0) {
        console.warn('[plan-chat] history read skipped unusable message(s):', { threadId, skipped });
      }

      res.json(chatHistoryResponseSchema.parse({ messages: history }));
    } catch (error) {
      console.error('[plan-chat] history read failed:', { threadId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  return router;
}
