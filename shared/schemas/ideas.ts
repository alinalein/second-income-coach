import { z } from 'zod';
import { weeklyTimeAvailabilitySchema, riskToleranceSchema } from './intake.js';
import { moneySchema, currencyCodeSchema } from '../money.js';

/**
 * AD-13: idea lifecycle — `suggested` (one of the 5 this story produces) ->
 * `selected` | `bookmarked` | `rejected` (Story 2.3's transitions). Defined
 * with all 4 values now, not just `suggested`, so the shared enum (AD-16's
 * lockstep requirement) never needs a later migration to add the other 3.
 */
export const ideaStatusSchema = z.enum(['suggested', 'selected', 'bookmarked', 'rejected']);

export type IdeaStatus = z.infer<typeof ideaStatusSchema>;

/**
 * Story 2.7: extracted from `generateIdeasToolSchema`'s own inline
 * `replyLanguage` field (previously defined only there) so it can also be
 * the language stored per idea (`ideaResponseSchema.language` below) and
 * the one `translateIdeasRequestSchema`/`translateIdeasResponseSchema`
 * (`shared/schemas/idea-translations.ts`) validate against — one shared
 * enum, never hand-copied (AD-16).
 */
export const replyLanguageSchema = z.enum(['en', 'de']);

export type ReplyLanguage = z.infer<typeof replyLanguageSchema>;

/**
 * Story 2.2 follow-up fix 3: the intake fields a rationale is allowed to
 * cite, as structured ids — not the rationale's own prose. Keeps the
 * ">=3 distinct fields" check (AC) a deterministic Zod rule instead of a
 * fragile substring match against free-text the model wrote, and keeps
 * which fields were cited visible on the card (translated labels) without
 * ever exposing a raw enum token (`under_5h`, `riskTolerance`, etc.) in
 * user-facing prose.
 */
export const citedIntakeFieldSchema = z.enum([
  'skillsInterests',
  'weeklyTimeAvailability',
  'startingBudgetRange',
  'riskTolerance',
  'stoppedBeforeText',
  'failurePattern',
]);

export type CitedIntakeField = z.infer<typeof citedIntakeFieldSchema>;

const MIN_CITED_INTAKE_FIELDS = 3;

const citedIntakeFieldsSchema = z
  .array(citedIntakeFieldSchema)
  .min(MIN_CITED_INTAKE_FIELDS)
  .refine((fields) => new Set(fields).size === fields.length, {
    message: `citedIntakeFields must list >=${MIN_CITED_INTAKE_FIELDS} *distinct* fields, not repeats`,
  });

/**
 * Story 2.2 follow-up fix round 2, fix 3: a structured category per idea —
 * variety (>=3 distinct types across one batch of 5) is enforced in
 * `src/tools/llm/generate_ideas.ts`'s `batchIsValid` (a cross-draft check
 * Zod alone can't express), not here. `resale_arbitrage`/`teaching_coaching`
 * are each one combined category, not two.
 */
export const ideaTypeSchema = z.enum(['service', 'digital_product', 'content', 'resale_arbitrage', 'teaching_coaching', 'other']);

export type IdeaType = z.infer<typeof ideaTypeSchema>;

/**
 * Story 2.2 follow-up fix round 4, fix 3: 2-3 short bullet points (why it
 * fits / a concrete first step / an optional honest caveat — enforced by
 * the nested-agent prompt, not this shape-only schema), persisted as
 * newline-separated lines within the one `rationale` string column (no
 * migration for this field). This is the *persisted/response* shape only —
 * what `generate_ideas.ts` joins the model's own array output (
 * `ideaDraftRationaleSchema` below) into before the DB write, and what the
 * UI splits back on `\n` to render as a list. Shape: 2-3 non-empty lines,
 * each <=140 chars. "Plain language, no raw field names" is still
 * `containsRawIntakeTokens` in `generate_ideas.ts` — that check already
 * scans the whole string regardless of embedded newlines.
 */
