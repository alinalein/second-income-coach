import { eq, and, ne } from 'drizzle-orm';
import { StateGraph, Annotation, START, END, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  activatePlanDecisionSchema,
  planActivationReviewSchema,
  planResponseSchema,
  planStepResponseSchema,
  type PlanActivationReview,
  type PlanResponse,
  type PlanStepResponse,
  type CreatePlanDraft,
} from '@app/shared';
import type { createDb } from '../../db/client.js';
import { plans, planSteps } from '../../db/schema/index.js';
import { buildPlanActivationThreadId } from '../../agent/index.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { handleRegeneratePlanDraft, type CreatePlanDeps } from '../llm/create_plan.js';
import { applyModelNodeResilience, PLAN_MODEL_NODE_TIMEOUT_MS, PLAN_MODEL_NODE_RETRY_POLICY } from '../../agent/resilience.js';

type Db = ReturnType<typeof createDb>['db'];
type PlanRow = typeof plans.$inferSelect;
type PlanStepRow = typeof planSteps.$inferSelect;

/** Same precedent as `set_idea_status.ts`'s `IdeaNotFoundError` — lets the
 * route distinguish "not found/not owned" (404) from any other failure. */
export class PlanNotFoundError extends Error {}

/** AC: activation only ever applies to a `draft` plan — surfaced as its own
 * error type so the route can map it to a clear 409, not a generic 502. */
export class PlanNotDraftError extends Error {}

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

function toStepResponse(row: PlanStepRow): PlanStepResponse {
  return planStepResponseSchema.parse({
    id: row.id,
    stepOrder: row.stepOrder,
    title: row.title,
    description: row.description,
    dayOffset: row.dayOffset,
    status: row.status,
  });
}

function toReview(plan: PlanRow, steps: PlanStepRow[]): PlanActivationReview {
  return planActivationReviewSchema.parse({
    plan: toPlanResponse(plan),
    steps: [...steps].sort((a, b) => a.stepOrder - b.stepOrder).map(toStepResponse),
  });
}

/**
 * Loads the draft plan + its full ordered steps for review — AD-14's
 * interrupt payload. Unlike `get_current_step` (AD-4: current+next only,
 * the active-plan progression view), this intentionally shows the *whole*
 * draft, since the user is reviewing/editing it before it ever becomes
 * active — a different concern AD-4's cap was never meant to restrict.
 */
export async function loadPlanForReview(db: Db, planId: string, userId: string): Promise<{ plan: PlanRow; steps: PlanStepRow[] }> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan || plan.userId !== userId) {
    throw new PlanNotFoundError(`activate_plan: plan "${planId}" was not found or not owned by this user`);
  }
  if (plan.status !== 'draft') {
    throw new PlanNotDraftError(`activate_plan: plan "${planId}" is "${plan.status}", not "draft"`);
  }

  const steps = await db.select().from(planSteps).where(eq(planSteps.planId, planId));
  return { plan, steps };
}

/**
 * AD-14: "Confirm → plan becomes `active` (and any previously active plan
 * becomes `paused`) ... enforced via a database-level partial unique
 * constraint ... applied inside a single transaction that atomically
 * deactivates the previous plan and activates the new one — never two
 * separate non-transactional UPDATE statements." Pausing first, then
 * activating, means the partial unique index (`plans_one_active_per_user_idx`,
 * `src/db/schema/plans.ts`) is never hit mid-transaction: by the time this
 * plan flips to `active`, no other row for this user still is. "Zero active
 * plans" (AC) is simply the pause UPDATE matching zero rows — not an error.
 */
export async function confirmActivation(db: Db, planId: string, userId: string): Promise<PlanResponse> {
  const updatedPlan = await db.transaction(async (tx) => {
    // Review fix: two decisions resuming concurrently for the *same* paused
    // review (e.g. a double-submitted confirm + modify, two browser tabs)
    // each independently replay the node and each reach their own branch —
    // `Command({ resume })` is scoped to that one `invoke()` call, not a
    // shared/persisted slot, so neither call observes the other's in-flight
    // write. Without a lock, both transactions would commit, and whichever
    // writes last wins — silently reverting an already-confirmed `active`
    // plan back to `draft` (or vice versa) while the earlier request still
    // thinks it succeeded. `FOR UPDATE` serializes them: the second
    // transaction blocks until the first commits, then sees the now-
    // non-`draft` status and aborts instead of clobbering it.
    const [locked] = await tx.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).for('update');
    if (!locked || locked.status !== 'draft') {
      throw new PlanNotDraftError(`activate_plan: plan "${planId}" is no longer a draft (resolved by a concurrent request)`);
    }

    await tx
      .update(plans)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(plans.userId, userId), eq(plans.status, 'active'), ne(plans.id, planId)));

    const [planRow] = await tx
      .update(plans)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(plans.id, planId))
      .returning();
    return planRow!;
  });

  return toPlanResponse(updatedPlan);
}

/**
 * AC: "the modification is validated against the Zod schema and saved to
 * the draft (status remains `draft`)". The caller (`activatePlanDecisionSchema`
 * parse, in the node below) has already Zod-validated `draft` against the
 * same `createPlanDraftSchema` `create_plan`'s own LLM output uses (AD-16) —
 * this only re-derives plan step rows from it, same shape `create_plan`/
 * `handleRegeneratePlanDraft` already write.
 */
