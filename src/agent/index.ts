import { z } from 'zod';
import { createAgent, dynamicSystemPromptMiddleware } from 'langchain';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { RetryPolicy } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { getUserSettings } from '../db/settings-repository.js';
import { createChatModel, createModelSelectionMiddleware } from './model.js';
import { DEFAULT_MODEL_ID } from './registry.js';
import { DEFAULT_PERSONALITY, PERSONALITY_PROMPTS, resolvePersonality, type Personality } from './personality.js';
import { createModerationMiddleware, type ClassifyText } from './moderation.js';
import { createProgressMiddleware } from './progress.js';
import { createForceToolChoiceMiddleware } from './toolChoice.js';
import { applyModelNodeResilience, MODEL_NODE_TIMEOUT_MS } from './resilience.js';
import { createSubmitIntakeTool } from '../tools/plain/submit_intake.js';
import { createGenerateIdeasTool } from '../tools/llm/generate_ideas.js';

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

/**
 * Story 2.2 follow-up fix 4: a third, internal-only thread kind — not one
 * of AD-18's two user-visible kinds (discovery/plan). `src/api/routes/
 * ideas.ts`'s `POST /generate` invokes the agent here instead of on the
 * discovery thread, so its auto-generated trigger message (and the
 * resulting reply) is never checkpointed into, and so never rendered from,
 * the thread `GET /api/chat/messages` reads. Still `${kind}:${userId}` —
 * `generate_ideas`'s `deriveUserIdFromThreadId` derives the user id the
 * same way regardless of which kind prefixes it.
 */
export function buildIdeasTriggerThreadId(userId: string): string {
  return `ideas-trigger:${userId}`;
}

/**
 * Story 2.2 follow-up fix round 3, fix 1: the same internal-only pattern as
 * `buildIdeasTriggerThreadId`, for `src/api/routes/intake.ts`'s own
 * auto-generated "Call the submit_intake tool..." trigger — it had the
 * identical bug (persisted into, and rendered from, the discovery thread
 * `GET /api/chat/messages` reads) from Story 2.1 onward, just not caught
 * until live testing surfaced it alongside the ideas one.
 */
export function buildIntakeTriggerThreadId(userId: string): string {
  return `intake-trigger:${userId}`;
}

/**
 * Story 3.1 (AD-18): "exactly one plan thread per plan, created when that
 * plan's draft is first generated". Reserved shape (Design Notes in
 * `buildDiscoveryThreadId`'s own comment above) — never the discovery
 * thread, never shared across plans. `src/api/routes/plans.ts` mints a
 * `planId` and builds this thread id *before* `create_plan` has written any
 * row, so the id itself can't come from a DB lookup.
 */
export function buildPlanThreadId(planId: string): string {
  return `plan:${planId}`;
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
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY' | 'IDEAS_PER_BATCH'>;
  checkpointer: BaseCheckpointSaver;
  /** Test-only seam: a fake chat model instead of a real `ChatOpenAI`. */
  model?: BaseChatModel;
  /** Test-only seam: a fake moderation classifier instead of a real Mistral call. */
  classify?: ClassifyText;
  /** The shared db handle: `submit_intake` persists through it and (Story 5.1,
   * AD-20) each turn reads `user_settings` from it — `api/index.ts` already
   * builds one `createDb(env)` pool for `AppDeps`; this reuses that same
   * instance rather than opening a second pool. */
  db: ReturnType<typeof createDb>['db'];
  /** Story 2.2 (AD-5): the one MCP tool (`web_search`), constructed async
   * in `src/api/index.ts` via `MCPAdapter.listTools()` before
   * `createCoachAgent(...)` is called. Boundary: never added to this
   * agent's own `tools: [...]` below — passed through only as a dependency
   * into `generate_ideas`'s factory, which binds it to its own nested,
   * uncheckpointed `createAgent` instance. */
  webSearchTool: DynamicStructuredTool;
  /** Story 2.2 follow-up fix 1 (AD-7): overrides the outer `'model'` node's
   * timeout — defaults to the standard chat/intake budget. `src/api/
   * index.ts` builds a second `createCoachAgent(...)` instance with
   * `IDEAS_MODEL_NODE_TIMEOUT_MS` here, used only by the ideas route; chat
   * and `submit_intake` keep using the default-timeout instance. */
  modelNodeTimeoutMs?: number;
  /** Story 2.2 round 9, fix (a): overrides the outer `'model'` node's retry
   * policy — defaults to the standard 3-attempt policy. `src/api/index.ts`
   * passes `IDEAS_MODEL_NODE_RETRY_POLICY` (no retry) for the same ideas-
   * only agent instance above, so a timeout there fails the turn instead of
   * re-running the whole thing (including every search) from scratch. */
  modelNodeRetryPolicy?: RetryPolicy;
  /** Story 6.2 (AD-23): test-only seam for the trajectory eval harness
   * (`src/evals/harness.ts`) — overrides the hardcoded `tools: [...]` array
   * below wholesale. Lets an eval case swap in a schema-identical, instant
   * fake `generate_ideas` (its real factory makes its own nested real-model
   * call, which would compound per-model eval cost) while still reusing the
   * real `submit_intake` tool unmodified. Omitted in production — defaults
   * to today's exact two-tool wiring, so this is purely additive. */
  tools?: DynamicStructuredTool[];
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
 * this outer level instead, around the whole agent turn. The Postgres
 * checkpoint lives on this outer graph only; the inner
 * `createAgent` instance is stateless and re-invoked with the full message
 * history on every turn.
 */
export function createCoachAgent({
  env,
  checkpointer,
  model,
  classify,
  db,
  webSearchTool,
  modelNodeTimeoutMs = MODEL_NODE_TIMEOUT_MS,
  modelNodeRetryPolicy,
  tools,
}: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env, DEFAULT_MODEL_ID);
  const progress = createProgressMiddleware();
  const moderation = createModerationMiddleware(env, { classify });
  const systemPrompt = dynamicSystemPromptMiddleware<{ personality?: string }>((_state, runtime) =>
    buildSystemPrompt(resolvePersonality(runtime.context?.personality)),
  );
  const forceToolChoice = createForceToolChoiceMiddleware();

  // Story 5.1 (AD-20): per-turn model swapping only applies to the real,
  // registry-backed model. A test that injects its own fake `model` (the
  // seam above) wants that exact instance invoked on every turn, never
  // swapped out underneath it by the registry-driven middleware below.
  const middleware = model
    ? [progress, moderation, systemPrompt, forceToolChoice]
    : [progress, moderation, systemPrompt, forceToolChoice, createModelSelectionMiddleware({ env })];

  // Story 1.5 Design Notes: `progress` goes first so its `beforeModel` always
  // fires, even when `moderation`'s own `beforeModel` jumps straight to
  // `end` on a jailbreak reject.
  const reactAgent = createAgent({
    model: chatModel,
    middleware,
    contextSchema: agentContextSchema,
    tools: tools ?? [createSubmitIntakeTool(db), createGenerateIdeasTool(db, chatModel, webSearchTool, env)],
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

  return applyModelNodeResilience(graph, modelNodeTimeoutMs, modelNodeRetryPolicy).compile({ checkpointer });
}

export type CoachAgent = ReturnType<typeof createCoachAgent>;