const RATIONALE_MIN_LINES = 2;
const RATIONALE_MAX_LINES = 3;
/** Exported (round 10) so `generate_ideas.ts`'s `truncateAtWordBoundary`
 * corrects against the exact same limit this schema enforces — one source
 * of truth, never two numbers that could drift apart. */
export const RATIONALE_LINE_MAX_LENGTH = 140;

export const rationaleSchema = z.string().max(2000).refine(
  (value) => {
    const lines = value.split('\n');
    if (lines.length < RATIONALE_MIN_LINES || lines.length > RATIONALE_MAX_LINES) return false;
    return lines.every((line) => line.trim().length > 0 && line.length <= RATIONALE_LINE_MAX_LENGTH);
  },
  {
    message: `rationale must be ${RATIONALE_MIN_LINES}-${RATIONALE_MAX_LINES} newline-separated, non-empty lines, each <=${RATIONALE_LINE_MAX_LENGTH} chars`,
  },
);

/**
 * Story 2.2 round 10 (bug fix, user-approved): what the nested LLM itself
 * must produce for `rationale` — an *array* of 2-3 short strings, not one
 * string with embedded newlines. A real live run (round 9's Step 1
 * diagnosis) showed the model reliably failing to produce a correctly
 * newline-shaped single string via structured output; a plain JSON array of
 * short strings is a far more reliable shape for a model to get right.
 * `generate_ideas.ts`'s `handleGenerateIdeas` joins this array with `\n`
 * into the existing `rationale` column on save (validated by
 * `rationaleSchema` above at that point) — no migration, no change to what
 * `GET /api/ideas`/`POST /api/ideas/generate` return. A bullet over
 * `RATIONALE_LINE_MAX_LENGTH` is deterministically shortened at a word
 * boundary (`generate_ideas.ts`'s `truncateAtWordBoundary`) before this
 * schema ever sees it, so the length check here is a backstop, not the
 * normal path to a validation failure.
 */
export const rationaleBulletSchema = z.string().trim().min(1).max(RATIONALE_LINE_MAX_LENGTH);

export const ideaDraftRationaleSchema = z.array(rationaleBulletSchema).min(RATIONALE_MIN_LINES).max(RATIONALE_MAX_LINES);

/**
 * Story 2.2 follow-up fix round 4, fix 4: how a baseline rate is
 * denominated — "hour" is the only unit `computeMonthlyPotential`
 * (`IdeasPanel.tsx`) can meaningfully project from; "project"/"month"
 * rates are shown as-is with no monthly-potential figure at all.
 */
export const rateUnitSchema = z.enum(['hour', 'project', 'month']);

export type RateUnit = z.infer<typeof rateUnitSchema>;

/**
 * Story 2.2 follow-up fix round 6, fix 6: a deterministic classification of
 * the baseline rate's *source domain* (AC: "a baseline rate must be
 * grounded, not guessed") — computed in `generate_ideas.ts`'s
 * `classifyDomainTrustTier`, never self-reported by the model.
 *
 * Round 10 (bug fix, user-approved): `tier_4` is now a real, persistable
 * value — round 9's degraded-acceptance path (the final attempt only,
 * `generate_ideas.ts`'s `evaluateSourceTrustForAttempt`) previously stored
 * a `tier_4` source as `tier_3` because this schema had no `tier_4` value
 * to persist, silently overstating its trust level. That's fixed: a
 * `tier_4` source accepted via degradation is now stored as the real
 * `tier_4`, always with `isRateUnverified: true` — never collapsed into a
 * higher-looking tier. Tier 1-3 sources are unaffected (`tier_4` is still
 * rejected outright on every attempt but the last).
 */
export const sourceTrustTierSchema = z.enum(['tier_1', 'tier_2', 'tier_3', 'tier_4']);

export type SourceTrustTier = z.infer<typeof sourceTrustTierSchema>;

