import bytes from 'bytes';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import type { CoachAgent } from '../agent/index.js';
import type { MemoryPutStore, MemoryDeleteStore } from '../agent/memory.js';
import type { ActivatePlanGraph } from '../tools/plain/activate_plan.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createGeneralRateLimiter } from './middleware/rateLimit.js';
import { createRequireSameOrigin } from './middleware/requireSameOrigin.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createSessionMiddleware } from './middleware/session.js';
import { createHealthRouter } from './routes/health.js';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter } from './routes/chat.js';
import { createIntakeRouter } from './routes/intake.js';
import { createIdeasRouter } from './routes/ideas.js';
import { createPlansRouter } from './routes/plans.js';
import { createPlanChatRouter } from './routes/plan-chat.js';
import { createSettingsRouter } from './routes/settings.js';
import { createEvaluationRouter } from './routes/evaluation.js';
import { createVoiceRouter, MAX_VOICE_AUDIO_BYTES } from './routes/voice.js';

export interface AppDeps {
  env: Env;
  db: ReturnType<typeof createDb>['db'];
  pool: Pool;
  agent: CoachAgent;
  /** Story 2.2 follow-up fix 1: a second compiled agent, identical to
   * `agent` except for a longer outer-node timeout (AD-7) — used only by
   * the ideas route below, since `generate_ideas` routinely runs longer
   * than the chat/intake budget. */
  ideasAgent: CoachAgent;
  /** Story 3.1: a third compiled agent, with `create_plan`/
   * `get_current_step` wired in instead of `submit_intake`/`generate_ideas`
   * — used only by the plans/plan-chat routes below. */
  plansAgent: CoachAgent;
  /** Story 2.10: the shared chat model (`src/api/index.ts`'s own
   * `chatModel`) — passed to `createIdeasRouter`/`createPlansRouter` so
   * `POST /generate`/`POST /select/:ideaId` can call `handleGenerateIdeas`/
   * `handleCreatePlan` directly, with no `agent.invoke` around them. */
  chatModel: BaseChatModel;
  /** Story 2.10: the shared `web_search` MCP tool, passed through to
   * `createIdeasRouter` for the same direct `handleGenerateIdeas` call. */
  webSearchTool: DynamicStructuredTool;
  /** Story 3.2 (AD-14): the dedicated, checkpointed `activate_plan` graph
   * (`src/tools/plain/activate_plan.ts`) — passed to `createPlansRouter` for
   * its `/:planId/activate*` routes. Never `plansAgent`: this graph has its
   * own topology/thread kind, not another tool on the chat ReAct loop. */
  activatePlanGraph: ActivatePlanGraph;
  /** Story 5.3b (AD-2): the per-user semantic memory store — threaded to
   * `createChatRouter`/`createPlanChatRouter` so `setFeedback`/
   * `removeFeedback` can remember/forget a rated comment. */
  memoryStore: MemoryPutStore & MemoryDeleteStore;
}

/**
 * Express app factory (AD-30 security baseline):
 *  - `helmet` for security headers
 *  - same-origin `cors` (deny-by-default allowlist)
 *  - `express-rate-limit`, general tier, on every route
 *  - a configured request body-size limit, rejected before any route handler runs
 *    (enforced as a blanket Content-Length check ahead of any body parser, so
 *    it applies regardless of content type, not just the JSON parser below)
 *
 * Built as a factory (not a top-level `listen()`) so tests can construct the
 * app against injected deps without binding a real port or a real database.
 */
