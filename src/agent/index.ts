import { createAgent, dynamicSystemPromptMiddleware } from 'langchain';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { createChatModel } from './model.js';
import { createModerationMiddleware, type ClassifyText } from './moderation.js';
import { applyModelNodeResilience } from './resilience.js';
import { createSubmitIntakeTool } from '../tools/plain/submit_intake.js';

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
export function createCoachAgent({ env, checkpointer, model, classify, db }: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env);
  const moderation = createModerationMiddleware(env, { classify });
  const systemPrompt = dynamicSystemPromptMiddleware(buildSystemPrompt);

  const reactAgent = createAgent({
    model: chatModel,
    middleware: [moderation, systemPrompt],
    tools: [createSubmitIntakeTool(db)],
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

  return applyModelNodeResilience(graph).compile({ checkpointer });
}

export type CoachAgent = ReturnType<typeof createCoachAgent>;