/**
 * Story 2.2 follow-up fix round 4, fix 4: cross-field rate-grounding
 * invariants that need more than one field at once — applied via
 * `.superRefine` below, since Zod's per-field schemas can't express them.
 * `baselineRateQuote` itself (the exact sentence the model must copy
 * verbatim from the search result it sourced the rate from) is validated
 * for *shape* only here — `generate_ideas.ts`'s `quoteMatchesSearchResults`/
 * `quoteSupportsRate` are what actually verify it against the real
 * retrieved search text, data this schema doesn't have. `isVendorSource`
 * is a model self-assessment (not deterministically derivable from the
 * citation text alone — unlike the separate, fully deterministic "is this
 * a software/subscription pricing page at all" rejection in
 * `generate_ideas.ts`, which excludes such sources entirely rather than
 * merely flagging them); it gates whether `baselineRateLow`/
 * `HighAmountMinorUnits` may legitimately differ (a genuine range) or must
 * be the same single number.
 */
function checkBaselineRateInvariants(
  value: { baselineRateLowAmountMinorUnits: number; baselineRateHighAmountMinorUnits: number; isVendorSource: boolean },
  ctx: z.RefinementCtx,
): void {
  if (value.baselineRateHighAmountMinorUnits < value.baselineRateLowAmountMinorUnits) {
    ctx.addIssue({
      code: 'custom',
      path: ['baselineRateHighAmountMinorUnits'],
      message: 'baselineRateHighAmountMinorUnits must be >= baselineRateLowAmountMinorUnits',
    });
  }
  if (!value.isVendorSource && value.baselineRateLowAmountMinorUnits !== value.baselineRateHighAmountMinorUnits) {
    ctx.addIssue({
      code: 'custom',
      path: ['isVendorSource'],
      message: 'a non-vendor source must report a single number (low === high), not a range',
    });
  }
}

/**
 * One idea draft, as `generate_ideas`'s nested LLM must produce it. Never
 * exceeding intake's limits still can't be expressed as a Zod rule (a
 * cross-record check against the intake row — Design Notes: enforced by
 * plain TS in `src/tools/llm/generate_ideas.ts`), but citation count/
 * distinctness now is one, via `citedIntakeFields` above.
 *
 * `weeklyTimeCommitment`/`riskLevel` reuse intake's own enum tokens
 * (Boundary) so a same-ordinal comparison against the intake record is
 * enough to enforce "never exceeds". `startupCostAmountMinorUnits` is
 * always EUR minor units (not a `Money`) — the intake form's budget-range
 * buckets are themselves EUR-denominated (`shared/schemas/intake.ts`'s
 * `startingBudgetRange` options map to the same `€100`/`€500`/`€2,000`
 * labels shown in `web/src/locales/<lang>/intake.json`), so the budget-ceiling
 * check in `src/tools/llm/generate_ideas.ts` stays a same-currency integer
 * comparison, never a conversion. `baselineRateCurrency` is free-form
 * (AD-6: persisted once in whatever currency `web_search` sourced it in).
 */
/**
 * Story 2.5: the model's own demand/trend evidence note for this idea — a
 * single short sentence (not the 2-3 bullets `rationale` uses), translated
 * into the reply language like every other free-text draft field. Shape
 * only; `generate_ideas.ts`'s `quoteMatchesSearchResults`/
 * `sourceEvidenceLooksBlockedOrHidden` verify `demandEvidenceQuote` against
 * the real retrieved discovery-search text the same way `baselineRateQuote`
 * is verified.
 */
export const DEMAND_EVIDENCE_NOTE_MAX_LENGTH = 200;

/** Story 2.5: the translated "how this can grow" note (AC/FR15/AD-25) — one
 * short sentence, same shape precedent as `demandEvidenceNote`. */
export const GROWTH_PATH_MAX_LENGTH = 220;

export const ideaDraftSchema = z
  .object({
    title: z.string().min(1).max(200),
    rationale: ideaDraftRationaleSchema,
    citedIntakeFields: citedIntakeFieldsSchema,
    ideaType: ideaTypeSchema,
    weeklyTimeCommitment: weeklyTimeAvailabilitySchema,
    startupCostAmountMinorUnits: z.number().int().nonnegative(),
    riskLevel: riskToleranceSchema,
    baselineRateCurrency: currencyCodeSchema,
    baselineRateCitation: z.string().min(1).max(500),
    baselineRateQuote: z.string().min(1).max(300),
    baselineRateLowAmountMinorUnits: z.number().int().nonnegative(),
    baselineRateHighAmountMinorUnits: z.number().int().nonnegative(),
    isVendorSource: z.boolean(),
    rateUnit: rateUnitSchema,
    demandEvidenceNote: z.string().trim().min(1).max(DEMAND_EVIDENCE_NOTE_MAX_LENGTH),
    demandEvidenceCitation: z.string().min(1).max(500),
    demandEvidenceQuote: z.string().min(1).max(300),
    growthPath: z.string().trim().min(1).max(GROWTH_PATH_MAX_LENGTH),
  })
  .superRefine(checkBaselineRateInvariants);

