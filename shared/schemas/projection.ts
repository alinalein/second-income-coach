import { z } from 'zod';
import { moneySchema, currencyCodeSchema } from '../money.js';

/**
 * Story 4.4 (AD-4/CAP-5): `GET /api/plans/:planId/projection`'s response
 * shape. `estimate` is the raw stored baseline rate's minor-units + currency
 * (Boundary, same precedent as `ideaResponseSchema`'s own `baselineRateLow`/
 * `High` — "returns raw minor-units + currency as stored, conversion
 * happens client-side via `shared/money.ts`"), scaled by actual progress —
 * never re-fetched or recomputed from `web_search` (AD-6). `currency` is the
 * user's own display-currency setting (`user_settings.currency`, AD-27),
 * read fresh by the route on every call, never cached alongside `estimate`.
 */
export const unlockedOpportunitySchema = z.object({
  title: z.string().min(1),
  description: z.array(z.string().min(1)).min(1),
});

export type UnlockedOpportunity = z.infer<typeof unlockedOpportunitySchema>;

/**
 * AC: "two check-ins with different actual progress -> the projection value
 * changes between them." `progressRatio` (0-1, completed steps / total
 * steps) drives the projection card's own progress bar — the same number
 * `get_projection.ts`'s `computeProjection` used to compute `estimate`,
 * never recomputed separately client-side.
 */
export const projectionDataSchema = z.object({
  estimate: moneySchema,
  progressRatio: z.number().min(0).max(1),
  /**
   * AC: "the specific unlocked opportunity (the next step's own title/
   * outcome, no invented text)." `null` only when there is no next step
   * (the plan's current step is its last, or the plan has no current step
   * at all e.g. already `completed`) — `get_current_step`'s own
   * `next === null` cases (AD-4: this reuses that same read, never a second
   * steps-reading path).
   */
  unlockedOpportunity: unlockedOpportunitySchema.nullable(),
});

export type ProjectionData = z.infer<typeof projectionDataSchema>;

export const projectionResponseSchema = projectionDataSchema.extend({
  currency: currencyCodeSchema,
});

export type ProjectionResponse = z.infer<typeof projectionResponseSchema>;
