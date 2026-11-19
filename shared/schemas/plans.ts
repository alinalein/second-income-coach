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
// User decision 2026-11-18: 3-12 steps; the model picks the count that fits the idea and the user's feedback.
const MAX_PLAN_STEPS = 12;
const MIN_STEP_ACTIONS = 1;
// Story 2.6 AC4: 5 -> 3 (shorter model output, no hard rule weakened).
const MAX_STEP_ACTIONS = 3;

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
  /** Story 4.1 (AD-4): set by `start_step` — lets the UI/model tell "not
   * started yet" from "already started" for the plan's current step. */
  startedAt: z.iso.datetime().nullable(),
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
  /**
   * Story 4.2 (AD-15): set when this call just detected a missed-check-in
   * gap and auto-recalculated the timeline — `true` only on the one call
   * that newly detects it, `false` on every later call until the next real
   * gap. `missedDays` is informational only; the neutral re-entry banner it
   * drives (`StatusPanel.tsx`) reads the exact same fixed, translated text
   * regardless of its value (NFR1: "identical for any number of missed
   * check-ins").
   */
  gapDetected: z.boolean(),
  missedDays: z.number().int().nonnegative(),
  /**
   * Bug fix (user-reported): the energy/status check-in ask must appear at
   * most once per calendar day — including after a week away, where it
   * should only ask about *today*, never prompt once per missed day.
   * `true` once a `record_check_in` row already exists for today (UTC).
   */
  checkedInToday: z.boolean(),
  /**
   * Story 4.5 (AC1): non-null only once the plan's own status is
   * `completed` — the data `StatusPanel.tsx`'s "Plan completed" card needs
   * (completion date, number of completed steps) instead of the generic
   * "No current step yet" text. `completedSteps` is a count only (never new
   * step content), so this stays within `get_current_step`'s own AD-4 cap
   * ("current+next step content only") — it's computed from rows this call
   * already reads for `current`/`next`, not a second steps-reading path.
   */
  completion: z
    .object({
      completedAt: z.iso.datetime(),
      completedSteps: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
});

export type CurrentStepResponse = z.infer<typeof currentStepResponseSchema>;

/**
 * Story 3.2 (AD-14): the value `activate_plan`'s `interrupt()` surfaces to
 * the caller while paused — the full draft (every step, not just
 * current+next; AD-4's cap is specific to `get_current_step`, not this
 * pre-activation review) so the UI's confirm/modify/reject panel can render
 * it.
 */
export const planActivationReviewSchema = z.object({
  plan: planResponseSchema,
  steps: z.array(planStepResponseSchema),
});

export type PlanActivationReview = z.infer<typeof planActivationReviewSchema>;

/**
 * Story 3.2 (AD-14): the resume value passed back via `new Command({resume})`
 * once the user picks confirm/modify/reject on the paused draft. `modify`'s
 * `draft` is re-validated against `createPlanDraftSchema` (AC: "validated
 * against the Zod schema") — the same shape `create_plan`'s own LLM output
 * is validated against, never a separately hand-written one (AD-16).
 */
export const activatePlanDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('modify'), draft: createPlanDraftSchema }),
  z.object({ action: z.literal('reject'), feedback: z.string().min(1).max(2000) }),
]);

export type ActivatePlanDecision = z.infer<typeof activatePlanDecisionSchema>;

/**
 * Story 2.9 — `GET /api/plans`'s own response shape: the sidebar's
 * "My plans" list, one entry per idea that has a plan, joined with that
 * idea's title (never re-fetched separately — AD-13/AD-16: the server
 * already has it in the same query). Ordered by `updatedAt` desc
 * ("sorted by last activity" — the plan row's own `updatedAt`, which
 * `activate_plan.ts`'s transactions already bump on every status change).
 */
export const planListEntrySchema = z.object({
  id: z.string().min(1),
  ideaId: z.string().min(1),
  ideaTitle: z.string().min(1),
  status: planStatusSchema,
  updatedAt: z.iso.datetime(),
});

export type PlanListEntry = z.infer<typeof planListEntrySchema>;

export const planListResponseSchema = z.object({
  plans: z.array(planListEntrySchema),
});

export type PlanListResponse = z.infer<typeof planListResponseSchema>;