export type IdeaDraft = z.infer<typeof ideaDraftSchema>;

/** The nested LLM's full structured-output shape (`createAgent`'s
 * `responseFormat`) — 1-5 drafts; the exact configured batch size
 * (`IDEAS_PER_BATCH`, `src/config/env.ts`) is enforced at runtime by
 * `generate_ideas.ts`'s own `buildDraftsSchema`, not by this shared range
 * schema. */
export const generateIdeasDraftsSchema = z.object({
  ideas: z.array(ideaDraftSchema).min(1).max(5),
});

export type GenerateIdeasDrafts = z.infer<typeof generateIdeasDraftsSchema>;

/** The persisted/response shape — one row of the `ideas` table, as returned
 * by both `GET /api/ideas` and `POST /api/ideas/generate`. Money fields are
 * the raw stored value + currency (Boundary: "returns raw minor-units +
 * currency as stored" — conversion happens client-side via `shared/money.ts`).
 * `baselineRateLow`/`High` are both always present (equal, for the common
 * non-vendor single-number case); `isVendorSource` is what tells the card
 * whether to render a range.
 *
 * Story 2.2 follow-up fix round 6, fix 6: `baselineRateQuote` is now
 * exposed here too — the AC requires the exact quoted sentence shown
 * directly on the card (short, never behind an expansion), not just kept
 * internally for grounding verification. `sourceTrustTier`/
 * `isRateUnverified` are the new source-trust fields, also shown on the
 * card next to the citation. */
