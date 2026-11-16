import { z } from 'zod';
import { createAgent, dynamicSystemPromptMiddleware } from 'langchain';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { getUserSettings } from '../db/settings-repository.js';
import { createChatModel, createModelSelectionMiddleware } from './model.js';
import { DEFAULT_MODEL_ID } from './registry.js';
import { DEFAULT_PERSONALITY, PERSONALITY_PROMPTS, resolvePersonality, type Personality } from './personality.js';
import { createModerationMiddleware, type ClassifyText } from './moderation.js';
import { applyModelNodeResilience } from './resilience.js';

// Story 5.1 moved these to `./personality.js` (now backed by the shared
// `personalitySchema` enum, AD-16) — re-exported so existing importers of
// `./index.js` don't need to change their import path.
export { PERSONALITY_PROMPTS, DEFAULT_PERSONALITY, type Personality };

/**
 * AD-25: "personality × language is handled as one prompt-construction step,
 * not as separate per-language personality definitions". This instruction is
 * deliberately language-agnostic text (not computed per message) — the model
 * itself matches the user's most recent message's language (AC3), re-
 * evaluating it on every turn since this function runs before every model
 * call via `dynamicSystemPromptMiddleware` below, not just once per thread.
 */
const REPLY_LANGUAGE_INSTRUCTION =
  "Always reply in the same language the user's most recent message is written in — German or English — " +
  'regardless of any other setting. Re-decide this for every reply; do not stick to a language from earlier in ' +
  'the conversation if the user has since switched.';

/**
 * Code Map: "add a `prompt: (state) => [SystemMessage]` option to the
 * `createAgent(...)` call". The installed `langchain@1.6.5`'s `createAgent`
 * only accepts a *static* `systemPrompt: string | SystemMessage` — there is
 * no per-turn `prompt` callback field on `CreateAgentParams`. The equivalent,
 * still-inside-`createAgent`-construction mechanism this version exposes is
 * `dynamicSystemPromptMiddleware`, added to the same `middleware` array the
 * moderation middleware already lives in (AD-25: "a prompt-construction
 * concern ... not a routing concern" — this keeps it there, not in
 * `api/routes/chat.ts`). `buildSystemPrompt` is exported standalone so its
 * output can be asserted directly in a unit test without constructing a
 * LangGraph runtime.
 */
export function buildSystemPrompt(personality: Personality = DEFAULT_PERSONALITY): string {
  return `${PERSONALITY_PROMPTS[personality]} ${REPLY_LANGUAGE_INSTRUCTION}`;
}

/**
 * Design Notes: "Thread id shape: `discovery:${userId}`, not bare `userId` —
 * reserves the `plan:${planId}` naming Epic 3 introduces per AD-18."
 */
export function buildDiscoveryThreadId(userId: string): string {
  return `discovery:${userId}`;
}

const DISCOVERY_THREAD_PREFIX = 'discovery:';

/** Inverse of `buildDiscoveryThreadId` — Story 5.1 needs the `userId` back
 * out of `runtime.configurable.thread_id` to look up `user_settings` per
 * turn, without `src/api/routes/chat.ts` (which builds that thread id)
 * having to pass it through separately. */
export function extractUserIdFromThreadId(threadId: string | undefined): string | undefined {
  if (!threadId?.startsWith(DISCOVERY_THREAD_PREFIX)) return undefined;
  const userId = threadId.slice(DISCOVERY_THREAD_PREFIX.length);
  return userId.length > 0 ? userId : undefined;
}

/** The per-turn values the outer node resolves from `user_settings` and
 * hands to the inner `createAgent` as middleware context (AD-20: personality
 * for `buildSystemPrompt`, `modelId` for `createModelSelectionMiddleware`). */
const agentContextSchema = z.object({
  personality: z.string().optional(),
  modelId: z.string().optional(),
});

export interface CreateCoachAgentDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  checkpointer: BaseCheckpointSaver;
  /** Story 5.1: reads `user_settings` per turn (AD-20). Optional — a test
   * that injects its own fake `model` below has no per-user model to select
   * between and doesn't need it. */
  db?: ReturnType<typeof createDb>['db'];
  /** Test-only seam: a fake chat model instead of a real `ChatOpenAI`. */
  model?: BaseChatModel;
  /** Test-only seam: a fake moderation classifier instead of a real Mistral call. */
  classify?: ClassifyText;
}

/**
 * Wires the model, Mistral-moderation middleware, and node-level resilience
 * into one compiled, Postgres-checkpointed LangGraph graph (Code Map:
 * "`createCoachAgent()` wiring all of it into one compiled graph").
 *
 * The actual ReAct loop is `createAgent` itself (AC: "processed by a
 * `createAgent` instance on the LangGraph.js runtime"). It's nested here as
 * this graph's single `"model"` node — `createAgent` compiles its own graph
 * internally with no seam to call `setNodeDefaults` on before that happens,
 * so the one retry/timeout policy for the model call (AD-7) is applied at
 * this outer level instead, around the whole (currently tool-less) agent
 * turn. The Postgres checkpoint lives on this outer graph only; the inner
 * `createAgent` instance is stateless and re-invoked with the full message
 * history on every turn.
 */
export function createCoachAgent({ env, checkpointer, db, model, classify }: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env, DEFAULT_MODEL_ID);
  const moderation = createModerationMiddleware(env, { classify });
  const systemPrompt = dynamicSystemPromptMiddleware<{ personality?: string }>((_state, runtime) =>
    buildSystemPrompt(resolvePersonality(runtime.context?.personality)),
  );

  // Story 5.1 (AD-20): per-turn model swapping only applies to the real,
  // registry-backed model. A test that injects its own fake `model` (the
  // seam above) wants that exact instance invoked on every turn, never
  // swapped out underneath it by the registry-driven middleware below.
  const middleware = model ? [moderation, systemPrompt] : [moderation, systemPrompt, createModelSelectionMiddleware({ env })];

  const reactAgent = createAgent({
    model: chatModel,
    middleware,
    contextSchema: agentContextSchema,
  });

  const graph = new StateGraph(MessagesAnnotation).addNode('model', async (state, runtime) => {
    // Story 5.1 (AD-20): resolve this turn's personality/model from
    // `user_settings`, keyed by the `userId` embedded in the thread id — no
    // settings lookup (and defaults throughout) when `db` wasn't supplied.
    const userId = extractUserIdFromThreadId(runtime.configurable?.thread_id as string | undefined);
    const settings = db && userId ? await getUserSettings(db, userId) : undefined;

    // `runtime` (a `LangGraphRunnableConfig`, which extends `RunnableConfig`)
    // carries `configurable` (incl. `thread_id`) alongside the callback/
    // tracing fields `reactAgent.invoke` expects; forwarding it as-is keeps
    // the inner agent's LangSmith run nested under this node's run instead of
    // starting a disconnected one. `context` is added on top for the two
    // middlewares above to read.
    const result = await reactAgent.invoke(
      { messages: state.messages },
      { ...runtime, context: { personality: settings?.personality, modelId: settings?.model ?? undefined } },
    );
    return { messages: result.messages };
  });

  graph.addEdge(START, 'model').addEdge('model', END);

  return applyModelNodeResilience(graph).compile({ checkpointer });
}

export type CoachAgent = ReturnType<typeof createCoachAgent>;