export function createApp({
  env,
  db,
  pool,
  agent,
  ideasAgent,
  plansAgent,
  chatModel,
  webSearchTool,
  activatePlanGraph,
  memoryStore,
}: AppDeps) {
  const app = express();

  // Behind a reverse proxy (Cloud Run, or any future load balancer), trust the
  // first hop's X-Forwarded-For so the rate limiter (and any future IP-based
  // logic) resolves the real client IP instead of the proxy's.
  app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createCorsMiddleware(env));
  app.use(createGeneralRateLimiter(env));

  const maxBodyBytes = bytes.parse(env.BODY_LIMIT) ?? Number.POSITIVE_INFINITY;
  app.use((req, res, next) => {
    const contentLength = Number(req.headers['content-length']);
    // Story 4.3: a raw audio upload is legitimately far larger than
    // env.BODY_LIMIT's JSON-request budget — exempted up to its own, much
    // larger `MAX_VOICE_AUDIO_BYTES` cap instead (still enforced, both here
    // and again by `createVoiceRouter`'s own `express.raw({ limit: ... })`).
    // Review fix: scoped to this one exact route, not every `/api/voice/*`
    // path, so a future route added under that prefix doesn't silently
    // inherit a 10MB allowance it never asked for.
    const limit = req.path === '/api/voice/transcribe' ? MAX_VOICE_AUDIO_BYTES : maxBodyBytes;
    if (Number.isFinite(contentLength) && contentLength > limit) {
      res.status(413).json({ error: 'Bad request' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: env.BODY_LIMIT }));

  // Story 1.2: Postgres-backed session cookie, then the CSRF-defense Origin
  // check on every state-changing request (Intent: "CSRF defense =
  // SameSite=Lax + an Origin-header check on mutations").
  app.use(createSessionMiddleware(env, pool));
  app.use(createRequireSameOrigin(env));

  app.use('/api/health', createHealthRouter({ db }));
  app.use('/api/auth', createAuthRouter({ env, db }));

  // Auth gate (Intent: "an auth gate on every non-health route"; AC: "any
  // route other than /api/health* is hit without a valid session ... 401
  // before any handler logic runs"). Mounted after /api/health and /api/auth
  // so their own (already-registered) routes resolve first — including
  // /api/auth/google and /api/auth/google/callback, which must stay public
  // since they're how a session is established in the first place; /api/auth
  // routes that do need a session (session, logout) apply `requireAuth`
  // themselves. Anything else, including an undefined route, falls through
  // to this blanket gate and gets 401 rather than leaking a 404.
  app.use(requireAuth);

  // Story 1.3: the core agent loop, mounted only after the blanket auth gate
  // above — every route on this router is reachable only by a signed-in
  // session (Boundary: "Every route this story adds sits behind the existing
  // `requireAuth` gate").
  app.use('/api/chat', createChatRouter({ env, agent, db, memoryStore }));

  // Story 2.1: structured intake, same auth-gated/post-chat mounting as the
  // chat router above. Story 2.10: no `agent` dep anymore — `POST /` stores
  // directly, no `agent.invoke`.
  app.use('/api/intake', createIntakeRouter({ env, db }));

  // Story 2.2: tailored idea generation, same auth-gated mounting. Uses
  // `ideasAgent` (longer node timeout, follow-up fix 1), not `agent`. Story
  // 2.10: `POST /generate` now calls `handleGenerateIdeas` directly, so the
  // shared `chatModel`/`webSearchTool` are threaded in too; `ideasAgent`
  // stays needed for `detectUserReplyLanguage`.
  app.use('/api/ideas', createIdeasRouter({ env, db, agent: ideasAgent, model: chatModel, webSearchTool }));

  // Story 3.1: lazy draft-plan creation + the sole current-step read path,
  // plus the plan thread's own free-form chat — both use `plansAgent`
  // (`create_plan`/`get_current_step`), never `agent`/`ideasAgent`. Story
  // 2.10: `POST /select/:ideaId` now calls `handleCreatePlan` directly, so
  // the shared `chatModel` is threaded in too; `plansAgent` stays needed for
  // `detectUserReplyLanguage`/`.updateState` (the plan welcome message).
  app.use('/api/plans', createPlansRouter({ env, db, agent: plansAgent, model: chatModel, activatePlanGraph }));
  app.use('/api/plans', createPlanChatRouter({ env, db, agent: plansAgent, memoryStore }));

  // Story 5.1: personality + model settings, same auth gate as /api/chat.
  app.use('/api/settings', createSettingsRouter({ env, db }));

  // Story 7.5 (AD-28, no exception): the Evaluation & Decisions page's
  // data endpoint, same auth gate as every other route below the blanket
  // `requireAuth` above.
  app.use('/api/evaluation', createEvaluationRouter());

  // Story 4.3 (AD-9/AD-10): the one voice-transcription route, same auth
  // gate as every other route below it — `createVoiceRouter`'s own
  // `express.raw` body parser only runs for this one path, after the
  // blanket content-length gate above (exempted for `/api/voice/*`) and the
  // global `express.json()` parser above (which no-ops for a non-JSON
  // content type, leaving the body stream for `express.raw` to consume).
  app.use('/api/voice', createVoiceRouter({ env }));

  // Centralized error handler. Oversized bodies and malformed JSON surface
  // here as errors from the body parser — this is what keeps the process
  // alive with a generic response instead of crashing (I/O matrix: "Oversized
  // request body"). A rejected CORS origin (CorsOriginError, status 403) is
  // distinguished from an actual server failure (500).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express requires 4-arg signature to register an error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      (err as { status?: number; statusCode?: number } | undefined)?.status ??
      (err as { statusCode?: number } | undefined)?.statusCode ??
      500;
    const message = status === 500 ? 'Internal server error' : status === 403 ? 'Forbidden' : 'Bad request';
    res.status(status).json({ error: message });
  });

  return app;
}
