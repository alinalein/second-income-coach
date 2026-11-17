import * as React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ideasResponseSchema,
  convertMoney,
  formatMoney,
  type IdeaResponse,
  type IdeaStatus,
  type CurrencyCode,
  type WeeklyTimeAvailability,
  type Money,
} from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { IdeaEvidence, foreignSourceRegion, useViewerCountry, hasDemandEvidence } from './IdeaEvidence';

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
function applyOptimisticIdeaStatus(current: IdeaResponse[], ideaId: string, status: SettableStatus): IdeaResponse[] {
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
function affectedIdeaIds(current: IdeaResponse[], ideaId: string, status: SettableStatus): string[] {
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
function revertOptimisticIdeaStatus(current: IdeaResponse[], priorById: Map<string, IdeaResponse>): IdeaResponse[] {
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
 * plain-text line gave them. */
function IdeasSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div role="status" aria-live="polite" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">{loadingLabel}</span>
      {[0, 1, 2].map((index) => (
        <div key={index} aria-hidden="true" className="h-64 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

/** AD-24/AD-27: "locale and currency are independent axes" — the active
 * i18n language ('en'/'de') maps to the locale `Intl.NumberFormat` needs.
 * No dedicated UI-language-to-locale layer exists yet (Story 5.4), so this
 * is the minimal mapping this story needs. */
const LOCALE_BY_LANGUAGE: Record<string, string> = { en: 'en-US', de: 'de-DE' };

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
 */
const TYPICAL_GENERATE_DURATION_MS = 82_000;
const PROGRESS_HOLD_PERCENT = 90;
const PROGRESS_TICK_MS = 300;

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
  currency,
  locale,
  onSetStatus,
  pending,
}: {
  idea: IdeaResponse;
  currency: CurrencyCode;
  locale: string;
  onSetStatus: (ideaId: string, status: SettableStatus) => void;
  pending: boolean;
}) {
  const { t } = useTranslation('ideas');
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
  const rationaleLines = idea.rationale.split('\n');
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
  // User-requested follow-up (compact citation line): fetched once per
  // card, shared with both this line and `IdeaEvidence`'s own demand-
  // evidence line below — not two separate `/api/intake` fetches.
  const viewerCountry = useViewerCountry();
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
        <CardTitle className="leading-snug">{idea.title}</CardTitle>
      </div>

      {/* Block: rationale, as a real list — why it fits / first step /
       * optional caveat (Boundary: AC still requires this directly on the
       * card, in both languages, never behind an expansion). */}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {rationaleLines.map((line, index) => (
          // Index-keyed is fine here: this list is never reordered,
          // filtered, or edited in place — only ever rendered once from
          // a persisted, already-validated idea.
          <li key={index}>{line}</li>
        ))}
      </ul>

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
          {hasDemandEvidence(idea) ? <span className="text-xs text-muted-foreground">{t('card.demandEvidenceLabel')}</span> : <span />}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-2 py-1 text-xs"
            // Review fix: every card's toggle otherwise shares the exact
            // same accessible name ("Details"), which is ambiguous the
            // moment more than one idea renders (the normal case — 5 cards
            // at once) for screen-reader users and for role-based lookups.
            // The visible label stays the plain "Details" text below;
            // `aria-label` is what screen readers announce instead.
            aria-label={t('card.detailsToggleAriaLabel', { title: idea.title })}
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
          <IdeaEvidence idea={idea} viewerCountry={viewerCountry} />
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
       * own content (3 buttons) never varies in height across ideas. The
       * action matching the card's current status renders as the primary
       * (`default`) button; the others are `outline`. None is primary
       * while still `suggested`. */}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={idea.status === 'selected' ? 'default' : 'outline'}
          className="flex-1"
          disabled={pending}
          onClick={() => onSetStatus(idea.id, 'selected')}
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
export function IdeasPanel() {
  const { t, i18n } = useTranslation('ideas');
  const [ideas, setIdeas] = React.useState<IdeaResponse[]>([]);
  const [currency, setCurrency] = React.useState<CurrencyCode>('EUR');
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [progress, setProgress] = React.useState(0);
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

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    // See `IntakeForm`'s identical comment: React 19 `<StrictMode>` double-
    // invokes this effect in dev, so this must reset to `true` on every run.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/ideas', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPhase('load-error');
          return;
        }
        const body: unknown = await res.json();
        const result = ideasResponseSchema.safeParse(body);
        if (!result.success) {
          setPhase('load-error');
          return;
        }
        setIdeas(result.data.ideas);
        setCurrency(result.data.currency);
        setPhase('idle');
      })
      .catch(() => {
        if (!cancelled) setPhase('load-error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
  const handleSetIdeaStatus = React.useCallback(
    (ideaId: string, status: SettableStatus) => {
      setStatusUpdateFailed(false);

      const affectedIds = affectedIdeaIds(ideas, ideaId, status);
      const priorById = new Map(ideas.filter((idea) => affectedIds.includes(idea.id)).map((idea) => [idea.id, idea]));

      setPendingIdeaIds((prev) => {
        const next = new Set(prev);
        affectedIds.forEach((id) => next.add(id));
        return next;
      });
      setIdeas((current) => applyOptimisticIdeaStatus(current, ideaId, status));

      fetch(`/api/ideas/${ideaId}/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
        .then((res) => {
          if (!res.ok && isMountedRef.current) {
            setIdeas((current) => revertOptimisticIdeaStatus(current, priorById));
            setStatusUpdateFailed(true);
          }
        })
        .catch(() => {
          if (isMountedRef.current) {
            setIdeas((current) => revertOptimisticIdeaStatus(current, priorById));
            setStatusUpdateFailed(true);
          }
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

  const handleGenerate = React.useCallback(() => {
    setPhase('generating');
    setProgress(0);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

    const startedAt = Date.now();
    const progressIntervalId = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setProgress(Math.min(PROGRESS_HOLD_PERCENT, (elapsedMs / TYPICAL_GENERATE_DURATION_MS) * PROGRESS_HOLD_PERCENT));
    }, PROGRESS_TICK_MS);

    fetch('/api/ideas/generate', { method: 'POST', credentials: 'include', signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json();
        const result = ideasResponseSchema.safeParse(body);
        setProgress(100);
        if (!res.ok || !result.success) {
          if (isMountedRef.current) setPhase('generate-error');
          return;
        }
        // Round 13: ideas are swapped into state here directly from the
        // response — a successful generation already shows the new 5 cards
        // immediately, with no page reload.
        if (isMountedRef.current) {
          setIdeas(result.data.ideas);
          setCurrency(result.data.currency);
          setPhase('idle');
        }
      })
      .catch(() => {
        // Covers both a genuine network failure and `controller.abort()`
        // firing at `GENERATE_TIMEOUT_MS` (an AbortError) — either way the
        // client gives up waiting, hence the combined "failed or timed out"
        // copy (`error.generateFailed`) rather than a timeout-specific one.
        setProgress(100);
        if (isMountedRef.current) setPhase('generate-error');
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        window.clearInterval(progressIntervalId);
      });
  }, []);

  const locale = LOCALE_BY_LANGUAGE[i18n.language] ?? 'en-US';
  const generating = phase === 'generating';

  return (
    <Card aria-busy={generating}>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Fix1: a fixed-height neutral skeleton, never the "no ideas yet"
         * text, while the first `GET /api/ideas` is pending. */}
        {phase === 'loading' ? <IdeasSkeleton loadingLabel={t('loading')} /> : null}
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
            {t('error.generateFailed')}
          </Badge>
        ) : null}
        {/* Story 2.3: independent of `phase` — a failed status change never
         * overrides the load/generate messaging above, and vice versa. */}
        {statusUpdateFailed ? (
          <Badge variant="muted" role="alert">
            {t('error.statusUpdateFailed')}
          </Badge>
        ) : null}
        {/* Round 13: only when genuinely idle and empty — not alongside an
         * error message, which already explains the state. */}
        {phase === 'idle' && ideas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : null}
        {ideas.length > 0 ? (
          <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ideas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                currency={currency}
                locale={locale}
                onSetStatus={handleSetIdeaStatus}
                // Only the card(s) this specific action touches disable —
                // the target, plus any siblings a `selected` sweep demotes
                // (those are genuinely changing too). An unrelated card's
                // own action is unaffected.
                pending={pendingIdeaIds.has(idea.id)}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
      {/*
       * Round 20 (user-requested — revert to round 14 exactly): one footer
       * handles both the first-ever generate (epics.md AC1) and "Generate
       * new ideas" (epics.md AC: regenerate, replacing the `suggested`
       * batch — `generate_ideas.ts`'s own DB-write transaction, round 10,
       * actually does the replace; this button only triggers the same
       * request again) — both buttons already shared this exact code path
       * (only `variant`/label differed by `ideas.length`), so round 22's
       * row layout already applied to both equally.
       *
       * Round 22 (user-requested, annotated screenshot): the progress
       * block moves from *under* the button to *beside* it, in the same
       * row — button on the left, progress bar/status/hint stacked in the
       * remaining width to its right.
       *
       * Round 23 (user-requested): both buttons now use the same solid
       * `default` style (the `outline` variant for "Generate new ideas"
       * is gone — same color as "Generate my 5 ideas"). The progress
       * block's wrapper is now always rendered (never unmounted) and
       * fades via `transition-opacity` instead of popping in/out — since
       * it's always present, it also always reserves its own real height,
       * so the footer doesn't jump when generation starts or ends; no
       * height was guessed/hardcoded for this.
       */}
      {phase !== 'loading' ? (
        <CardFooter className="flex flex-row items-start gap-4">
          <Button type="button" onClick={handleGenerate} disabled={generating} className="shrink-0">
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('generatingButton')}
              </>
            ) : ideas.length > 0 ? (
              t('generateNewButton')
            ) : (
              t('generateButton')
            )}
          </Button>
          {/* Story 2.2 follow-up fix 2: an indeterminate (no percentage) progress
           * indicator while POST /api/ideas/generate is pending — a live region
           * so assistive tech announces the status/hint text as it appears,
           * not just on first render. */}
          <div
            className={`flex flex-1 flex-col gap-2 transition-opacity duration-200 ${generating ? 'opacity-100' : 'opacity-0'}`}
            aria-live="polite"
            role={generating ? 'status' : undefined}
            aria-hidden={!generating}
          >
            <DeterminateProgressBar percent={progress} label={t('generatingStatus')} />
            <p className="text-sm font-medium">{t('generatingStatus')}</p>
            <p className="text-xs text-muted-foreground">{t('generatingHint')}</p>
          </div>
        </CardFooter>
      ) : null}
    </Card>
  );
}
