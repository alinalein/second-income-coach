import { createAgent } from 'langchain';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Env } from '../config/env.js';
import { createChatModel } from './model.js';
import { createModerationMiddleware, type ClassifyText } from './moderation.js';
import { applyModelNodeResilience } from './resilience.js';

/**
 * Design Notes: "Thread id shape: `discovery:${userId}`, not bare `userId` —
 * reserves the `plan:${planId}` naming Epic 3 introduces per AD-18."
 */
export function buildDiscoveryThreadId(userId: string): string {
  return `discovery:${userId}`;
}

export interface CreateCoachAgentDeps {
  env: Pick<Env, 'OPENAI_API_KEY' | 'MISTRAL_API_KEY'>;
  checkpointer: BaseCheckpointSaver;
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
export function createCoachAgent({ env, checkpointer, model, classify }: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env);
  const moderation = createModerationMiddleware(env, { classify });

  const reactAgent = createAgent({
    model: chatModel,
    middleware: [moderation],
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
