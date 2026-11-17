import '../config/loadDotenv.js';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createCheckpointer } from '../agent/checkpointer.js';
import { createCoachAgent } from '../agent/index.js';
import { createChatModel } from '../agent/model.js';
import { IDEAS_MODEL_NODE_TIMEOUT_MS, IDEAS_MODEL_NODE_RETRY_POLICY, PLAN_MODEL_NODE_TIMEOUT_MS, PLAN_MODEL_NODE_RETRY_POLICY } from '../agent/resilience.js';
import { getWebSearchTool } from '../tools/mcp/web_search.js';
import { createCreatePlanTool } from '../tools/llm/create_plan.js';
import { createGetCurrentStepTool } from '../tools/plain/get_current_step.js';
import { createApp } from './app.js';

const CHECKPOINTER_SETUP_TIMEOUT_MS = 10_000;
const WEB_SEARCH_TOOL_SETUP_TIMEOUT_MS = 10_000;

class StartupTimeoutError extends Error {}

/**
 * Bounds a startup step that talks to an external dependency so an
 * unreachable/slow instance (e.g. Postgres not running) fails fast with a
 * clear message, instead of `await`ing forever — the same "fail fast and
 * loud" behavior every other startup error in this file already has.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StartupTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Registers a one-shot shutdown hook that closes the `tavily-mcp` stdio
 * child process `getWebSearchTool`'s `MCPAdapter` spawned, so a server
 * restart/termination never leaves it orphaned.
 */
function registerWebSearchShutdownHook(close: () => Promise<void>): void {
  let closed = false;
  const closeOnce = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return close().catch((error: unknown) => {
      console.error('[api] failed to close web search MCP adapter', error);
    });
  };

  process.on('exit', () => {
    void closeOnce();
  });
  process.on('SIGTERM', () => {
    void closeOnce().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void closeOnce().finally(() => process.exit(0));
  });
}

try {
  const env = loadEnv();
  const { db, pool } = createDb(env);

  // Intent: "`PostgresSaver.setup()` runs once, idempotently, at API
  // startup (its own schema — not a Drizzle migration)."
  const checkpointer = createCheckpointer(env);
  await withTimeout(checkpointer.setup(), CHECKPOINTER_SETUP_TIMEOUT_MS, 'Checkpointer setup');
  // Boundary: "`src/api/index.ts` gets a small, necessary exception: 2-3
  // lines to `await` the async `MCPAdapter`-backed web-search tool
  // construction before `createCoachAgent(...)`" — `MCPAdapter.listTools()`
  // is inherently async; `createCoachAgent` stays synchronous. Same timeout
  // treatment as `checkpointer.setup()` above, so a stalled `npx` spawn
  // can't hang server startup indefinitely either.
  const { tool: webSearchTool, close: closeWebSearchTool } = await withTimeout(
    getWebSearchTool(env),
    WEB_SEARCH_TOOL_SETUP_TIMEOUT_MS,
    'Web search tool setup',
  );
  registerWebSearchShutdownHook(closeWebSearchTool);
  // Follow-up fix round 7 (speed, AD-7): built once here and passed into
  // both agents below (previously each `createCoachAgent` call built its
  // own `createChatModel(env)` internally when no override was given — two
  // separate client instances for the exact same model/env).
  const chatModel = createChatModel(env);
  const agent = createCoachAgent({ env, checkpointer, db, webSearchTool, model: chatModel });
  // Follow-up fix 1 (AD-7): a second compiled agent — identical tools/
  // middleware/checkpointer, only the outer node's timeout differs — used
  // only by the ideas route (`generate_ideas` routinely runs longer than
  // the 30s chat/intake budget). Sharing the one checkpointer/db/model is
  // safe: both compiled graphs have the exact same single-node topology, so
  // a checkpoint written by one is structurally valid for the other.
  const ideasAgent = createCoachAgent({
    env,
    checkpointer,
    db,
    webSearchTool,
    model: chatModel,
    modelNodeTimeoutMs: IDEAS_MODEL_NODE_TIMEOUT_MS,
    // Round 9, fix (a): no whole-turn retry for the ideas-only agent — a
    // timeout there is a failure, never a re-run of every search.
    modelNodeRetryPolicy: IDEAS_MODEL_NODE_RETRY_POLICY,
  });
  // Story 3.1: a third compiled agent — same checkpointer/db/model as the
  // other two, but its own tool set (`create_plan`/`get_current_step`,
  // never `submit_intake`/`generate_ideas`) and its own (shorter, no-search)
  // resilience budget. `webSearchTool` is still passed through only because
  // `createCoachAgent`'s own dependency shape requires it — this agent's
  // `tools: [...]` override never references it.
  const plansAgent = createCoachAgent({
    env,
    checkpointer,
    db,
    webSearchTool,
    model: chatModel,
    modelNodeTimeoutMs: PLAN_MODEL_NODE_TIMEOUT_MS,
    modelNodeRetryPolicy: PLAN_MODEL_NODE_RETRY_POLICY,
    tools: [createCreatePlanTool(db, chatModel), createGetCurrentStepTool(db)],
  });

  // Story 2.10: the same shared `chatModel`/`webSearchTool` built above —
  // `ideasAgent`/`plansAgent` stay constructed unchanged (still needed for
  // `.getState`/`.updateState`), but `createApp`'s ideas/plans routes now
  // also call `handleGenerateIdeas`/`handleCreatePlan` directly.
  const app = createApp({ env, db, pool, agent, ideasAgent, plansAgent, chatModel, webSearchTool });

  const server = app.listen(env.PORT, () => {
    console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // Same clean "startup failed" messaging as an env error, e.g. EADDRINUSE —
    // instead of crashing with a raw Node stack trace.
    console.error(`[api] startup failed:\n${error.message}`);
    process.exit(1);
  });
} catch (error) {
  if (error instanceof EnvValidationError || error instanceof StartupTimeoutError) {
    // Clear, non-silent failure (missing/invalid env var, or a startup
    // dependency that didn't respond in time), then exit.
    console.error(`[api] startup failed:\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