export const ideaResponseSchema = z
  .object({
    id: z.string().min(1),
    status: ideaStatusSchema,
    title: z.string().min(1),
    rationale: rationaleSchema,
    citedIntakeFields: citedIntakeFieldsSchema,
    ideaType: ideaTypeSchema,
    weeklyTimeCommitment: weeklyTimeAvailabilitySchema,
    startupCost: moneySchema,
    riskLevel: riskToleranceSchema,
    baselineRateLow: moneySchema,
    baselineRateHigh: moneySchema,
    isVendorSource: z.boolean(),
    rateUnit: rateUnitSchema,
    baselineRateCitation: z.string().min(1),
    baselineRateQuote: z.string().min(1).max(300),
    sourceTrustTier: sourceTrustTierSchema,
    isRateUnverified: z.boolean(),
    /**
     * Story 2.5: nullable, unlike every new draft-schema field above — a
     * row inserted outside this story's `generate_ideas` path (e.g. Lane
     * A's `src/api/routes/ideas.test.ts` fixtures, frozen/off-limits to
     * this story) has no value for these columns at all. `IdeaEvidence.tsx`
     * renders nothing for a `null` value rather than treating it as a
     * validation failure.
     */
    demandEvidenceNote: z.string().min(1).max(DEMAND_EVIDENCE_NOTE_MAX_LENGTH).nullable(),
    demandEvidenceCitation: z.string().min(1).nullable(),
    demandEvidenceQuote: z.string().min(1).max(300).nullable(),
    isDemandEvidenceUnverified: z.boolean(),
    growthPath: z.string().min(1).max(GROWTH_PATH_MAX_LENGTH).nullable(),
    /**
     * Story 2.7: the language this idea's text fields were originally
     * generated/written in — never nullable (the DB column defaults to
     * `'en'` for a pre-Story-2.7 row, its own real write language in every
     * case so far). Drives `IdeasPanel.tsx`'s own "does this card need
     * translating for the current UI language" check.
     */
    language: replyLanguageSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((value, ctx) =>
    checkBaselineRateInvariants(
      {
        baselineRateLowAmountMinorUnits: value.baselineRateLow.amountMinorUnits,
        baselineRateHighAmountMinorUnits: value.baselineRateHigh.amountMinorUnits,
        isVendorSource: value.isVendorSource,
      },
      ctx,
    ),
  );

export type IdeaResponse = z.infer<typeof ideaResponseSchema>;

/**
 * `generate_ideas`'s own tool-call schema — `replyLanguage` only (Boundary:
 * "No `excludeIds`/already-seen-exclusion field on the schema yet — that's
 * Story 2.4's addition"). Same precedent as `submit_intake.failurePattern`
 * (AD-4): the model supplies it from its own reasoning, never the client.
 */
export const generateIdeasToolSchema = z.object({
  replyLanguage: replyLanguageSchema,
});

export type GenerateIdeasToolArgs = z.infer<typeof generateIdeasToolSchema>;

/** Shared response shape for both `GET /api/ideas` and `POST
 * /api/ideas/generate` — the caller's ideas plus their `userSettings.currency`
 * (AD-27), so the frontend can convert/format every amount consistently. */
export const ideasResponseSchema = z.object({
  ideas: z.array(ideaResponseSchema),
  currency: currencyCodeSchema,
});

export type IdeasResponse = z.infer<typeof ideasResponseSchema>;

/**
 * Story 2.8 AC5: `ideaResponseSchema` extended with a derived, read-only
 * `hasPlan` flag (computed server-side in `src/api/routes/ideas.ts` via a
 * join against the `plans` table — no migration, no change to
 * `generate_ideas.ts`/`create_plan`). `.default(false)` keeps every
 * existing fixture/response that omits the field parseable, since
 * `ideaResponseSchema` itself stays untouched (Boundary).
 */
export const ideaWithPlanResponseSchema = ideaResponseSchema.extend({ hasPlan: z.boolean().default(false) });

export type IdeaWithPlanResponse = z.infer<typeof ideaWithPlanResponseSchema>;

/**
 * Story 2.11 (AC5/AC6/AC7): why a blocked "generate" is blocked — a per-user
 * daily generation limit, or the app-wide shared daily search budget. Both
 * are worded as a plain limit on the client (never an error), with
 * `resetsAt` telling the user exactly when it reopens.
 */
export const generateLimitReasonSchema = z.enum(['user_limit', 'shared_budget']);

export type GenerateLimitReason = z.infer<typeof generateLimitReasonSchema>;

export const generateLimitStatusSchema = z.object({
  blocked: z.boolean(),
  reason: generateLimitReasonSchema.nullable(),
  /** The per-user daily cap itself — only meaningful when `reason` is
   * `'user_limit'`; the client needs the number to render "today's limit of
   * N idea generations". */
  limit: z.number().int().positive().nullable(),
  /** UTC midnight of the next day — when the counters this is based on
   * reset (Boundary: "reset at a fixed time"). `null` when not blocked. */
  resetsAt: z.iso.datetime().nullable(),
});

export type GenerateLimitStatus = z.infer<typeof generateLimitStatusSchema>;

/** Story 2.8: the `hasPlan`-carrying counterpart to `ideasResponseSchema`,
 * returned by `GET /api/ideas` and `POST /api/ideas/generate`. Story 2.11
 * adds `generateLimit` so the client can disable the generate button
 * proactively, before the user ever clicks it. `.default(...)` (same
 * precedent as `hasPlan` above) keeps every existing fixture/response that
 * omits the field parseable — the server always sends the real computed
 * status; only a test fixture that doesn't care about limits omits it,
 * safely defaulting to "not blocked". */
export const ideasWithPlanResponseSchema = z.object({
  ideas: z.array(ideaWithPlanResponseSchema),
  currency: currencyCodeSchema,
  generateLimit: generateLimitStatusSchema.default({ blocked: false, reason: null, limit: null, resetsAt: null }),
});

export type IdeasWithPlanResponse = z.infer<typeof ideasWithPlanResponseSchema>;
