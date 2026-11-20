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
 * `POST .../steps/:stepId/start`'s own response — the plain DB write only.
 * Perf fix (user-reported, live): `chatMessage` used to live here too (one
 * direct, non-agentic model call run inline), making this response wait on
 * it; that call is now `startStepAckResponseSchema` below, fetched by the
 * frontend as a second request right after this one succeeds.
 */
export const startStepResponseSchema = z.object({
  step: planStepResponseSchema,
});

export type StartStepResponse = z.infer<typeof startStepResponseSchema>;

/**
 * Spec 2.12 AC8: `POST .../steps/:stepId/start-ack`'s own response —
 * `chatMessage` is present only when the server's own one direct,
 * non-agentic model call produced a start-of-step acknowledgment that
 * passed moderation/guilt-language checks — absent (not an error) on any
 * model-call failure/flag/timeout, same fail-open precedent as every other
 * best-effort extra in this codebase.
 */
export const startStepAckResponseSchema = z.object({
  chatMessage: chatMessageSchema.optional(),
});

export type StartStepAckResponse = z.infer<typeof startStepAckResponseSchema>;

/**
 * `POST .../steps/:stepId/complete`'s own response — the plain DB write
 * only. Story 4.6 (perf fix, mirroring `startStepResponseSchema`'s own
 * precedent exactly): `chatMessage` used to live here too (one direct,
 * non-agentic model call run inline), making this response wait on it;
 * that call is now `completeStepAckResponseSchema` below, fetched by the
 * frontend as a second request right after this one succeeds.
 * `planCompleted` is the discriminator the caller (route, agent, or the
 * later `/complete-ack` request) uses to pick which acknowledgment applies
 * — "`complete_step` on the final step ... the plan's status becomes
 * `completed`, with its own completion acknowledgment distinct from a
 * per-step one".
 */
export const completeStepResponseSchema = z.object({
  step: planStepResponseSchema,
  planCompleted: z.boolean(),
});

export type CompleteStepResponse = z.infer<typeof completeStepResponseSchema>;

/**
 * Story 4.6: `POST .../steps/:stepId/complete-ack`'s own response — mirrors
 * `startStepAckResponseSchema` exactly. `chatMessage` is present only when
 * the server's own one direct, non-agentic model call produced a completion
 * acknowledgment (themed around the whole plan on the plan's final step, or
 * around just this one step otherwise — never both: the final step's own
 * plan-completion message is the only message this route ever produces for
 * that step) that passed moderation/guilt-language checks — absent (not an
 * error) on any model-call failure/flag/timeout, same fail-open precedent.
 */
export const completeStepAckResponseSchema = z.object({
  chatMessage: chatMessageSchema.optional(),
});

export type CompleteStepAckResponse = z.infer<typeof completeStepAckResponseSchema>;

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
