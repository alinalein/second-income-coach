import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { planResponseSchema, currentStepResponseSchema, type PlanResponse } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildPlanThreadId, buildPlanCreateTriggerThreadId, buildDiscoveryThreadId } from '../../agent/index.js';
import { getCurrentStep } from '../../tools/plain/get_current_step.js';
import { ideas, plans } from '../../db/schema/index.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';
import { detectUserReplyLanguage } from './ideas.js';

export interface PlansRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS'>;
  db: ReturnType<typeof createDb>['db'];
  /** The plans-only compiled agent (`plansAgent`, `src/api/index.ts`) — the
   * one with `create_plan`/`get_current_step` wired in, never the
   * discovery/ideas agent. */
  agent: CoachAgent;
}

type PlanRow = typeof plans.$inferSelect;

/**
 * Review fix: two concurrent `POST /select/:ideaId` requests for the same
 * idea with no existing plan can both pass the "no existing plan" check
 * above and both invoke `create_plan` — the loser's insert hits the
 * `plans_idea_id_unique` constraint (Postgres error code `23505`) and
 * throws. That's not a real failure (a plan *was* created, by the winner),
 * so it's detected here rather than falling through to the generic 502 the
 * `catch` block below reports for every other failure.
 */
/**
 * Bug fix (user-reported, live): Drizzle's `node-postgres` driver wraps the
 * real `pg` error — the underlying Postgres error (with `.code`) lives at
 * `error.cause`, never copied to the wrapper's own top level. Checking only
 * `error.code` (the original version of this function) was always
 * `undefined` for a real DB error, so this recovery path never actually
 * fired in production; every genuine race fell through to the generic 502
 * below instead. Confirmed live: a real unique-violation's `error.cause.code`
 * is `'23505'`, `error.code` is `undefined`.
 */
export function isUniqueViolationError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | undefined)?.code;
  const causeCode = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

