import * as React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ideasWithPlanResponseSchema,
  generateLimitStatusSchema,
  translateIdeasResponseSchema,
  convertMoney,
  formatMoney,
  type IdeaResponse,
  type IdeaWithPlanResponse,
  type IdeaTranslation,
  type IdeaStatus,
  type CurrencyCode,
  type WeeklyTimeAvailability,
  type Money,
  type GenerateLimitStatus,
  type CountryCode,
} from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from 'shadcn-glass-ui';
import { IdeaEvidence, foreignSourceRegion, useViewerCountry, hasDemandEvidence, TranslatingBlock } from './IdeaEvidence';

/**
 * Story 2.2 follow-up fix round 2, fix 2 (amended round 4, fix 4d): "potential
 * per month" — a deterministic, client-only estimate (no new column, no model
 * call): the weekly-time *bucket's own upper bound* (not the idea's chosen
 * commitment — this is the maximum at full use of the time budget, per the
 * request) times the idea's own already-sourced *low* baseline rate, times
 * the standard weeks-per-month constant (4.3 ≈ 52/12). `20h_plus` has no
 * true upper bound; 20 (its own anchor value) is used as a deliberate,
 * documented cap for this estimate only — it does not change any other
 * check. Round 4, fix 4(d): only meaningful for an hourly rate — `undefined`
 * for "project"/"month" rates, so `IdeaCard` omits the row entirely; capped
 * at `MONTHLY_POTENTIAL_CAP_MINOR_UNITS` (a deliberately generous but
 * plausible ceiling for a *second* income) so an unusually high sourced rate
 * never produces an implausible headline number — still always labeled
 * "estimate" either way.
 */
const WEEKLY_HOURS_CAP: Record<WeeklyTimeAvailability, number> = {
  under_5h: 5,
  '5_to_10h': 10,
  '10_to_20h': 20,
  '20h_plus': 20,
};
const WEEKS_PER_MONTH = 4.3;
const MONTHLY_POTENTIAL_CAP_MINOR_UNITS = 50_000_00; // 50,000.00 (EUR or USD — same order of magnitude)

function computeMonthlyPotential(idea: IdeaResponse): Money | undefined {
  if (idea.rateUnit !== 'hour') return undefined;
  const hoursCap = WEEKLY_HOURS_CAP[idea.weeklyTimeCommitment];
  // Money stays integer minor units (AD-27) — round once, at the end.
  const rawAmountMinorUnits = Math.round(hoursCap * idea.baselineRateLow.amountMinorUnits * WEEKS_PER_MONTH);
  return {
    amountMinorUnits: Math.min(rawAmountMinorUnits, MONTHLY_POTENTIAL_CAP_MINOR_UNITS),
    currencyCode: idea.baselineRateLow.currencyCode,
  };
}

/** Story 2.2 follow-up fix 1: the server's own ideas-specific node timeout
 * is `IDEAS_MODEL_NODE_TIMEOUT_MS` (`src/agent/resilience.ts`) — this must
 * stay longer than that server budget so the client never gives up on a
 * request the server would have finished. Round 8 (bug fix, found live):
 * raised alongside the server's own 90s->170s recalibration (see that
 * constant's doc comment — post-quality-fixes generation legitimately takes
 * longer than originally measured).
 *
 * Story 2.5 (bug fix, found live by the user, user-approved — numeric
 * constant only, no layout/button/status code touched, per this story's own
 * scope boundary on this file): raised alongside the server's own
 * 170s->230s recalibration (`src/agent/resilience.ts`'s
 * `IDEAS_MODEL_NODE_TIMEOUT_MS` doc comment has the measured evidence). */
const GENERATE_TIMEOUT_MS = 250_000;

/** Round 13 (user-requested): `'load-error'`/`'generate-error'` replace the
 * old single `'error'` phase, which picked its message from `ideas.length`
 * — wrong whenever a *regenerate* failed with ideas already on screen (it
 * showed "couldn't load" instead of "generation failed"). Each failure now
 * sets the phase for the operation that actually failed, so the message is
 * always correct regardless of what was on screen already. */
type Phase = 'loading' | 'idle' | 'generating' | 'load-error' | 'generate-error';

/** Story 2.3 AC1/AC2/AC3: the 3 statuses a card's own 3 actions can set —
 * `suggested` is the initial value only, never something the user picks
 * directly. Derived from `@app/shared`'s own `IdeaStatus` (not a separate
 * hand-written literal union) so it can never drift from that shared enum;
 * mirrors `src/tools/plain/set_idea_status.ts`'s own local
 * `settableIdeaStatusSchema` (intentionally not shared, per Boundary), which
 * enumerates the same 3 values by hand on the server side. */
type SettableStatus = Exclude<IdeaStatus, 'suggested'>;

/**
 * Story 2.3 AC1: mirrors `setIdeaStatus`'s own server-side transaction rules
 * exactly, so the optimistic update never has to be reconciled against a
 * response body (the route returns `204 No Content` on success) — a
 * `rejected` idea disappears immediately (same as a reload, since `GET /`
 * excludes it), a `selected` idea demotes every other non-`rejected` idea to
 * `bookmarked`, and `bookmarked` only ever touches the one target row.
 */
function applyOptimisticIdeaStatus(current: IdeaWithPlanResponse[], ideaId: string, status: SettableStatus): IdeaWithPlanResponse[] {
  if (status === 'rejected') {
    return current.filter((idea) => idea.id !== ideaId);
  }
  if (status === 'selected') {
    return current.map((idea) => {
      if (idea.id === ideaId) return { ...idea, status: 'selected' };
      // A rejected idea is never resurrected by someone else being selected
      // — in practice unreachable client-side (a rejected idea is already
      // removed from this array the moment it's rejected), kept only as a
      // defensive mirror of the server's own rule. An already-`bookmarked`
      // idea is left as the exact same object too (user-reported bug fix:
      // re-selecting after switching away and back previously still "swept"
      // every already-bookmarked sibling, flickering their buttons for a
      // write that changed nothing).
      if (idea.status === 'rejected' || idea.status === 'bookmarked') return idea;
      return { ...idea, status: 'bookmarked' };
    });
  }
  return current.map((idea) => (idea.id === ideaId ? { ...idea, status } : idea));
}

/** Which ids a given status change actually *changes* — `selected` sweeps
 * every other idea that isn't already `rejected` or already `bookmarked`
 * (an already-`bookmarked` sibling has nothing to change, so it's excluded:
 * user-reported bug fix, see `applyOptimisticIdeaStatus`); `bookmarked`/
 * `rejected` only ever touch the one target id. Used to scope both the
 * pending-disabled set and the failure-revert to exactly what this one
 * action changes, so a second, unrelated card's own in-flight action is
 * never disabled or reverted by this one, and an unaffected sibling's
 * buttons never flicker for a no-op write. */
function affectedIdeaIds(current: IdeaWithPlanResponse[], ideaId: string, status: SettableStatus): string[] {
  if (status !== 'selected') return [ideaId];
  return current
    .filter((idea) => idea.id === ideaId || (idea.status !== 'rejected' && idea.status !== 'bookmarked'))
    .map((idea) => idea.id);
}

/** The inverse of `applyOptimisticIdeaStatus`, scoped to exactly the ids a
 * `priorById` snapshot covers: restores each one to its prior value in
 * place, and re-inserts any that were optimistically removed (a `rejected`
 * action), re-sorted by `createdAt` to match the server's own ordering. Ids
 * not in `priorById` (a different, still-in-flight or since-completed
 * action) are left untouched. */
