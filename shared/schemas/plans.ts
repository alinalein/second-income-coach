import { z } from 'zod';

/**
 * AD-13: plan lifecycle — `draft` (produced by `create_plan`, this story) ->
 * `active` | `paused` (Story 3.2's human-confirmed activation) -> `completed`
 * (Epic 4's final-step completion). Defined with all 4 values now, not just
 * `draft` (same precedent as `ideaStatusSchema`), so the shared enum (AD-16's
 * lockstep requirement) never needs a later migration to add the other 3.
 */
export const planStatusSchema = z.enum(['draft', 'active', 'paused', 'completed']);

export type PlanStatus = z.infer<typeof planStatusSchema>;

/**
 * A plan step's own lifecycle: `pending` (not yet reached) -> `current`
 * (exactly one per plan, the step `get_current_step` returns) ->
 * `completed` (`complete_step`, Epic 4). `create_plan` writes step 0 as
 * `current` and every other step as `pending` — nothing is `completed` yet.
 */
export const planStepStatusSchema = z.enum(['pending', 'current', 'completed']);

export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

/**
 * `create_plan`'s own tool-call schema — `replyLanguage` only, same shape
 * and precedent as `generateIdeasToolSchema` (Code Map): the agent supplies
 * it from its own judgment of the conversation's language, never the client.
 */
export const createPlanToolSchema = z.object({
  replyLanguage: z.enum(['en', 'de']),
});

export type CreatePlanToolArgs = z.infer<typeof createPlanToolSchema>;

const MIN_PLAN_STEPS = 3;
const MAX_PLAN_STEPS = 12;
const MIN_STEP_ACTIONS = 1;
const MAX_STEP_ACTIONS = 5;

/**
 * UI fix (user-reported): a step's description renders as a bullet list
 * (`StatusPanel.tsx`), not a prose paragraph — so the LLM must produce it as
 * a short list of distinct, concrete actions from the start, rather than the
 * UI trying to split one paragraph into bullets after the fact.
 */
const stepActionSchema = z.string().min(1).max(200);

/** One step of `create_plan`'s own LLM output — shape only; failure-pattern
 * sizing/sequencing is a system-prompt concern (`create_plan.ts`'s Design
 * Notes), not expressible as a Zod rule. */
const planDraftStepSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.array(stepActionSchema).min(MIN_STEP_ACTIONS).max(MAX_STEP_ACTIONS),
  dayOffset: z.number().int().nonnegative(),
});

/**
 * `create_plan`'s nested LLM must produce 3-12 ordered steps with a
 * timeline (Code Map), validated against this shared Zod schema before the
 * write (AD-4/AD-16). `dayOffset` must be non-decreasing across the array —
 * a timeline can't go backwards — checked via `.refine` since Zod's
 * per-field schemas can't express a cross-item ordering rule.
 */
export const createPlanDraftSchema = z.object({
  steps: z
    .array(planDraftStepSchema)
    .min(MIN_PLAN_STEPS)
    .max(MAX_PLAN_STEPS)
    .refine((steps) => steps.every((step, index) => index === 0 || step.dayOffset >= steps[index - 1]!.dayOffset), {
      message: 'steps must be ordered by non-decreasing dayOffset',
    }),
});

export type CreatePlanDraft = z.infer<typeof createPlanDraftSchema>;

/** The persisted/response shape — one row of the `plans` table, as returned
 * by `POST /api/plans/select/:ideaId`. */
export const planResponseSchema = z.object({
  id: z.string().min(1),
  ideaId: z.string().min(1),
  status: planStatusSchema,
  threadId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type PlanResponse = z.infer<typeof planResponseSchema>;

/** One plan step, as exposed by `get_current_step` — the sole path
 * returning step content (AD-4), so this is the only step shape the shared
 * schemas expose at all. */
export const planStepResponseSchema = z.object({
  id: z.string().min(1),
  stepOrder: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.array(stepActionSchema).min(1),
  dayOffset: z.number().int().nonnegative(),
  status: planStepStatusSchema,
});

export type PlanStepResponse = z.infer<typeof planStepResponseSchema>;

/** `GET /api/plans/:planId/current-step`'s response shape — capped to
 * current + immediate-next (Boundary: "`get_current_step` is the only path
 * returning step content ... capped to current+next"). `current` is
 * `null` only in the pathological case of a plan with no `current`-status
 * step at all (never expected from `create_plan`'s own write, defensive
 * only); `next` is `null` whenever `current` is the plan's last step. */
export const currentStepResponseSchema = z.object({
  current: planStepResponseSchema.nullable(),
  next: planStepResponseSchema.nullable(),
});

export type CurrentStepResponse = z.infer<typeof currentStepResponseSchema>;