function toPlanResponse(row: PlanRow): PlanResponse {
  return planResponseSchema.parse({
    id: row.id,
    ideaId: row.ideaId,
    status: row.status,
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Message the plan thread sees the first time a plan is created — same
 * precedent as `ideas.ts`'s `buildGenerateIdeasAgentMessage`: the reply
 * language is stated explicitly (detected server-side), the agent still
 * supplies it as its own tool-call argument (AD-4).
 */
function buildCreatePlanAgentMessage(replyLanguage: 'de' | 'en'): string {
  const languageName = replyLanguage === 'de' ? 'German' : 'English';
  return (
    `Please create my plan now by calling create_plan. The user's reply language is ${languageName} ` +
    `("${replyLanguage}") — pass that as replyLanguage.`
  );
}

/**
 * Bug fix (user-reported): the real plan thread must never show the raw
 * creation trigger as if the user had typed it. Once the plan actually
 * exists, this fixed (not model-generated — keeps the `returnDirect` speed
 * win) welcome message is the thread's first visible entry instead,
 * orienting the user at the one thing 3.1 actually renders: the current
 * step in `StatusPanel`, on the left.
 */
const PLAN_READY_MESSAGE_EN =
  "Your plan is ready — you can see your first step on the left. Once you've done it, let me know here and the next step will unlock.";
const PLAN_READY_MESSAGE_DE =
  'Dein Plan ist fertig — deinen ersten Schritt siehst du links. Sag mir hier Bescheid, sobald du ihn erledigt hast, dann wird der nächste Schritt freigeschaltet.';

/**
 * `createPlansRouter`: `POST /select/:ideaId` (AC: lazy create-or-fetch —
 * AD-13) and `GET /:planId/current-step` (AD-4's sole steps-read path, used
 * directly as a plain read here — same Boundary precedent as
 * `ideas.ts`/`get_current_step` never being a second write path).
 */
export function createPlansRouter({ env, db, agent }: PlansRouterDeps) {
  const router = Router();
  // Intent/Code Map: "create_plan is LLM-backed and cost-bearing like
  // generate_ideas's POST; reuse the same strict tier."
  const strictLimiter = createStrictRateLimiter(env);

  router.post('/select/:ideaId', strictLimiter, async (req, res) => {
    const userId = req.session.userId!;
    const ideaIdParse = z.uuid().safeParse(req.params.ideaId);
    if (!ideaIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const ideaId = ideaIdParse.data;

    // Same request-scoped abort pattern as `ideas.ts`'s `POST /generate` —
    // a client disconnect aborts the in-flight `create_plan` call rather
    // than letting it keep running for a caller that's already gone.
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('create_plan: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      // I/O matrix: "Idea not owned by user / unselected idea" -> 404, no
      // plan created. `create_plan` runs lazily only for a `selected` or
      // `bookmarked` idea (AD-13) — `suggested`/`rejected` are never a
      // valid target.
      const [idea] = await db
        .select({ status: ideas.status })
        .from(ideas)
        .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)))
        .limit(1);
      if (!idea || (idea.status !== 'selected' && idea.status !== 'bookmarked')) {
        res.status(404).json({ error: 'Idea not found' });
        return;
      }

      // I/O matrix: "Re-open, plan exists" -> existing row returned,
      // `create_plan` never re-invoked (Boundary: "exactly one plans row
      // per idea").
      const [existingPlan] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      if (existingPlan) {
        res.json(toPlanResponse(existingPlan));
        return;
      }

      // I/O matrix: "First selection, no plan" -> `create_plan` runs once,
      // on its own new plan thread (AD-18) — `planId` is minted here,
      // before any row exists, so the thread id can be built ahead of the
      // write `create_plan` itself performs.
      const planId = randomUUID();
      // Bug fix (user-reported): the trigger invocation itself runs on a
      // throwaway internal-only thread, never the real `plan:${planId}`
      // thread `plan-chat.ts` later reads — otherwise the synthetic
      // "call create_plan now" message gets checkpointed into, and then
      // rendered from, that same visible history.
      const triggerThreadId = buildPlanCreateTriggerThreadId(planId);
      const replyLanguage = await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId));

      // Perf fix (user-requested): this trigger message is server-authored
      // (never user input) and there is exactly one tool this turn can ever
      // call — `skipInputModeration` (moderation.ts) and `forceToolChoice`
      // (toolChoice.ts) are both scoped to this one call site, so neither
      // changes behavior for the plan thread's own later free-form
      // follow-up questions, which go through `plan-chat.ts` instead and
      // never set either flag.
      await agent.invoke(
        { messages: [new HumanMessage(buildCreatePlanAgentMessage(replyLanguage))] },
        {
          configurable: {
            thread_id: triggerThreadId,
            planId,
            ideaId,
            userId,
            skipInputModeration: true,
            forceToolChoice: 'create_plan',
          },
          signal: abortController.signal,
        },
      );

      const [createdPlan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
      if (!createdPlan) {
        // I/O matrix: "LLM output fails Zod validation" / any other
        // `create_plan` failure -> generic error, no partial row ever
        // reported as success.
        res.status(502).json({ error: 'Plan could not be generated' });
        return;
      }

      // Bug fix (user-reported): seed the real plan thread with a fixed
      // welcome message now that the plan actually exists — the user's
      // first sight of this thread, never the raw trigger text above.
      await agent.updateState(
        { configurable: { thread_id: buildPlanThreadId(planId) } },
        { messages: [new AIMessage(replyLanguage === 'de' ? PLAN_READY_MESSAGE_DE : PLAN_READY_MESSAGE_EN)] },
      );

      res.json(toPlanResponse(createdPlan));
    } catch (error) {
      if (isUniqueViolationError(error)) {
        // The race above: some other request's `create_plan` won — re-read
        // and return that row instead of reporting a false failure.
        const [winningPlan] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
        if (winningPlan) {
          res.json(toPlanResponse(winningPlan));
          return;
        }
      }
      console.error('[plans] select failed:', { userId, ideaId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Plan could not be generated' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  router.get('/:planId/current-step', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    try {
      const [plan] = await db.select({ userId: plans.userId }).from(plans).where(eq(plans.id, planIdParse.data)).limit(1);
      if (!plan || plan.userId !== userId) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const result = await getCurrentStep(db, planIdParse.data);
      res.json(currentStepResponseSchema.parse(result));
    } catch (error) {
      console.error('[plans] current-step read failed:', { userId, planId: planIdParse.data, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  return router;
}
