import { tool } from 'langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { generateIdeasToolSchema } from '@app/shared';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { createCoachAgent } from '../agent/index.js';
import { createChatModel } from '../agent/model.js';
import { createSubmitIntakeTool } from '../tools/plain/submit_intake.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Design Notes: "Why stub `generate_ideas` but not `submit_intake`" — same
 * `name`/`schema` as the real tool (`generateIdeasToolSchema`), so the model
 * under test still must produce the right tool name and `replyLanguage` arg
 * to pass `toolArgsMatchMode`; only the tool's own *execution* (the real
 * factory's nested real-model call + retries + web search) is faked, never
 * what's being measured.
 */
function createFakeGenerateIdeasTool(): DynamicStructuredTool {
  return tool(
    async () => JSON.stringify({ ideas: [] }),
    {
      name: 'generate_ideas',
      description:
        'Call this when a user who has already completed intake asks for income ideas (or for their 5 ideas ' +
        'again). Supply replyLanguage from your own judgment of the conversation\'s language ("en" or "de").',
      schema: generateIdeasToolSchema,
    },
  );
}

/**
 * In-memory stand-in for the Postgres `db` handle — just enough of the
 * Drizzle chain shape for the two things the outer graph node and
 * `submit_intake` actually call during an eval turn: `getUserSettings`'s
 * `select().from().where().limit()` (always "no row", so personality/model
 * defaults apply — eval cases don't exercise Story 5.1 settings) and
 * `submit_intake`'s `insert().values().onConflictDoUpdate().returning()`.
 * Captures every write so a case can inspect what was actually persisted,
 * without a real database (Code Map: "stub `db` (in-memory, captures
 * writes)").
 */
export function createStubDb(): { db: Db; writes: Record<string, unknown>[] } {
  const writes: Record<string, unknown>[] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const now = new Date();
            const row = { id: `eval-${writes.length}`, createdAt: now, updatedAt: now, ...values };
            writes.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
  } as unknown as Db;

  return { db, writes };
}

/**
 * Story 6.2 Design Notes: "the `tools` seam on `createCoachAgent` instead of
 * a parallel harness-only agent builder" — this wires the exact same
 * production graph (moderation, progress, resilience, per-turn system
 * prompt) a real chat turn runs through, with only the three documented
 * eval-only swaps: a real model (never a fake), a pass-through `classify`
 * (so moderation never flags an eval fixture and clouds the tool-calling
 * signal), and the `tools` override described above.
 */
export interface EvalAgent {
  agent: ReturnType<typeof createCoachAgent>;
  writes: Record<string, unknown>[];
  /** Captures the root LangSmith run id for the turn just invoked — see
   * `captureRootRunId`'s doc comment. */
  getLastRunId: () => string | undefined;
  /** Passed to `agent.invoke(..., { callbacks: [handler] })` by
   * `runFixtureTurn` — not meant to be called directly by eval cases. */
  handler: BaseCallbackHandler;
}

/**
 * One callback handler, shared by every case run against this agent, that
 * records the outermost `handleChainStart` run id per `agent.invoke()` call
 * — a plain diagnostic callback handler, not new tracing
 * machinery (LangSmith tracing itself is still just the existing
 * `LANGSMITH_*` env vars LangChain's own integration already reads).
 */
function captureRootRunId(): { handler: BaseCallbackHandler; getLastRunId: () => string | undefined } {
  let lastRunId: string | undefined;
  let sawRootThisInvoke = false;

  const handler = BaseCallbackHandler.fromMethods({
    // Param order per `@langchain/core`'s `CallbackHandlerMethods`:
    // (chain, inputs, runId, runType, tags, metadata, runName, parentRunId).
    handleChainStart(_chain, _inputs, runId, _runType, _tags, _metadata, _runName, parentRunId) {
      if (parentRunId === undefined && !sawRootThisInvoke) {
        lastRunId = runId;
        sawRootThisInvoke = true;
      }
    },
  });

  return {
    handler,
    getLastRunId: () => {
      sawRootThisInvoke = false;
      return lastRunId;
    },
  };
}

/**
 * Builds one `createCoachAgent` instance for a single model id under test —
 * a fresh in-memory checkpointer and stub `db` per instance, so each model's
 * run of the fixture suite starts from a clean slate with no cross-model or
 * cross-case state leakage.
 */
export function buildEvalAgent(modelId: string, env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY' | 'IDEAS_PER_BATCH' | 'DAILY_SEARCH_BUDGET'>): EvalAgent {
  const model = createChatModel(env, modelId);
  const { db, writes } = createStubDb();
  const { handler, getLastRunId } = captureRootRunId();

  const agent = createCoachAgent({
    env,
    checkpointer: new MemorySaver(),
    model,
    // Pass-through: an eval fixture is never a real jailbreak/unsafe-output
    // case, and moderation flagging one would mask the tool-calling signal
    // this suite actually measures.
    classify: async () => ({}),
    db,
    webSearchTool: {} as never,
    tools: [createSubmitIntakeTool(db), createFakeGenerateIdeasTool()],
  });

  return { agent, writes, getLastRunId, handler };
}

/** Runs one fixture's input messages through an `EvalAgent`, returning the
 * full resulting trajectory (input + output messages) for the evaluators to
 * score, on a thread id unique to this one case so no two cases/models ever
 * share checkpointed state. */
export async function runFixtureTurn(
  evalAgent: EvalAgent,
  threadId: string,
  inputMessages: BaseMessage[],
): Promise<BaseMessage[]> {
  const result = await evalAgent.agent.invoke(
    { messages: inputMessages },
    { configurable: { thread_id: threadId }, callbacks: [evalAgent.handler] },
  );
  return result.messages as BaseMessage[];
}