export async function saveModifiedDraft(db: Db, planId: string, draft: CreatePlanDraft): Promise<PlanResponse> {
  const updatedPlan = await db.transaction(async (tx) => {
    // Review fix: same concurrent-resume race as `confirmActivation` — lock
    // and re-check before writing, so a modify that loses the race to a
    // concurrent confirm aborts instead of overwriting the now-`active`
    // plan's steps and silently reverting it to `draft`.
    const [locked] = await tx.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).for('update');
    if (!locked || locked.status !== 'draft') {
      throw new PlanNotDraftError(`activate_plan: plan "${planId}" is no longer a draft (resolved by a concurrent request)`);
    }

    await tx.delete(planSteps).where(eq(planSteps.planId, planId));
    await tx.insert(planSteps).values(
      draft.steps.map((step, index) => ({
        planId,
        stepOrder: index,
        title: step.title,
        description: step.description,
        dayOffset: step.dayOffset,
        status: index === 0 ? 'current' : 'pending',
      })),
    );
    const [planRow] = await tx
      .update(plans)
      .set({ status: 'draft', updatedAt: new Date() })
      .where(eq(plans.id, planId))
      .returning();
    return planRow!;
  });

  return toPlanResponse(updatedPlan);
}

const ActivatePlanState = Annotation.Root({
  result: Annotation<PlanResponse | undefined>(),
});

export interface ActivatePlanGraphDeps {
  checkpointer: BaseCheckpointSaver;
  db: Db;
  model: BaseChatModel;
  /** Test-only seam, forwarded to `handleRegeneratePlanDraft`'s own
   * `createDraft` seam for the reject branch — same precedent as
   * `create_plan.ts`'s `CreatePlanDeps.createDraft`. */
  createDraft?: CreatePlanDeps['createDraft'];
}

/**
 * AD-14: "`activate_plan`'s HITL pause uses LangGraph.js's `interrupt()` /
 * `Command(resume)` pattern." One node, no model node of its own — confirm
 * /modify are plain Postgres writes; reject's LLM call happens inside
 * `handleRegeneratePlanDraft` (reusing `create_plan`'s own generator, AD-4:
 * `create_plan` stays the one LLM-backed draft generator). Compiled with the
 * shared Postgres checkpointer so the pause survives across requests/process
 * restarts, on its own thread kind (`buildPlanActivationThreadId`) — never
 * the plan's user-visible chat thread (`buildPlanThreadId`), since a
 * different graph topology sharing that thread id would risk deserializing
 * an incompatible checkpoint.
 */
export function createActivatePlanGraph({ checkpointer, db, model, createDraft }: ActivatePlanGraphDeps) {
  const graph = new StateGraph(ActivatePlanState).addNode('review', async (_state, runtime) => {
    const configurable = runtime.configurable as { planId?: string; userId?: string } | undefined;
    const planId = configurable?.planId;
    const userId = configurable?.userId;
    if (!planId || !userId) {
      throw new Error('activate_plan: planId/userId are not derivable from the current server context');
    }

    const { plan, steps } = await loadPlanForReview(db, planId, userId);

    // AD-14: this is the one call site that can pause the whole graph — on
    // a fresh run it throws `GraphInterrupt` (persisted by the checkpointer,
    // caught by the compiled graph's own run loop, never reaching here as a
    // thrown error); on a `Command({ resume })` run it returns that resume
    // value instead, Zod-validated/parsed by `responseSchema` (AD-16). A
    // plan can reach `active`/have its draft mutated only via the branches
    // below this line — all of which are unreachable without a resume value.
    const decision = interrupt(toReview(plan, steps), { responseSchema: activatePlanDecisionSchema });

    if (decision.action === 'confirm') {
      return { result: await confirmActivation(db, planId, userId) };
    }
    if (decision.action === 'modify') {
      return { result: await saveModifiedDraft(db, planId, decision.draft) };
    }

    // decision.action === 'reject' (AD-13: "create_plan runs again and
    // updates the same plan row in place").
    const replyLanguage = detectReplyLanguage(decision.feedback);
    return {
      result: await handleRegeneratePlanDraft(
        { db, model, createDraft },
        planId,
        plan.ideaId,
        userId,
        replyLanguage,
        decision.feedback,
        runtime.signal,
      ),
    };
  });

  graph.addEdge(START, 'review').addEdge('review', END);

  return applyModelNodeResilience(graph, PLAN_MODEL_NODE_TIMEOUT_MS, PLAN_MODEL_NODE_RETRY_POLICY).compile({ checkpointer });
}

export type ActivatePlanGraph = ReturnType<typeof createActivatePlanGraph>;

/**
 * Reads back a still-pending review without re-running the node — used by
 * `GET /api/plans/:planId/activate` (page refresh mid-review) and by
 * `POST /api/plans/:planId/activate` (idempotent re-request: never starts a
 * second fresh run against a thread that already has one paused). Returns
 * `null` when there is no paused interrupt for this thread (nothing
 * requested yet, or it already resolved).
 */
export async function getPendingReview(graph: ActivatePlanGraph, planId: string): Promise<PlanActivationReview | null> {
  const threadId = buildPlanActivationThreadId(planId);
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const interruptValue = state.tasks[0]?.interrupts[0]?.value;
  return interruptValue ? planActivationReviewSchema.parse(interruptValue) : null;
}
