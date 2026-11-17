import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Story 2.2 (AD-6/AD-13/AD-27): one row per generated idea. `userId` is a
 * non-unique FK — unlike `intake`/`userSettings`'s one-row-per-user shape, a
 * user accumulates many ideas over time (Story 2.4 adds further batches).
 * `status`/`weeklyTimeCommitment`/`riskLevel` stay plain `text()` (no
 * `pgEnum`/check constraint — same precedent as `intake.failurePattern`),
 * validated only at the Zod layer (`shared/schemas/ideas.ts`).
 *
 * Money columns are integer minor units + a separate currency-code column,
 * never a float (AD-27). `startupCost*` is always `'EUR'` (Design Notes in
 * `shared/schemas/ideas.ts`'s `ideaDraftSchema` comment: the intake form's
 * budget buckets are themselves EUR-denominated). `baselineRate*` is
 * whatever currency `web_search` sourced it in, persisted once and never
 * re-fetched or altered (AD-6).
 *
 * `citedIntakeFields` (Story 2.2 follow-up fix round 1, fix 3): a Postgres
 * text array of `shared/schemas/ideas.ts`'s `citedIntakeFieldSchema`
 * tokens — structured, separate from `rationale`'s own prose, so the
 * ">=3 distinct fields" AC is checked against this column, never by
 * scanning the rationale text for intake values/field names (which the
 * rationale must never contain).
 *
 * `ideaType` (follow-up round 2, fix 3): plain `text()`, same no-`pgEnum`
 * precedent as `status`/`riskLevel` — the >=3-distinct-types-per-batch AC
 * is a cross-draft check, enforced in `generate_ideas.ts`, not at this
 * single-row schema level.
 *
 * Rate-grounding columns (follow-up round 4, fix 4): `baselineRateAmount*`
 * is now `baselineRateLow`/`HighAmountMinorUnits` — equal for the common
 * single-number case, a genuine range only when `isVendorSource` is true
 * (`shared/schemas/ideas.ts`'s cross-field refine enforces this before any
 * row reaches this table). `baselineRateQuote` is the exact sentence the
 * model cited the rate from, kept for provenance; `rateUnit` is plain
 * `text()`, same no-`pgEnum` precedent as the other enum-shaped columns.
 *
 * Source-trust columns (follow-up round 6, fix 6): `sourceTrustTier` is a
 * deterministic classification of the citation's *domain* (never the
 * model's own say-so — `generate_ideas.ts`'s `classifyDomainTrustTier`),
 * plain `text()` for the same no-`pgEnum` reason as the other enum-shaped
 * columns above; a tier-4 source is rejected before any row reaches this
 * table, so only `'tier_1'`/`'tier_2'`/`'tier_3'` are ever stored.
 * `isRateUnverified` is true only for a tier-3 source with no corroborating
 * second source (`generate_ideas.ts`'s `hasCorroboratingSource`) — the idea
 * is still persisted, just labeled, never rejected for that reason alone.
 */
export const ideas = pgTable('ideas', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull().default('suggested'),
  title: text('title').notNull(),
  rationale: text('rationale').notNull(),
  citedIntakeFields: text('cited_intake_fields').array().notNull(),
  ideaType: text('idea_type').notNull(),
  weeklyTimeCommitment: text('weekly_time_commitment').notNull(),
  startupCostAmountMinorUnits: integer('startup_cost_amount_minor_units').notNull(),
  startupCostCurrency: text('startup_cost_currency').notNull(),
  riskLevel: text('risk_level').notNull(),
  baselineRateQuote: text('baseline_rate_quote').notNull(),
  baselineRateLowAmountMinorUnits: integer('baseline_rate_low_amount_minor_units').notNull(),
  baselineRateHighAmountMinorUnits: integer('baseline_rate_high_amount_minor_units').notNull(),
  isVendorSource: boolean('is_vendor_source').notNull(),
  rateUnit: text('rate_unit').notNull(),
  baselineRateCurrency: text('baseline_rate_currency').notNull(),
  baselineRateCitation: text('baseline_rate_citation').notNull(),
  sourceTrustTier: text('source_trust_tier').notNull(),
  isRateUnverified: boolean('is_rate_unverified').notNull(),
  /**
   * Story 2.5 (AC: demand/trend evidence + growth path). Nullable, unlike
   * every column above — Lane A's frozen `src/api/routes/ideas.test.ts`
   * fixture rows insert without these columns at all, and that file is
   * off-limits to this story, so a `NOT NULL` (with no sensible default for
   * free text) would break it. `generate_ideas.ts`'s own write path always
   * populates all four for a real generation; only a row inserted outside
   * that path (like those test fixtures) ever has them `null`.
   */
  demandEvidenceNote: text('demand_evidence_note'),
  demandEvidenceCitation: text('demand_evidence_citation'),
  demandEvidenceQuote: text('demand_evidence_quote'),
  isDemandEvidenceUnverified: boolean('is_demand_evidence_unverified').notNull().default(false),
  growthPath: text('growth_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
