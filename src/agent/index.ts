import { createAgent, dynamicSystemPromptMiddleware } from 'langchain';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { RetryPolicy } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { createChatModel } from './model.js';
import { createModerationMiddleware, type ClassifyText } from './moderation.js';
import { applyModelNodeResilience, MODEL_NODE_TIMEOUT_MS } from './resilience.js';
import { createSubmitIntakeTool } from '../tools/plain/submit_intake.js';
import { createGenerateIdeasTool } from '../tools/llm/generate_ideas.js';

/**
 * AD-20 (deferred): the fixed personality tones a `user_settings.personality`
 * row will eventually select between. Only `'friendly'` is reachable until
 * Story 5.1 adds the `set_personality` tool/UI — same hardcoded-default
 * pattern Story 1.3 used for the model (Design Notes).
 */
export const PERSONALITY_PROMPTS = {
  formal: 'Keep a formal, professional tone — no slang, no exclamation points.',
  friendly: 'Keep a warm, encouraging, friendly tone, like a supportive coach.',
  terse: 'Keep replies short and to the point — no filler, no pleasantries.',
} as const;

export type Personality = keyof typeof PERSONALITY_PROMPTS;

/** Design Notes: "Personality default" — hardcoded until Story 5.1 wires the
 * real `user_settings.personality` value through. */
export const DEFAULT_PERSONALITY: Personality = 'friendly';

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
export function buildSystemPrompt(): string {
  return `${PERSONALITY_PROMPTS[DEFAULT_PERSONALITY]} ${REPLY_LANGUAGE_INSTRUCTION}`;
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

export interface CreateCoachAgentDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  checkpointer: BaseCheckpointSaver;
  /** Test-only seam: a fake chat model instead of a real `ChatOpenAI`. */
  model?: BaseChatModel;
  /** Test-only seam: a fake moderation classifier instead of a real Mistral call. */
  classify?: ClassifyText;
  /** The shared db handle `submit_intake` persists through — `api/index.ts`
   * already builds one `createDb(env)` pool for `AppDeps`; this reuses that
   * same instance rather than opening a second pool. */
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
}: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env);
  const moderation = createModerationMiddleware(env, { classify });
  const systemPrompt = dynamicSystemPromptMiddleware(buildSystemPrompt);

  const reactAgent = createAgent({
    model: chatModel,
    middleware: [moderation, systemPrompt],
    tools: [createSubmitIntakeTool(db), createGenerateIdeasTool(db, chatModel, webSearchTool, env)],
  });

  const graph = new StateGraph(MessagesAnnotation).addNode('model', async (state, runtime) => {
    // `runtime` (a `LangGraphRunnableConfig`, which extends `RunnableConfig`)
    // carries `configurable` (incl. `thread_id`) alongside the callback/
    // tracing fields `reactAgent.invoke` expects; forwarding it as-is keeps
    // the inner agent's LangSmith run nested under this node's run instead of
    // starting a disconnected one.
    const result = await reactAgent.invoke({ messages: state.messages }, runtime);
    return { messages: result.messages };
  });

  graph.addEdge(START, 'model').addEdge('model', END);

  return applyModelNodeResilience(graph, modelNodeTimeoutMs, modelNodeRetryPolicy).compile({ checkpointer });
}

export type CoachAgent = ReturnType<typeof createCoachAgent>;
