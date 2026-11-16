import { z } from 'zod';

/**
 * Story 2.1: the structured intake form. `failurePattern` is deliberately
 * NOT part of `submitIntakeRequestSchema` — it's classified by the
 * top-level agent while constructing the `submit_intake` tool call (AD-4),
 * never supplied by the client. `submitIntakeToolSchema` extends the request
 * shape with that one extra field — it's the schema the tool itself
 * (`src/tools/plain/submit_intake.ts`) validates the agent's constructed
 * tool call against.
 *
 * Enum tokens are this story's own design-notes call, not dictated by an AC:
 * see `spec-2-1-structured-intake-with-failure-pattern-classification.md`'s
 * Design Notes for the exact token list and rationale.
 */
export const failurePatternSchema = z.enum([
  'overwhelm',
  'loses_interest_once_routine',
  'gets_stuck_no_next_step',
  'life_disruption',
  'forgets_deprioritizes',
]);

export type FailurePattern = z.infer<typeof failurePatternSchema>;

export const weeklyTimeAvailabilitySchema = z.enum(['under_5h', '5_to_10h', '10_to_20h', '20h_plus']);

export type WeeklyTimeAvailability = z.infer<typeof weeklyTimeAvailabilitySchema>;

export const startingBudgetRangeSchema = z.enum(['under_100', '100_to_500', '500_to_2000', '2000_plus']);

export type StartingBudgetRange = z.infer<typeof startingBudgetRangeSchema>;

export const riskToleranceSchema = z.enum(['low', 'medium', 'high']);

export type RiskTolerance = z.infer<typeof riskToleranceSchema>;

/** Design Notes: "Free-text fields capped at 1000 chars (same pattern as
 * `CHAT_MESSAGE_MAX_LENGTH`)" — applies to `skillsInterests` and
 * `stoppedBeforeText`, the form's two free-text fields. */
export const INTAKE_FREE_TEXT_MAX_LENGTH = 1000;

const intakeFreeText = z
  .string()
  .min(1, 'This field is required')
  .max(INTAKE_FREE_TEXT_MAX_LENGTH, `Must be ${INTAKE_FREE_TEXT_MAX_LENGTH} characters or fewer`);

/** The form fields a client POSTs to `/api/intake` — never `failurePattern`
 * (Boundary: "never a client-supplied field"). */
export const submitIntakeRequestSchema = z.object({
  skillsInterests: intakeFreeText,
  weeklyTimeAvailability: weeklyTimeAvailabilitySchema,
  startingBudgetRange: startingBudgetRangeSchema,
  riskTolerance: riskToleranceSchema,
  stoppedBeforeText: intakeFreeText,
});

export type SubmitIntakeRequest = z.infer<typeof submitIntakeRequestSchema>;

/** The args the agent constructs for the `submit_intake` tool call — the
 * request shape plus the one field only the agent ever supplies. */
export const submitIntakeToolSchema = submitIntakeRequestSchema.extend({
  failurePattern: failurePatternSchema,
});

export type SubmitIntakeToolArgs = z.infer<typeof submitIntakeToolSchema>;

/** The user-facing persisted record, returned by both `GET /api/intake`
 * (prefill) and `POST /api/intake` (post-submit). */
export const intakeResponseSchema = submitIntakeToolSchema.extend({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type IntakeResponse = z.infer<typeof intakeResponseSchema>;

/** `GET /api/intake`'s response: `null` when the signed-in user has no row
 * yet (I/O matrix: "No intake yet" -> "App renders the intake form, blank"). */
export const getIntakeResponseSchema = z.object({
  intake: intakeResponseSchema.nullable(),
});

export type GetIntakeResponse = z.infer<typeof getIntakeResponseSchema>;

/** `POST /api/intake`'s success response. */
export const submitIntakeResponseSchema = z.object({
  intake: intakeResponseSchema,
});

export type SubmitIntakeResponse = z.infer<typeof submitIntakeResponseSchema>;
