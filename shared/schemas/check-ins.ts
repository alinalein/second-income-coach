import { z } from 'zod';
import { planStepResponseSchema } from './plans.js';

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

export const startStepResponseSchema = z.object({
  step: planStepResponseSchema,
});

export type StartStepResponse = z.infer<typeof startStepResponseSchema>;

/**
 * AC: "`complete_step` on the final step ... the plan's status becomes
 * `completed`, with its own completion acknowledgment distinct from a
 * per-step one" — `planCompleted` is the discriminator the caller (route or
 * agent) uses to pick which acknowledgment applies; this schema carries no
 * acknowledgment text itself (Design Notes: UI-button acknowledgments are
 * rendered client-side via i18n, chat acknowledgments are composed by the
 * model from this structured result, guarded by the AD-12 check).
 */
export const completeStepResponseSchema = z.object({
  step: planStepResponseSchema,
  planCompleted: z.boolean(),
});

export type CompleteStepResponse = z.infer<typeof completeStepResponseSchema>;
