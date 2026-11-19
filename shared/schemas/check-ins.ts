import { z } from 'zod';
import { planStepResponseSchema } from './plans.js';
import { chatMessageSchema } from './chat.js';

/**
 * Story 4.1 (CAP-4/AD-4): the 3 energy/status levels `record_check_in`
 * accepts — a lightweight, non-judgmental signal requested before any
 * task-related ask, never a mood journal. Plain `text()` at the DB layer
 * (same no-`pgEnum` precedent as `plans.status`), validated only here.
 */
export const checkInEnergySchema = z.enum(['low', 'medium', 'high']);

export type CheckInEnergy = z.infer<typeof checkInEnergySchema>;

const CHECK_IN_NOTE_MAX_LENGTH = 2000;

/**
 * `record_check_in`'s request/tool-call shape — `note` is the one new
 * user-authored free text this story introduces (AD-11: moderated before
 * storage at the call site, same precedent as `activate_plan.ts`'s reject
 * `feedback`).
 */
export const recordCheckInRequestSchema = z.object({
  energy: checkInEnergySchema,
  note: z.string().max(CHECK_IN_NOTE_MAX_LENGTH).optional(),
});

export type RecordCheckInRequest = z.infer<typeof recordCheckInRequestSchema>;

export const checkInResponseSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  energy: checkInEnergySchema,
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type CheckInResponse = z.infer<typeof checkInResponseSchema>;

/** `start_step`/`complete_step`'s own tool-call shape — the model supplies
 * `stepId` from a step it already saw via `get_current_step` (AD-4: neither
 * tool exposes a way to discover a step id on its own). */
export const stepActionToolSchema = z.object({
  stepId: z.string().min(1),
});

export type StepActionToolArgs = z.infer<typeof stepActionToolSchema>;

/**
 * Spec 2.12 AC8: `chatMessage` is present only when the server's own one
 * direct, non-agentic model call produced a start-of-step acknowledgment
 * that passed moderation/guilt-language checks — absent (not an error) on
 * any model-call failure/flag/timeout, same fail-open precedent as every
 * other best-effort extra in this codebase.
 */
export const startStepResponseSchema = z.object({
  step: planStepResponseSchema,
  chatMessage: chatMessageSchema.optional(),
});

export type StartStepResponse = z.infer<typeof startStepResponseSchema>;

/**
 * AC: "`complete_step` on the final step ... the plan's status becomes
 * `completed`, with its own completion acknowledgment distinct from a
 * per-step one" — `planCompleted` is the discriminator the caller (route or
 * agent) uses to pick which acknowledgment applies.
 *
 * Story 4.5 (AC3): `chatMessage` mirrors `startStepResponseSchema`'s own
 * field exactly — present only when `planCompleted` is true and the route's
 * own one direct, non-agentic model call produced a completion message that
 * passed moderation/guilt-language checks; absent (not an error) on any
 * model-call failure/flag/timeout, or whenever this wasn't the final step.
 */
export const completeStepResponseSchema = z.object({
  step: planStepResponseSchema,
  planCompleted: z.boolean(),
  chatMessage: chatMessageSchema.optional(),
});

export type CompleteStepResponse = z.infer<typeof completeStepResponseSchema>;

/**
 * Story 4.1 (AC, follow-up): `GET /api/plans/check-in-status` — whether
 * this user has already answered (or dismissed) today's energy question,
 * computed from the user's own check-ins *across every plan*, never
 * scoped to one plan (AC: "once per calendar day per user across ALL
 * plans, not per plan"). User-scoped only; carries no `planId`.
 */
export const checkInStatusResponseSchema = z.object({
  answeredToday: z.boolean(),
});

export type CheckInStatusResponse = z.infer<typeof checkInStatusResponseSchema>;