function revertOptimisticIdeaStatus(
  current: IdeaWithPlanResponse[],
  priorById: Map<string, IdeaWithPlanResponse>,
): IdeaWithPlanResponse[] {
  const presentIds = new Set(current.map((idea) => idea.id));
  const restored = current.map((idea) => priorById.get(idea.id) ?? idea);
  const reinserted = [...priorById.values()].filter((idea) => !presentIds.has(idea.id));
  if (reinserted.length === 0) return restored;
  return [...restored, ...reinserted].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Fix1: a neutral, fixed-height placeholder shown while the first `GET
 * /api/ideas` is in flight — replaces the old plain loading text, which
 * (mutually exclusive with the "no ideas yet" empty state in the code, but
 * not always fast enough to avoid a ~0.2s flash of it) let that empty-state
 * text show through for an instant on first load. Reserves real height (not
 * guessed against the real card grid — just enough to avoid a layout jump)
 * regardless of how long the request takes. The pulsing placeholder boxes
 * are decorative (`aria-hidden`), but the wrapper itself is `role="status"`
 * + `aria-live="polite"` with a visually-hidden (`sr-only`) `t('loading')`
 * text, so a screen-reader user still gets the same announcement the old
 * plain-text line gave them.
 *
 * Bug fix (user-reported, live): `decorative` (default false) drops that
 * own `role="status"`/`aria-live`/`sr-only` text entirely — used when this
 * renders purely to give the "Generating…" dialog's own backdrop-blur real
 * boxes to soften (first-ever auto-generate, nothing else behind it). The
 * Dialog already has its own `role="status"` announcing the real stage
 * text, and two live `status` regions on screen at once is both redundant
 * and breaks `getByRole('status')` uniqueness.
 *
 * Bug fix (user-reported, live, round 2): `decorative` boxes are outlined
 * (`border border-border`), not filled — a crisp edge is what the dialog's
 * own `backdrop-filter: blur()` visibly softens (the actual "glass" cue); a
 * flat `var(--blob)` fill across a 256px box read as one large saturated
 * rectangle instead, and its `animate-pulse` was distracting ("too much
 * animation in the background"). Two small, individually blurred circles
 * (`filter: blur(60px)` on themselves, `overflow-hidden` on the grid
 * wrapper so they can never grow past it) give the color/contrast instead —
 * `index.css`'s own page-level blob decoration's exact recipe, soft/diffuse
 * by construction. `bg-muted` (kept, unchanged, for the non-`decorative`
 * real loading case) was separately found live to be nearly invisible
 * against this page's own background — `index.css`'s own blob decoration
 * exists for exactly this reason (`--muted`/`--page-a`/`--page-b` are all
 * near-identical pale tones) — but that's not relevant here, since
 * `decorative` boxes don't rely on their own fill color for contrast. */
function IdeasSkeleton({ loadingLabel, decorative = false }: { loadingLabel: string; decorative?: boolean }) {
  return (
    <div
      role={decorative ? undefined : 'status'}
      aria-live={decorative ? undefined : 'polite'}
      aria-hidden={decorative || undefined}
      className={`relative grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${decorative ? 'overflow-hidden' : ''}`}
    >
      {decorative ? null : <span className="sr-only">{loadingLabel}</span>}
      {decorative ? (
        <>
          <div
            aria-hidden="true"
            className="absolute rounded-full"
            style={{ width: 200, height: 200, top: -30, left: 40, background: 'var(--blob)', opacity: 'var(--blob-opacity)', filter: 'blur(60px)' }}
          />
          <div
            aria-hidden="true"
            className="absolute rounded-full"
            style={{
              width: 200,
              height: 200,
              bottom: -30,
              right: 60,
              background: 'var(--blob)',
              opacity: 'var(--blob-opacity)',
              filter: 'blur(60px)',
            }}
          />
        </>
      ) : null}
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          aria-hidden="true"
          className={`relative h-64 rounded-lg ${decorative ? 'border border-border' : 'animate-pulse bg-muted'}`}
        />
      ))}
    </div>
  );
}

/** AD-24/AD-27: "locale and currency are independent axes" — the active
 * i18n language ('en'/'de') maps to the locale `Intl.NumberFormat` needs.
 * No dedicated UI-language-to-locale layer exists yet (Story 5.4), so this
 * is the minimal mapping this story needs. */
const LOCALE_BY_LANGUAGE: Record<string, string> = { en: 'en-US', de: 'de-DE' };

/** Story 2.7: the `translations` cache's own key — one cached translation
 * per idea *and* language, mirroring the server's `idea_translations`
 * table's own `(idea_id, language)` uniqueness. */
function translationKey(ideaId: string, language: string): string {
  return `${ideaId}:${language}`;
}

/**
 * Story 2.2 follow-up fix round 2, fix 1: a time-based *determinate* bar —
 * originally measured against real `generate_ideas` runs landing at ~23.5s
 * and ~33.3s. Round 8 (bug fix, found live): round 4-6's grounding/quality
 * checks made a successful run substantially slower since then — a real
 * post-quality-fixes run now measures ~56s (the user's own report: 18s
 * planning + 30s writing + 8s parallel search). `TYPICAL_GENERATE_DURATION_MS`
 * updated to that realistic figure so the bar's pacing toward 90% actually
 * reflects a normal run again, rather than claiming "almost done" at ~28s
 * into one that routinely takes twice that. The bar fills linearly toward
 * 90% over that duration, holds at 90% for any run that takes longer (never
 * claims "almost done" past that point without actually knowing), and the
 * caller forces it to 100% the instant the request settles (success or
 * failure).
 *
 * Story 2.5 (bug fix, found live by the user, user-approved — numeric
 * constant only): the extra required search per idea pushed real attempts
 * well past this old pacing figure (one live attempt measured ~74s before
 * even being rejected on an unrelated check). Scaled proportionally with
 * `DRAFT_ATTEMPT_TIMEOUT_MS`'s own 75s->110s raise (56s * 110/75 ≈ 82s,
 * rounded) — an estimate, not a fresh measurement of a clean successful
 * run, since none was available in this environment.
 *
 * Story 2.6 (speed rounds 2/3, bug fix): the backend's per-idea parallel
 * pipeline (no more nested ReAct search loop) now measures 20-45s for a
 * typical successful run, not 56-82s — this constant was stale from the
 * slow era, so the bar sat at roughly half when the ideas actually
 * appeared. Updated to 35s, the middle of the newly measured range.
 */
const TYPICAL_GENERATE_DURATION_MS = 35_000;
const PROGRESS_HOLD_PERCENT = 90;
const PROGRESS_TICK_MS = 300;

/**
 * Spec 2.12 AC1: only the auto-generate path (fired right after a user's
 * first-ever intake save, `autoGenerate` prop — `App.tsx`) shows a
 * classify->generate stage-text split; manual generate/regenerate keeps
 * `TYPICAL_GENERATE_DURATION_MS` and the one existing stage text, unchanged
 * (I/O matrix: "AC1 manual generate"). `AUTO_GENERATE_CLASSIFY_DURATION_MS`
 * is a rough estimate for the server's own intake-classification step
 * (unmeasured — no dedicated timing instrumentation exists for it yet);
 * `AUTO_GENERATE_TOTAL_DURATION_MS` is the combined bar duration so the one
 * timer still carries through both stages without resetting.
 */
const AUTO_GENERATE_CLASSIFY_DURATION_MS = 3_000;
const AUTO_GENERATE_TOTAL_DURATION_MS = TYPICAL_GENERATE_DURATION_MS + AUTO_GENERATE_CLASSIFY_DURATION_MS;
/** Story 2.6 (bug fix): matches `DeterminateProgressBar`'s own fill
 * transition (`transition-[width] duration-300` below) — the delay before
 * the new ideas replace this view, so the bar's fill is actually visible
 * reaching 100% instead of being cut off mid-animation by the same render
 * that swaps the ideas in. */
const PROGRESS_COMPLETE_DELAY_MS = 300;

function DeterminateProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        // Round 24 (bug fix): round 23 made this component's wrapper always
        // mounted (for the fade transition) instead of mounting fresh each
        // run — but that means the fill's own `transition-[width]` now
        // animates from whatever `percent` was *last* left at (100%, set
        // when the previous run finished) back down to the fresh 0% a new
        // run resets to, visibly flashing full before dropping. The reset
        // to 0 must jump instantly — only non-zero values (genuine
        // progress during a run) should animate.
        className={`h-full rounded-full bg-primary ease-linear ${percent === 0 ? '' : 'transition-[width] duration-300'}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function AmountWithEstimateBadge({
  money,
  locale,
  estimateLabel,
  estimateLabelFull,
}: {
  money: ReturnType<typeof convertMoney>;
  locale: string;
  estimateLabel: string;
  estimateLabelFull: string;
}) {
  return (
    <span className="flex items-center gap-1">
      {formatMoney(money, locale)}
      {/* User-requested follow-up: plain muted text, not a bordered pill —
       * "(est.)"/"(ca.)" is short enough to read as part of the amount
       * itself rather than a separate chip with its own visual weight.
       * `aria-label` still carries the full word for screen readers. */}
      {money.isEstimate ? (
        <span className="text-xs text-muted-foreground" aria-label={estimateLabelFull}>
          {estimateLabel}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Story 2.3 Fix2 (compact-rate layout, same shape in both languages — see
 * Design Notes): the rate unit renders as a short suffix glued directly to
 * the formatted amount with no space (`card.rateUnitSuffix.<unit>` — e.g.
 * `"23,34 €"` + `"/Std."` -> `"23,34 €/Std."`, `"€23.34"` + `"/h"` ->
 * `"€23.34/h"`), not the old verbose translated unit word with a space.
 * Layout fix (idea-card spacing polish): the "estimate" badge renders
 * inline next to the value here (same pattern as `AmountWithEstimateBadge`)
 * instead of stacked under the label, so the row never breaks onto its own
 * line just for the badge; the vendor-source badge stays alongside it.
 */
function BaselineRateDisplay({
  idea,
  currency,
  locale,
  vendorSourceLabel,
  estimateLabel,
  estimateLabelFull,
  isEstimate,
}: {
  idea: IdeaResponse;
  currency: CurrencyCode;
  locale: string;
  vendorSourceLabel: string;
  estimateLabel: string;
  estimateLabelFull: string;
  isEstimate: boolean;
}) {
  const { t } = useTranslation('ideas');
  const low = convertMoney(idea.baselineRateLow, currency);
  const high = convertMoney(idea.baselineRateHigh, currency);
  const suffix = t(`card.rateUnitSuffix.${idea.rateUnit}`);

  return (
    <span className="flex flex-wrap items-center justify-end gap-1 text-right">
      <span>
        {idea.isVendorSource
          ? `${formatMoney(low, locale)}–${formatMoney(high, locale)}${suffix}`
          : `${formatMoney(low, locale)}${suffix}`}
      </span>
      {/* User-requested follow-up: plain muted text, not a bordered pill —
       * same treatment as `AmountWithEstimateBadge` above. */}
      {isEstimate ? (
        <span className="text-xs text-muted-foreground" aria-label={estimateLabelFull}>
          {estimateLabel}
        </span>
      ) : null}
      {idea.isVendorSource ? <Badge variant="outline">{vendorSourceLabel}</Badge> : null}
    </span>
  );
}

/**
 * Story 2.2 follow-up fix round 3, fix 2a: `baselineRateCitation` is "a
 * publication/site name or URL" (the tool's own description — not every
 * citation is guaranteed to parse as one). A real URL renders as a link —
 * visible text is just its hostname (stripped of a leading `www.`, same
 * normalization `generate_ideas.ts`'s own `extractCitationDomain` uses),
 * `href`/`title` carry the full URL, `target="_blank"` +
 * `rel="noopener noreferrer"` for a safe new-tab open. Non-URL text (a
 * plain publication name) renders as plain text, not a link. Either way,
 * `truncate` (Tailwind's `text-overflow: ellipsis` + `overflow: hidden` +
 * `white-space: nowrap`) guarantees a single line that ends in an ellipsis
 * rather than an abrupt mid-word cut, and the full text is always in
 * `title` so hovering still reveals it.
 */
function Citation({ citation }: { citation: string }) {
  let url: URL | undefined;
  try {
    url = new URL(citation);
  } catch {
    url = undefined;
  }

  if (url) {
    return (
      <a
        href={citation}
        target="_blank"
        rel="noopener noreferrer"
        title={citation}
        className="block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {url.hostname.replace(/^www\./, '')}
      </a>
    );
  }

  return (
    <span title={citation} className="block truncate text-xs text-muted-foreground">
      {citation}
    </span>
  );
}

/**
 * AC: "a card layout (option A) — each of the 5 cards shows its rationale
 * and its sourced baseline-rate citation (AD-6) directly on the card, not
 * hidden behind a detail view or expansion." Money fields arrive as raw
 * stored minor-units + currency (Boundary) and are converted/formatted
 * here via `shared/money.ts` so a later currency-setting change (Story
 * 5.5) re-renders correctly without a new fetch (AD-27).
 *
 * Layout: one spacing scale — `gap-4` (16px) between the card's direct
 * blocks, `gap-2` (8px) for spacing inside a block — matching
 * `_bmad-output/planning-artifacts/layout-preview.html`'s
 * `.idea-card`/`.idea-actions` glass tokens/structure.
 *
 * Full subgrid, all 5 direct children (header, rationale, facts,
 * disclosure, actions — user-reported round 3: "Zeit pro Woche"/weekly-time,
 * the facts block's first row, must start at the same height on every card
 * in a row, or the row looks messy): `Card` spans exactly 5 rows of the
 * outer grid (`row-span-5`) and declares those as `subgrid`, so each of its
 * 5 direct children sizes against the *same* shared track every sibling
 * card in that row uses — every card has exactly these same 5 children
 * (the conditional monthly-potential row and the disclosure panel's content
 * are nested *inside* the facts/disclosure children, not additional
 * top-level children), so the span always matches the real child count.
 * That matters: an EARLIER version of this fix spanned only 2 of the 5 rows
 * (header+rationale) to avoid matching the facts/disclosure height too —
 * but a subgrid item with *more* children than its span gets extra
 * implicit rows the parent grid never reserves space for, so those rows
 * render past the item's formal area and can visually overlap the next
 * row of cards. Spanning the true number of children avoids that
 * entirely. The accepted tradeoff: a card whose facts/disclosure content is
 * shorter than a row-sibling's gets matched to that sibling's height, which
 * can leave blank space at the bottom of its own facts or disclosure block
 * (flex-col packs content at the top) — bounded to those two spots, not the
 * unpredictable "gaps between random blocks" round 1 fixed (which was
 * caused by inconsistent per-block padding, now a uniform `gap-4`/`gap-2`
 * regardless of this subgrid). The actions row needs no special handling
 * for a flush bottom edge — it's the *last* shared track, and with every
 * card's preceding 4 tracks matched, every card's actions row lands at an
 * identical height with no `mt-auto` margin trick required.
 *
 * `citedIntakeFields` (round 2, fix 3) renders as small translated labels
 * — never the raw field id — so the reader can see which answers shaped
 * the idea without the rationale prose having to spell them out.
 *
 * `citedIntakeFields` (round 2, fix 3) renders as small translated labels
 * — never the raw field id — so the reader can see which answers shaped
 * the idea without the rationale prose having to spell them out.
 */
function IdeaCard({
  idea,
  translation,
  currency,
  locale,
  viewerCountry,
  onSetStatus,
  onRequestSelect,
  pending,
  translating,
}: {
  idea: IdeaWithPlanResponse;
  /** Story 2.7: the cached translation for this idea into the current UI
   * language, if one exists and is needed; `undefined` otherwise. */
  translation: IdeaTranslation | undefined;
  /** Spec 2.12 AC3: true while a batched translate call for the current UI
   * language, covering this idea, is in flight — drives the shimmer
   * placeholder on title/rationale/demandEvidenceNote/growthPath instead
   * of the old page-level "is being translated" banner. */
  translating: boolean;
  currency: CurrencyCode;
  locale: string;
  /** Story 2.6 AC5: lifted into the parent `IdeasPanel` and passed down —
   * one `useViewerCountry()` call for the whole grid instead of one per
   * card (same value for every card in a render, so calling it once up top
   * and threading it down is strictly cheaper, never a behavior change). */
  viewerCountry: CountryCode | undefined;
  onSetStatus: (ideaId: string, status: SettableStatus) => void;
  /** Story 2.8 AC3: "Select"'s own click opens the confirm dialog instead of
   * writing the status directly — the dialog's own confirm handler is what
   * actually calls `onSetStatus`-equivalent logic (`postIdeaStatus`). */
  onRequestSelect: (idea: IdeaWithPlanResponse) => void;
  pending: boolean;
}) {
  const { t } = useTranslation('ideas');
  // Story 2.7: only the 4 fields a translation ever covers are overridden —
  // every other field (numbers, currency, citations, URLs, quotes, trust
  // labels) always comes from the original `idea`, whether or not a
  // translation is active (Boundary: those are never translated at all).
  const displayIdea: IdeaResponse = translation
    ? {
        ...idea,
        title: translation.title,
        rationale: translation.rationale,
        demandEvidenceNote: translation.demandEvidenceNote,
        growthPath: translation.growthPath,
      }
    : idea;
  const startupCost = convertMoney(idea.startupCost, currency);
  const monthlyPotential = computeMonthlyPotential(idea);
  const monthlyPotentialConverted = monthlyPotential ? convertMoney(monthlyPotential, currency) : undefined;
  // Bug fix: an explicit `defaultValue` guarantees this resolves to an
  // empty string for English (never the raw key path rendered as literal
  // text) regardless of i18next's `returnEmptyString` config — the
  // intentionally-empty `en/ideas.json` value alone isn't a safe enough
  // guard on its own.
  const monthlyPotentialSubLabel = t('card.monthlyPotentialSubLabel', { defaultValue: '' });
  // Review fix: `estimateLabel` is the short "(est.)"/"(ca.)" shown in the
  // badge — kept short so the row it sits in doesn't wrap. `estimateLabelFull`
  // is the original full word ("estimate"/"Schätzung"), used only as that
  // badge's `aria-label` so a screen reader doesn't spell the short form out.
  const estimateLabel = t('card.estimateBadge');
  const estimateLabelFull = t('card.estimateBadgeFull');
  // Layout fix: the baseline-rate row's "estimate" badge renders inline
  // beside `BaselineRateDisplay`'s value (passed down as `isEstimate`) —
  // this is the one place that decides whether it shows at all.
  const baselineRateIsEstimate =
    convertMoney(idea.baselineRateLow, currency).isEstimate || convertMoney(idea.baselineRateHigh, currency).isEstimate;
  // Fix round 4, fix 3: 2-3 bullet lines, newline-separated within the one
  // rationale string (shared/schemas/ideas.ts's rationaleSchema enforces
  // the shape) — split for a real <ul>/<li> list, never raw \n in prose.
  // Story 2.7: `displayIdea.rationale`, so an active translation renders
  // its own lines, not the stored-language ones.
  const rationaleLines = displayIdea.rationale.split('\n');
  // Story 2.3 AC2: shared fixed-width label column so values start at a
  // consistent x-position regardless of label length/language (Code Map).
  const labelClassName = 'w-36 shrink-0 text-muted-foreground';
  // Progressive disclosure (layout fix): cited-intake chips and the source
  // line(s) collapse under a "Details" toggle, default closed — everything
  // else on the card (badges/title, rationale, facts, actions) stays always
  // visible. `detailsPanelId` links the toggle button to its panel via
  // `aria-controls`, same pattern a native disclosure widget uses.
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsPanelId = React.useId();
  // Story 2.6 AC5 (was: "User-requested follow-up (compact citation
  // line): fetched once per card" — now fetched once for the whole panel
  // instead, see `IdeasPanel`'s own `useViewerCountry()` call, and passed
  // down as a prop): shared with both this line and `IdeaEvidence`'s own
  // demand-evidence line below — not a separate `/api/intake` fetch per
  // card.
  const baselineRegion = foreignSourceRegion(idea.baselineRateCitation, viewerCountry);

  return (
    <Card className="grid grid-cols-1 row-span-5 gap-4 p-4 [grid-template-rows:subgrid]">
      {/* Block: status badge (Story 2.3 AC2, only once the idea has left
       * `suggested`) + idea type inline, title below with normal
       * line-height — layout fix: these no longer stack vertically. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {idea.status !== 'suggested' ? (
            <Badge variant={idea.status === 'selected' ? 'default' : 'muted'}>{t(`status.${idea.status}`)}</Badge>
          ) : null}
          <Badge variant="muted">{t(`ideaType.${idea.ideaType}`)}</Badge>
        </div>
        <TranslatingBlock translating={translating} shimmerLinesCount={1} srText={displayIdea.title}>
          <CardTitle className="leading-snug">{displayIdea.title}</CardTitle>
        </TranslatingBlock>
      </div>

      {/* Block: rationale, as a real list — why it fits / first step /
       * optional caveat (Boundary: AC still requires this directly on the
       * card, in both languages, never behind an expansion). */}
      <TranslatingBlock translating={translating} shimmerLinesCount={rationaleLines.length} srText={rationaleLines.join(' ')}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {rationaleLines.map((line, index) => (
            // Index-keyed is fine here: this list is never reordered,
            // filtered, or edited in place — only ever rendered once from
            // a persisted, already-validated idea.
            <li key={index}>{line}</li>
          ))}
        </ul>
      </TranslatingBlock>

      {/* Block: structured stats. Story 2.3 AC2: every label cell shares
       * `labelClassName`'s fixed width so values start at a consistent
       * x-position regardless of label length/language — the per-row
       * `<div>` wrapper itself is unchanged (Design Notes: existing tests
       * locate a row via `closest('div')` on the label text). */}
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.weeklyTimeLabel')}</span>
          <span>{t(`weeklyTimeAvailability.${idea.weeklyTimeCommitment}`)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.startupCostLabel')}</span>
          <AmountWithEstimateBadge
            money={startupCost}
            locale={locale}
            estimateLabel={estimateLabel}
            estimateLabelFull={estimateLabelFull}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.riskLevelLabel')}</span>
          <span>{t(`riskTolerance.${idea.riskLevel}`)}</span>
        </div>
        {/* Layout fix: the "estimate" badge moved back inline next to the
         * value (`BaselineRateDisplay`) instead of stacked under the label,
         * so it no longer forces its own line by default (a vendor-sourced
         * *and* converted idea can still wrap two badges plus the amount on
         * a narrow card — `flex-wrap` on that value span handles it). The
         * label cell's `flex-col`/nested `<span>` no longer wraps a second
         * child now that the badge is gone, but stays as a pure test-compat
         * shim: a pinned test asserts the label text's own parent carries
         * `labelClassName` (`w-36`). */}
        <div className="flex items-start justify-between gap-3">
          <span className={`flex flex-col gap-0.5 ${labelClassName}`}>
            <span>{t('card.baselineRateLabel')}</span>
          </span>
          <BaselineRateDisplay
            idea={idea}
            currency={currency}
            locale={locale}
            vendorSourceLabel={t('card.vendorSourceLabel')}
            estimateLabel={estimateLabel}
            estimateLabelFull={estimateLabelFull}
            isEstimate={baselineRateIsEstimate}
          />
        </div>
        {/* Fix round 4, fix 4(d): only shown for hourly rates — a per-project
         * or per-month rate can't be meaningfully multiplied by a weekly-
         * hours cap. Story 2.3 Fix2: the budget caveat is now separate small
         * text under the (shortened, German) label rather than part of the
         * label's own sentence; `monthlyPotentialSubLabel` is `""` for
         * English, so nothing extra renders there. */}
        {monthlyPotentialConverted ? (
          <div className="flex items-start justify-between gap-3">
            <span className={`flex flex-col gap-0.5 ${labelClassName}`}>
              <span>{t('card.monthlyPotentialLabel')}</span>
              {monthlyPotentialSubLabel ? <span className="text-xs">{monthlyPotentialSubLabel}</span> : null}
            </span>
            {/* Always labeled "estimate" — this figure is an estimate by its
             * nature (a maximum-at-full-time-use projection), not only when
             * a currency conversion happens to occur. User-requested
             * follow-up: plain muted text, not a bordered pill — same
             * treatment as `AmountWithEstimateBadge`/`BaselineRateDisplay`. */}
            <span className="flex items-center gap-1">
              {formatMoney(monthlyPotentialConverted, locale)}
              <span className="text-xs text-muted-foreground" aria-label={estimateLabelFull}>
                {estimateLabel}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {/* Block: progressive disclosure. Always visible: a one-line count of
       * how many intake answers shaped this idea, and the "Details" toggle
       * itself. Collapsed (default closed): the cited-field chips and the
       * source line(s) — citation + trust tier, with "unverified" (kept, a
       * trust-tier requirement) as muted inline text next to its own source
       * rather than a separate pill. Round 11 (user-requested removal): the
       * quoted evidence sentence (`baselineRateQuote`) still doesn't render
       * here either — checked against epics.md's Story 2.2 AC and AD-6
       * first: AD-6 only requires the rate *value + citation* to be
       * persisted/shown on the card, never the quote text itself.
       * `baselineRateQuote` itself is untouched server-side — still
       * required and verified (AD-4's quote-matches-search-results check),
       * just not displayed. */}
      <div className="flex flex-col gap-2">
        {/* User-requested follow-up: the always-visible row now teases
         * "Aktuelle Nachfrage" instead of the cited-fields count (moved
         * inside the panel, directly above the chips it summarizes) — only
         * when this idea actually has demand evidence; otherwise the row
         * holds just the toggle, same as an idea predating this story. */}
        <div className="flex items-center justify-between gap-2">
          {hasDemandEvidence(displayIdea) ? <span className="text-xs text-muted-foreground">{t('card.demandEvidenceLabel')}</span> : <span />}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-2 py-1 text-xs"
            // Review fix: every card's toggle otherwise shares the exact
            // same accessible name ("Details"), which is ambiguous the
            // moment more than one idea renders (the normal case — a full
            // batch at once) for screen-reader users and for role-based
            // lookups.
            // The visible label stays the plain "Details" text below;
            // `aria-label` is what screen readers announce instead.
            aria-label={t('card.detailsToggleAriaLabel', { title: displayIdea.title })}
            aria-expanded={detailsOpen}
            aria-controls={detailsPanelId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {t('card.detailsToggle')}
            <ChevronDown
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-180' : ''}`}
            />
          </Button>
        </div>
        {/* Review fix: always mounted (never conditionally unmounted) and
         * toggled via the native `hidden` attribute, so `aria-controls`
         * above always points at a real element instead of an id that only
         * exists once opened — the same "always mounted, toggle
         * visibility" pattern this file already uses for the generate-
         * progress block below. `hidden` also removes it from the
         * accessibility tree, which is what makes the closed-by-default
         * tests below able to assert its content isn't reachable. */}
        {/* User-requested follow-up: a little more breathing room between
         * the panel's sections (demand/growth, cited-fields summary +
         * chips, citation line) than the original `gap-2` — `gap-4` was
         * tried and was too much. */}
        <div id={detailsPanelId} hidden={!detailsOpen} className="flex flex-col gap-3">
          {/* User-requested follow-up: demand evidence + growth path lead
           * the panel, ahead of the cited-fields chips and the baseline-
           * rate citation line below. */}
          <IdeaEvidence idea={displayIdea} viewerCountry={viewerCountry} translating={translating} />
          <span className="text-xs text-muted-foreground">
            {t('card.citedFieldsSummary', { count: idea.citedIntakeFields.length })}
          </span>
          <div className="flex flex-wrap gap-2">
            {idea.citedIntakeFields.map((field) => (
              <Badge key={field} variant="outline">
                {t(`citedIntakeFields.${field}`)}
              </Badge>
            ))}
          </div>
          {/* User-requested follow-up: one compact line (citation, then the
           * source-region label if the source is foreign, then "unverified"
           * if applicable) — the trust-tier phrase ("Gehaltsdaten-
           * Anbieter"/"pay-data provider") that used to lead this line is
           * dropped (the tier *mechanism* is unaffected server-side; this
           * is display-only, same category of change as round 11's quote
           * removal) and the region label (previously its own separate
           * line via `IdeaEvidence`) now lives here instead, right next to
           * the citation it actually describes. Review fix: separators are
           * plain ", " text, not a decorative `aria-hidden` dot — a
           * non-URL citation renders as plain text too (see `Citation`),
           * and a screen reader reading the adjacent spans straight
           * through needs an actual announced boundary, not just a visual
           * one. */}
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Citation citation={idea.baselineRateCitation} />
            {baselineRegion ? <span>, {t('card.foreignSourceLabel', { region: t(`card.region.${baselineRegion}`) })}</span> : null}
            {idea.isRateUnverified ? <span>, {t('card.unverifiedLabel')}</span> : null}
          </div>
        </div>
      </div>

      {/* Block: Select/Bookmark/Reject directly on every card, never behind
       * a menu (Story 2.3 AC2) — the 5th and last of the card's subgridded
       * rows (see the doc comment above), so it lands at an identical
       * height across every card in a row with no margin trick needed; its
       * own content (3 buttons, plus the Story 3.1 "View plan" row below
       * for a `selected`/`bookmarked` idea) never varies in height across
       * ideas of the same status. The action matching the card's current
       * status renders as the primary (`default`) button; the others are
       * `outline`. None is primary while still `suggested`. */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={idea.status === 'selected' ? 'default' : 'outline'}
            className="flex-1"
            disabled={pending}
            onClick={() => onRequestSelect(idea)}
          >
            {t('actions.select')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={idea.status === 'bookmarked' ? 'default' : 'outline'}
            className="flex-1"
            disabled={pending}
            onClick={() => onSetStatus(idea.id, 'bookmarked')}
          >
            {t('actions.bookmark')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={idea.status === 'rejected' ? 'default' : 'outline'}
            className="flex-1"
            disabled={pending}
            onClick={() => onSetStatus(idea.id, 'rejected')}
          >
            {t('actions.reject')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * AC1/AC9: fetches `GET /api/ideas` on mount; while the user has none yet,
 * offers the one action that calls `POST /api/ideas/generate` (AD-30:
 * strict-rate-limited, cost-bearing). `failurePattern`-style tool-decided
 * fields (here, `replyLanguage`) are the agent's concern, not this panel's
 * — this only ever asks the agent to run `generate_ideas`, never calls its
 * persistence logic directly (Boundary).
 */
export interface IdeasPanelProps {
  /** Story 3.1: forwarded to each card's "View plan" action — omitted
   * entirely means no card shows that action (test/compat default). */
  onViewPlan?: (ideaId: string, ideaTitle: string) => void;
  /** Story 2.8 AC1: true only right after this session's first-ever intake
   * submit (set by `App`) — fires `handleGenerate()` once, automatically,
   * before the user has clicked anything. Omitted/false everywhere else
   * (a returning user with or without existing ideas). */
  autoGenerate?: boolean;
  /** UX fix (user-reported, live): present only when opened from a
   * sidebar "Bookmarked" entry — shows *only* that one idea's card and
   * nothing else, instead of the "New ideas" grid (which itself now shows
   * only still-undecided `suggested` ideas, never a bookmarked one). */
  onlyIdeaId?: string;
  /** UX fix (user-reported): the sidebar's "Bookmarked" entry is now one
   * button (like "New ideas"), not a per-idea list — this shows every
   * `bookmarked` idea's card together, the same grid "New ideas" uses. */
  onlyBookmarked?: boolean;
}

export function IdeasPanel({
  onViewPlan,
  autoGenerate = false,
  onlyIdeaId,
  onlyBookmarked = false,
}: IdeasPanelProps = {}) {
  const { t, i18n } = useTranslation('ideas');
  const [ideas, setIdeas] = React.useState<IdeaWithPlanResponse[]>([]);
  const [currency, setCurrency] = React.useState<CurrencyCode>('EUR');
  // Story 2.11 (AC5/AC6): server-computed, read fresh on every load and
  // after every generate response — `null` only until the first `GET
  // /api/ideas` response lands.
  const [generateLimit, setGenerateLimit] = React.useState<GenerateLimitStatus | null>(null);
  // Spec 2.12 AC1: on the auto-generate path, `phase` starts at
  // `'generating'` already — before this component's first real paint —
  // instead of `'loading'` then flipping to `'idle'` (a frame with an
  // idle, enabled "Generate" button) and only then to `'generating'` once a
  // separate effect notices. The lazy initializer runs once, synchronously,
  // ahead of that first paint.
  const [phase, setPhase] = React.useState<Phase>(() => (autoGenerate ? 'generating' : 'loading'));
  const [progress, setProgress] = React.useState(0);
  // Spec 2.12 AC1: which stage text the generating footer shows — only the
  // auto-generate path ever sets this to `'classifying'` (for the first
  // ~`AUTO_GENERATE_CLASSIFY_DURATION_MS`); a manual generate/regenerate
  // never touches this, so it stays at the existing single stage text.
  const [generatingStage, setGeneratingStage] = React.useState<'classifying' | 'generating'>(
    autoGenerate ? 'classifying' : 'generating',
  );
  // Review fix (Story 2.11 regression): true once the first `GET /api/ideas`
  // has settled, success or failure — lets the auto-generate effect below
  // wait for `generateLimit` to actually be known before firing, so it
  // never auto-fires into an already-known-blocked (e.g. shared-budget-
  // exhausted) limit, while still never showing an idle/enabled frame in
  // the meantime (`phase` is already `'generating'` the whole time it
  // waits — see that lazy initializer above).
  const [initialLoadSettled, setInitialLoadSettled] = React.useState(false);
  // Fail-fast (every web_search call in a round failed): distinct from the
  // generic `generateFailed` message — set alongside `setPhase('generate-
  // error')`, read only while `phase === 'generate-error'`. Never falls
  // back to the generic text for this specific case.
  const [generateErrorKind, setGenerateErrorKind] = React.useState<'generic' | 'searchUnavailable'>('generic');
  // Story 2.8 AC3: which idea the "Select" confirm dialog is open for —
  // `null` means closed. Panel-level (not per-card) since only one dialog
  // can be open at a time.
  const [confirmIdea, setConfirmIdea] = React.useState<IdeaWithPlanResponse | null>(null);
  // Story 2.3 (user-reported bug fix): `pendingIdeaIds` disables only the
  // card(s) a given action actually touches (the target, plus any siblings
  // a `selected` sweep demotes) while that request is in flight — not every
  // card in the grid, which previously made every card's buttons flash on
  // any click regardless of which one was pressed. `statusUpdateFailed` is
  // independent of `phase` (a status-change failure never replaces the
  // load/generate error messaging — the ideas grid itself stays exactly as
  // it was, revert-scoped to this one action, right next to this notice).
  const [pendingIdeaIds, setPendingIdeaIds] = React.useState<ReadonlySet<string>>(new Set());
  const [statusUpdateFailed, setStatusUpdateFailed] = React.useState(false);

  // Story 2.6 AC5: lifted up from `IdeaCard` — one `useViewerCountry()`
  // call (one `/api/intake` fetch) for the whole grid instead of one per
  // card, passed down as a prop. Same value every card already got from its
  // own identical call, so this changes nothing any card renders.
  const viewerCountry = useViewerCountry();

  // Story 2.7: a cached translation per `${ideaId}:${language}` — an
  // immutable client-side mirror of the server's own `idea_translations`
  // cache, so toggling the UI language back and forth after the first
  // translate never re-fetches (AC: "switching back and forth is instant").
  const [translations, setTranslations] = React.useState<ReadonlyMap<string, IdeaTranslation>>(new Map());
  // Live fix (post-handoff): per-language, not a single phase — this is
  // what lets the banner's visibility be *derived* from "is a translation
  // for the currently-selected UI language in flight/failed right now",
  // regardless of whether that fetch was started by the user actually
  // switching or by the background prefetch below. A prefetch for a
  // language the user isn't currently viewing never shows anything; the
  // moment they switch to a language that's already in-flight or already
  // failed, the right banner appears immediately, with no new fetch needed
  // in the in-flight case.
  const [translatingLanguages, setTranslatingLanguages] = React.useState<ReadonlySet<string>>(new Set());
  const [failedLanguages, setFailedLanguages] = React.useState<ReadonlySet<string>>(new Set());
  const translationsRef = React.useRef(translations);
  React.useEffect(() => {
    translationsRef.current = translations;
  }, [translations]);
  // Guards against a second concurrent call for the *same* target language
  // firing before the first resolves — the state above alone isn't enough,
  // since the effects below re-run synchronously on every render while the
  // state update that would reflect a call starting is still pending.
  const translationInFlightRef = React.useRef<Set<string>>(new Set());

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    // See `IntakeForm`'s identical comment: React 19 `<StrictMode>` double-
    // invokes this effect in dev, so this must reset to `true` on every run.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Spec 2.12 AC1: guards every `setPhase` call below against clobbering an
  // already-`'generating'` phase — on the auto-generate path, this effect's
  // own GET can resolve (success or failure) while the separate mount-only
  // auto-generate effect's own `handleGenerate()` call is already running,
  // and must never flip the visible phase back to `'idle'`/`'load-error'`
  // out from under it.
  function setPhaseUnlessGenerating(next: Phase) {
    setPhase((prev) => (prev === 'generating' ? prev : next));
  }

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/ideas', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPhaseUnlessGenerating('load-error');
          return;
        }
        const body: unknown = await res.json();
        const result = ideasWithPlanResponseSchema.safeParse(body);
        if (!result.success) {
          setPhaseUnlessGenerating('load-error');
          return;
        }
        setIdeas(result.data.ideas);
        setCurrency(result.data.currency);
        setGenerateLimit(result.data.generateLimit);
        setPhaseUnlessGenerating('idle');
      })
      .catch(() => {
        if (!cancelled) setPhaseUnlessGenerating('load-error');
      })
      .finally(() => {
        // Review fix: set regardless of outcome — even a failed/unparseable
        // load must release the auto-generate effect below rather than
        // leaving it waiting on a `generateLimit` that will never arrive.
        if (!cancelled) setInitialLoadSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Story 2.7: one batched `POST /api/ideas/translate` for every visible id
   * still missing a cached translation into `language` — never one call
   * per idea (AC: "one batched model call translates all visible cards
   * together"). The whole batch's result is merged into `translations` in
   * one `setState` call, so cards swap atomically together, never one at a
   * time (Boundary: "never a mixed-language flash").
   *
   * Called by both the foreground effect (current UI language) and the
   * background prefetch effect (the other one) below — which one started
   * it never matters to the UI, since the banner is derived from
   * `translatingLanguages`/`failedLanguages` against the *currently
   * selected* language, not from who issued the request.
   */
  const runTranslation = React.useCallback((ideaIds: string[], language: string) => {
    translationInFlightRef.current.add(language);
    setTranslatingLanguages((prev) => new Set(prev).add(language));
    setFailedLanguages((prev) => {
      if (!prev.has(language)) return prev;
      const next = new Set(prev);
      next.delete(language);
      return next;
    });

    fetch('/api/ideas/translate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ideaIds, language }),
    })
      .then(async (res) => {
        const body: unknown = await res.json();
        const result = translateIdeasResponseSchema.safeParse(body);
        if (!res.ok || !result.success) {
          if (isMountedRef.current) setFailedLanguages((prev) => new Set(prev).add(language));
          return;
        }
        if (isMountedRef.current) {
          setTranslations((prev) => {
            const next = new Map(prev);
            for (const translation of result.data.translations) {
              next.set(translationKey(translation.ideaId, translation.language), translation);
            }
            return next;
          });
        }
      })
      .catch(() => {
        if (isMountedRef.current) setFailedLanguages((prev) => new Set(prev).add(language));
      })
      .finally(() => {
        translationInFlightRef.current.delete(language);
        if (isMountedRef.current) {
          setTranslatingLanguages((prev) => {
            if (!prev.has(language)) return prev;
            const next = new Set(prev);
            next.delete(language);
            return next;
          });
        }
      });
  }, []);

  // AC: "a visible card's language differs from the UI language" triggers
  // exactly one batched translate call — re-evaluated whenever the loaded
  // ideas or the UI language change, but only once `GET /api/ideas` itself
  // has settled (never mid-load/mid-generate, where `ideas` is still stale
  // or about to be replaced wholesale). Story 2.6 AC5: this is now the only
  // translate trigger in this component — the other-language background
  // prefetch effect that used to run alongside it (pre-translating into
  // whichever language wasn't the card's own stored one, before the user
  // ever switched) was removed: it doubled the model-call volume behind
  // every generation for a latency win on a *future, maybe-never* language
  // switch, which this story's "cut avoidable latency" intent weighs more
  // than that prefetch's own convenience. A switch into an untranslated
  // language now always does the real work at switch time, same as the
  // very first "Generate" ever did before the prefetch existed.
  React.useEffect(() => {
    if (phase !== 'idle' || translationInFlightRef.current.has(i18n.language)) return;
    const language = i18n.language;
    const missingIds = ideas
      .filter((idea) => idea.language !== language && !translationsRef.current.has(translationKey(idea.id, language)))
      .map((idea) => idea.id);
    if (missingIds.length > 0) runTranslation(missingIds, language);
  }, [ideas, i18n.language, phase, runTranslation]);

  /**
   * AC: "on failure the cards stay in their stored language with a neutral
   * notice and a retry" — re-runs the exact same batched request for
   * whatever is still mismatched right now (if the ideas list changed
   * since the failed attempt, this naturally retries the current set, not
   * a stale one).
   */
  const handleRetryTranslation = React.useCallback(() => {
    const language = i18n.language;
    const missingIds = ideas
      .filter((idea) => idea.language !== language && !translationsRef.current.has(translationKey(idea.id, language)))
      .map((idea) => idea.id);
    if (missingIds.length > 0) runTranslation(missingIds, language);
  }, [ideas, i18n.language, runTranslation]);

  /**
   * AC1/AC2/AC3/AC5/Fix: optimistic local update mirroring the server's own
   * select/demote/reject-removal rules (`applyOptimisticIdeaStatus`), so
   * every card's status/badge/primary-button reacts instantly — then a
   * revert (scoped to exactly the ids this one action touched, via
   * `affectedIdeaIds`/`revertOptimisticIdeaStatus`) plus
   * `error.statusUpdateFailed` if the real `POST /api/ideas/:id/status`
   * call fails or the response isn't ok. A second, unrelated card's own
   * concurrent action is neither disabled nor reverted by this one — each
   * uses its own `priorById` snapshot captured from `ideas` at its own call
   * time. Never calls `set_idea_status`'s persistence logic directly
   * (Boundary) — only ever this one HTTP call.
   */
  const postIdeaStatus = React.useCallback(
    (ideaId: string, status: SettableStatus): Promise<boolean> => {
      setStatusUpdateFailed(false);

      const affectedIds = affectedIdeaIds(ideas, ideaId, status);
      const priorById = new Map(ideas.filter((idea) => affectedIds.includes(idea.id)).map((idea) => [idea.id, idea]));

      setPendingIdeaIds((prev) => {
        const next = new Set(prev);
        affectedIds.forEach((id) => next.add(id));
        return next;
      });
      setIdeas((current) => applyOptimisticIdeaStatus(current, ideaId, status));

      return fetch(`/api/ideas/${ideaId}/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
        .then((res) => {
          if (!res.ok) {
            if (isMountedRef.current) {
              setIdeas((current) => revertOptimisticIdeaStatus(current, priorById));
              setStatusUpdateFailed(true);
            }
            return false;
          }
          return true;
        })
        .catch(() => {
          if (isMountedRef.current) {
            setIdeas((current) => revertOptimisticIdeaStatus(current, priorById));
            setStatusUpdateFailed(true);
          }
          return false;
        })
        .finally(() => {
          if (isMountedRef.current) {
            setPendingIdeaIds((prev) => {
              const next = new Set(prev);
              affectedIds.forEach((id) => next.delete(id));
              return next;
            });
          }
        });
    },
    [ideas],
  );

  /** Bookmark/Reject keep their current direct-call, fire-and-forget
   * behavior — only "Select" (via `handleConfirmSelect` below) needs to
   * know whether the write actually succeeded. */
  const handleSetIdeaStatus = React.useCallback(
    (ideaId: string, status: SettableStatus) => {
      void postIdeaStatus(ideaId, status);
    },
    [postIdeaStatus],
  );

  /** Story 2.8 AC3: "Select" opens the confirm dialog instead of writing
   * the status directly. */
  const handleRequestSelect = React.useCallback((idea: IdeaWithPlanResponse) => {
    setConfirmIdea(idea);
  }, []);

  /**
   * Story 2.8 AC3/AC4: confirming closes the dialog, then runs the same
   * `postIdeaStatus('selected')` the status endpoint always used — on
   * success, navigates straight to `PlanWorkspace` (which lazily creates
   * the draft plan on mount and has its own loading/error UI — Design
   * Notes). On failure, `postIdeaStatus` already reverted the optimistic
   * change and raised `statusUpdateFailed`; nothing further happens here,
   * so there is no navigation (I/O matrix: "Select -> Confirm" error row).
   */
  const handleConfirmSelect = React.useCallback(async () => {
    const idea = confirmIdea;
    if (!idea) return;
    setConfirmIdea(null);
    const succeeded = await postIdeaStatus(idea.id, 'selected');
    if (succeeded && isMountedRef.current) onViewPlan?.(idea.id, idea.title);
  }, [confirmIdea, postIdeaStatus, onViewPlan]);

  const handleGenerate = React.useCallback((options: { auto?: boolean } = {}) => {
    const isAuto = options.auto ?? false;
    // Spec 2.12 AC1: only the auto path uses the longer combined duration
    // and the classify->generate stage-text split; a manual call (`isAuto`
    // false, including the default with no argument at all) keeps the
    // existing single-stage timing exactly as before.
    const durationMs = isAuto ? AUTO_GENERATE_TOTAL_DURATION_MS : TYPICAL_GENERATE_DURATION_MS;
    setPhase('generating');
    setProgress(0);
    setGeneratingStage(isAuto ? 'classifying' : 'generating');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

    const startedAt = Date.now();
    const progressIntervalId = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setProgress(Math.min(PROGRESS_HOLD_PERCENT, (elapsedMs / durationMs) * PROGRESS_HOLD_PERCENT));
      if (isAuto) setGeneratingStage(elapsedMs < AUTO_GENERATE_CLASSIFY_DURATION_MS ? 'classifying' : 'generating');
    }, PROGRESS_TICK_MS);

    // Story 2.7 (AC4): a button click is not a written chat message, so the
    // server can't detect its language from a discovery-thread message —
    // the current UI language is sent explicitly instead, and the server
    // uses it directly rather than guessing.
    fetch('/api/ideas/generate', {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: i18n.language }),
    })
      .then(async (res) => {
        const body: unknown = await res.json();
        setProgress(100);
        // Story 2.6 (bug fix): stop the ticking interval the instant a
        // response arrives — otherwise, during the success branch's own
        // `PROGRESS_COMPLETE_DELAY_MS` wait below, one more tick would
        // recompute progress from the hold-percent formula and regress the
        // bar back down from the 100% just set above.
        window.clearInterval(progressIntervalId);

        // Story 2.11 (AC5/AC6): the server's 429 is a plain limit, never an
        // error — existing ideas stay exactly as they are, and this never
        // sets `generate-error`. `generateLimitStatusSchema` already
        // carries the fields this 429 body also uses (`reason`/`limit`/
        // `resetsAt`), so it's reused directly rather than a second schema.
        if (res.status === 429) {
          const limitResult = generateLimitStatusSchema.safeParse({ ...(body as object), blocked: true });
          if (isMountedRef.current) {
            setGenerateLimit(limitResult.success ? limitResult.data : { blocked: true, reason: null, limit: null, resetsAt: null });
            setPhase('idle');
          }
          return;
        }

        const result = ideasWithPlanResponseSchema.safeParse(body);
        if (!res.ok || !result.success) {
          // Fail-fast (every web_search call this round failed): a distinct
          // 503/`search_unavailable` response gets its own message — never
          // the generic `generateFailed` one — so the user knows their
          // existing ideas are unchanged, not just "failed or timed out".
          const isSearchUnavailable =
            res.status === 503 || (typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'search_unavailable');
          if (isMountedRef.current) {
            setGenerateErrorKind(isSearchUnavailable ? 'searchUnavailable' : 'generic');
            setPhase('generate-error');
          }
          return;
        }
        // Story 2.6 (bug fix): let the bar's own fill animation actually
        // reach 100% before swapping the ideas in, instead of cutting it
        // off mid-animation — `setProgress(100)` above and the reveal
        // below used to land in the same render.
        await new Promise((resolve) => window.setTimeout(resolve, PROGRESS_COMPLETE_DELAY_MS));

        // Round 13: ideas are swapped into state here directly from the
        // response — a successful generation already shows the new batch's
        // cards immediately, with no page reload.
        if (isMountedRef.current) {
          setIdeas(result.data.ideas);
          setCurrency(result.data.currency);
          setGenerateLimit(result.data.generateLimit);
          setPhase('idle');
        }
      })
      .catch(() => {
        // Covers both a genuine network failure and `controller.abort()`
        // firing at `GENERATE_TIMEOUT_MS` (an AbortError) — either way the
        // client gives up waiting, hence the combined "failed or timed out"
        // copy (`error.generateFailed`) rather than a timeout-specific one.
        // Never the search-unavailable case (that's a real HTTP response,
        // handled in `.then` above), so always generic here.
        setProgress(100);
        if (isMountedRef.current) {
          setGenerateErrorKind('generic');
          setPhase('generate-error');
        }
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        window.clearInterval(progressIntervalId);
      });
  }, [i18n.language]);

  // Story 2.8 AC1 / Spec 2.12 AC1: fires `handleGenerate({ auto: true })`
  // automatically — never on a later re-render of the same mount (the ref
  // is set before calling) — once the GET-ideas effect above has settled
  // (`initialLoadSettled`), so there's still no frame where `phase` is
  // anything but `'generating'` already (see the lazy `phase` initializer):
  // this effect only decides *whether a real request starts*, never when
  // the generating UI itself first shows.
  //
  // Review fix (Story 2.11 regression): waiting for `initialLoadSettled`
  // (rather than firing unconditionally on mount) restores that story's
  // "never auto-fire into a known-blocked limit" rule — e.g. the shared
  // search budget already exhausted by other users — without reintroducing
  // the idle-frame bug this story fixes; `generateLimit` is only ever
  // non-null once that GET has actually resolved. A failed/unparseable GET
  // still releases this effect (`initialLoadSettled` is set either way) and
  // falls through to firing anyway, since a transient load failure says
  // nothing about whether the limit is actually blocked.
  const autoGenerateFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (!autoGenerate || autoGenerateFiredRef.current || !initialLoadSettled) return;
    autoGenerateFiredRef.current = true;
    if (generateLimit?.blocked) {
      // Never fires into a known-blocked limit — same as the button
      // itself being disabled, this never "fails after the fact" once the
      // state was already known. Bypasses `setPhaseUnlessGenerating`
      // deliberately: this is the one legitimate way out of the
      // auto-generate path's synthetic `'generating'` phase when no real
      // request is ever going to start.
      setPhase('idle');
      return;
    }
    handleGenerate({ auto: true });
  }, [autoGenerate, initialLoadSettled, generateLimit, handleGenerate]);

  const locale = LOCALE_BY_LANGUAGE[i18n.language] ?? 'en-US';
  // UX fix (user-reported): the "Generate new ideas" button moved out of
  // the sidebar and back onto this page (bottom of the card) — these are
  // the same disabled/label/reset-time values the sidebar's own button
  // used to compute for itself.
  const generateBlocked = generateLimit?.blocked ?? false;
  const generateLimitResetTime =
    generateLimit?.resetsAt != null
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(generateLimit.resetsAt))
      : '';
  const generating = phase === 'generating';
  // Spec 2.12 AC1: computed once, used for both the progress bar's own
  // `aria-label` and the visible status text below it, so they can never
  // drift out of sync with each other. `generatingStage` only ever reads
  // `'classifying'` on the auto-generate path's first
  // ~`AUTO_GENERATE_CLASSIFY_DURATION_MS` — a manual generate/regenerate
  // stays on `'generating'` the whole time, rendering the exact same
  // `generatingStatus` text as before.
  const generatingStatusLabel = generatingStage === 'classifying' ? t('generatingStatusClassifying') : t('generatingStatus');
  // UX fix (user-reported, live): three views share this one grid.
  // `onlyIdeaId` (a stale/hand-typed single-idea URL) shows *only* that one
  // idea's card. `onlyBookmarked` (the sidebar's "Bookmarked" button) shows
  // every `bookmarked` idea's card together. Otherwise ("New ideas") shows
  // only still-undecided `suggested` ideas — a `selected` idea already has
  // its own plan/chat in "My plans", and a `rejected` one is never returned
  // by the server at all (AD-13). `ideas` itself (unfiltered) stays the
  // source of truth for the auto-generate effect above and the status
  // actions below, which care about "does the user have any ideas at all",
  // not what this grid happens to be showing right now.
  //
  // User-reported follow-up: Story 2.9's own AC is explicit — "the
  // 'Bookmarked' list ... the user has bookmarked ideas *without* a plan" —
  // once a bookmarked idea is demoted from `selected` back to `bookmarked`
  // (a later `selected` sweeps every non-rejected/non-bookmarked sibling,
  // Code Map) it keeps `hasPlan: true` from its earlier selection and
  // belongs in "My plans" only, not duplicated here too.
  const visibleIdeas = React.useMemo(() => {
    if (onlyIdeaId) return ideas.filter((idea) => idea.id === onlyIdeaId);
    if (onlyBookmarked) return ideas.filter((idea) => idea.status === 'bookmarked' && !idea.hasPlan);
    return ideas.filter((idea) => idea.status === 'suggested');
  }, [ideas, onlyIdeaId, onlyBookmarked]);
  // UX fix (user-reported): "Generate new ideas" is a "New ideas"-view-only
  // action (it replaces the `suggested` batch) — the "Bookmarked" views
  // (`onlyBookmarked`/`onlyIdeaId`) never show it.
  const isNewIdeasView = !onlyIdeaId && !onlyBookmarked;

  return (
    <>
      <Card aria-busy={generating}>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          {/* Story 2.8 AC2/AC6: only rendered once there's something to act
           * on — an empty/loading panel never reserves this line, so no
           * blank band is left under the heading (AC6). */}
          {visibleIdeas.length > 0 ? <p className="text-sm text-muted-foreground">{t('explanation')}</p> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Fix1: a fixed-height neutral skeleton, never the "no ideas yet"
           * text, while the first `GET /api/ideas` is pending. */}
          {phase === 'loading' ? <IdeasSkeleton loadingLabel={t('loading')} /> : null}
          {/* Bug fix (user-reported, live): also shown, `decorative` (no
           * duplicate `role="status"` — the "Generating…" dialog below
           * already has its own), during the very first-ever auto-generate
           * (`generating && visibleIdeas.length === 0`) — a *regenerate*
           * already has the real grid mounted behind that dialog
           * (`visibleIdeas` isn't phase-gated), which gives its
           * backdrop-blur real boxes to soften; the first-ever generate has
           * nothing at all behind it otherwise, so that same blur reads as
           * flat, not glass. */}
          {generating && visibleIdeas.length === 0 ? (
            <IdeasSkeleton loadingLabel={generatingStatusLabel} decorative />
          ) : null}
          {/* Round 13 (user-requested): which message shows now depends on
           * which request actually failed, never on `ideas.length` — the old
           * logic showed "couldn't load" for a failed *regenerate* whenever
           * ideas were already empty, which was simply the wrong message for
           * that failure. The generate button below (unaffected by either
           * error phase) doubles as the retry action either message refers
           * to. */}
          {phase === 'load-error' ? (
            <Badge variant="muted" role="alert">
              {t('error.loadFailed')}
            </Badge>
          ) : null}
          {phase === 'generate-error' ? (
            <Badge variant="muted" role="alert">
              {generateErrorKind === 'searchUnavailable' ? t('error.searchUnavailable') : t('error.generateFailed')}
            </Badge>
          ) : null}
          {/* Story 2.3: independent of `phase` — a failed status change never
           * overrides the load/generate messaging above, and vice versa. */}
          {statusUpdateFailed ? (
            <Badge variant="muted" role="alert">
              {t('error.statusUpdateFailed')}
            </Badge>
          ) : null}
          {/* Spec 2.12 AC3: the old page-level "is being translated" banner
           * is gone — each translating field now shimmers in place
           * (`TranslatingBlock`, passed `translating` below) instead, so
           * there's no separate "is being translated" text anywhere on the
           * page while a batch is in flight. */}
          {failedLanguages.has(i18n.language) && !translatingLanguages.has(i18n.language) ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="muted" role="alert">
                {t('error.translateFailed')}
              </Badge>
              <Button type="button" size="sm" variant="outline" onClick={handleRetryTranslation}>
                {t('actions.retryTranslation')}
              </Button>
            </div>
          ) : null}
          {/* Round 13: only when genuinely idle and empty — not alongside an
           * error message, which already explains the state. */}
          {phase === 'idle' && visibleIdeas.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : null}
          {visibleIdeas.length > 0 ? (
            <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleIdeas.map((idea) => {
                const cardTranslation = translations.get(translationKey(idea.id, i18n.language));
                return (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    translation={cardTranslation}
                    // Spec 2.12 AC3: this specific idea is still missing its
                    // own translation for the current language *and* a
                    // batch covering it is in flight right now — never true
                    // once the batch resolves (either this idea gets a
                    // cached translation, or the whole language's own
                    // `translatingLanguages` entry clears either way).
                    translating={translatingLanguages.has(i18n.language) && idea.language !== i18n.language && !cardTranslation}
                    currency={currency}
                    locale={locale}
                    viewerCountry={viewerCountry}
                    onSetStatus={handleSetIdeaStatus}
                    onRequestSelect={handleRequestSelect}
                    // Only the card(s) this specific action touches disable —
                    // the target, plus any siblings a `selected` sweep demotes
                    // (those are genuinely changing too). An unrelated card's
                    // own action is unaffected.
                    pending={pendingIdeaIds.has(idea.id)}
                  />
                );
              })}
            </div>
          ) : null}
        </CardContent>
        {/*
         * Round 20 (user-requested — revert to round 14 exactly): one footer
         * handles both the first-ever generate (epics.md AC1) and "Generate
         * new ideas" (epics.md AC: regenerate, replacing the `suggested`
         * batch — `generate_ideas.ts`'s own DB-write transaction, round 10,
         * actually does the replace.
         *
         * UX fix (user-reported): Story 2.9 moved this button to the
         * sidebar; now moved back here (bottom of this page, below the
         * cards) — the sidebar's own copy of this button/badge/disabled
         * state is removed entirely, this is the one place it lives again.
         * The progress bar/status text always stays mounted and fades via
         * `transition-opacity` instead of popping in/out, so it reserves
         * its own real height and the layout never jumps when a generation
         * starts or ends.
         */}
        {phase !== 'loading' && isNewIdeasView ? (
          // UX fix (user-reported, live): back to the original Story 2.2
          // side-by-side layout (`flex-row`, button `shrink-0`, the status
          // column taking the remaining width) — a later round stacked
          // these (`flex-col`), which regressed it back under the button.
          <CardFooter className="flex flex-row items-start gap-4">
            {/* Spec 2.12 AC1: called with no arguments here — a manual
             * click always takes the unchanged, single-stage timing (never
             * `isAuto`); passing `handleGenerate` directly as the handler
             * would otherwise forward the click's own `SyntheticEvent` as
             * its first argument. */}
            <Button
              type="button"
              size="sm"
              className="shrink-0 gap-2"
              disabled={generating || generateBlocked}
              onClick={() => handleGenerate()}
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {generating ? t('generatingButton') : ideas.length > 0 ? t('generateNewButton') : t('generateButton')}
            </Button>
            {/* Story 2.11 (AC5/AC6): a plain limit notice, never worded like
             * an error — stays inline here, independent of the generating
             * state below. */}
            {generateBlocked ? (
              <Badge variant="muted" role="status" className="flex-1 whitespace-normal text-left">
                {generateLimit?.reason === 'shared_budget'
                  ? t('limit.sharedBudgetExhausted')
                  : t('limit.userLimitReached', { limit: generateLimit?.limit, resetTime: generateLimitResetTime })}
              </Badge>
            ) : null}
          </CardFooter>
        ) : null}
        {/* Bug fix (user-reported, live): "it should have the same UI as
         * when the plan is generated — that pop-up, background blurred and
         * not clickable" — same `shadcn-glass-ui` Dialog pattern as
         * `PlanWorkspace.tsx`'s own plan-creation loading modal (its
         * backdrop already carries `backdrop-blur`), replacing the old
         * inline progress block that left the rest of the page (including
         * the sidebar) fully clickable during a generation. The generate
         * button above stays inline and disabled/transparent from the
         * first frame either way (Spec 2.12 AC1) — only the progress
         * bar/stage text/hint move into this modal.
         *
         * `popup-glass-strong` (`index.css`, user-reported, live, round 3
         * — see its own doc comment there for why this is a plain
         * hand-written class, not a Tailwind arbitrary-value one). The
         * decorative `IdeasSkeleton` above (first-ever auto-generate only
         * — a *regenerate* already has the real grid mounted behind this
         * dialog) is what gives its backdrop-blur real boxes to soften.
         * `border shadow-[var(--shadow)]` (user-reported, live, explicit
         * follow-up): a visible outline around the panel itself — this
         * app's own `Card` component's exact recipe (`card.tsx`), same fix
         * as `PlanWorkspace.tsx`'s own plan-creation loading modal. */}
        <Dialog open={generating} onOpenChange={() => undefined}>
          <DialogContent
            showCloseButton={false}
            className="popup-glass-strong flex flex-col items-center gap-3 border text-center shadow-[var(--shadow)]"
          >
            {/* `role="status"`/`aria-live` wraps the title too (not just the
             * progress/hint below it) — same live region the old inline
             * block was, just relocated, so the stage text is still
             * announced as it changes and still lands inside this one
             * region for `getByRole('status')` to find. A plain `div`, not
             * `DialogContent` itself — Radix's own `role="dialog"` on that
             * element stays untouched. */}
            <div className="flex w-full flex-col items-center gap-3" aria-live="polite" role="status">
              <DialogHeader className="items-center text-center">
                <DialogTitle>{generatingStatusLabel}</DialogTitle>
              </DialogHeader>
              <div className="flex w-full flex-col gap-2">
                <DeterminateProgressBar percent={progress} label={generatingStatusLabel} />
                <p className="text-xs text-muted-foreground">{t('generatingHint')}</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Card>
      {/* Story 2.8 AC3: panel-level (rendered once, not per-card) — driven by
       * `confirmIdea`. Confirming demotes nothing until the status write
       * actually succeeds; canceling changes nothing at all. */}
      <Dialog open={confirmIdea !== null} onOpenChange={(open: boolean) => { if (!open) setConfirmIdea(null); }}>
        {/* `popup-glass-strong` (`index.css`, user-reported, live, round 3)
         * — see the "Generating…" dialog above's own doc comment. */}
        <DialogContent className="popup-glass-strong">
          <DialogHeader>
            <DialogTitle>{t('confirmSelect.title')}</DialogTitle>
            <DialogDescription>{t('confirmSelect.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmIdea(null)}>
              {t('confirmSelect.cancel')}
            </Button>
            <Button type="button" onClick={() => void handleConfirmSelect()}>
              {t('confirmSelect.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
