import * as React from 'react';
import { Loader2 } from 'lucide-react';
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
 * longer than originally measured). */
const GENERATE_TIMEOUT_MS = 190_000;

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
      // defensive mirror of the server's own rule.
      if (idea.status === 'rejected') return idea;
      return { ...idea, status: 'bookmarked' };
    });
  }
  return current.map((idea) => (idea.id === ideaId ? { ...idea, status } : idea));
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
 */
const TYPICAL_GENERATE_DURATION_MS = 56_000;
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
}: {
  money: ReturnType<typeof convertMoney>;
  locale: string;
  estimateLabel: string;
}) {
  return (
    <span className="flex items-center gap-2">
      {formatMoney(money, locale)}
      {money.isEstimate ? <Badge variant="muted">{estimateLabel}</Badge> : null}
    </span>
  );
}

/**
 * Story 2.3 Fix2 (compact-rate layout, same shape in both languages — see
 * Design Notes): the rate unit renders as a short suffix glued directly to
 * the formatted amount with no space (`card.rateUnitSuffix.<unit>` — e.g.
 * `"23,34 €"` + `"/Std."` -> `"23,34 €/Std."`, `"€23.34"` + `"/h"` ->
 * `"€23.34/h"`), not the old verbose translated unit word with a space. The
 * "estimate" badge no longer renders beside the value here — it moved to
 * the label cell (`IdeaCard`'s baseline-rate row) so the value stays a
 * single compact line; the vendor-source badge stays beside the value,
 * since it's about *this amount specifically* being a range, not a
 * currency-conversion caveat shared by the whole row.
 */
function BaselineRateDisplay({
  idea,
  currency,
  locale,
  vendorSourceLabel,
}: {
  idea: IdeaResponse;
  currency: CurrencyCode;
  locale: string;
  vendorSourceLabel: string;
}) {
  const { t } = useTranslation('ideas');
  const low = convertMoney(idea.baselineRateLow, currency);
  const high = convertMoney(idea.baselineRateHigh, currency);
  const suffix = t(`card.rateUnitSuffix.${idea.rateUnit}`);

  return (
    <span className="flex flex-wrap items-center justify-end gap-2 text-right">
      <span>
        {idea.isVendorSource
          ? `${formatMoney(low, locale)}–${formatMoney(high, locale)}${suffix}`
          : `${formatMoney(low, locale)}${suffix}`}
      </span>
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
 * Layout (Story 2.2 follow-up fix round 3, fix 2b): CSS **subgrid**, not
 * just equal card height. `IdeasPanel`'s grid declares 5 explicit row
 * tracks per card-row (`[grid-auto-rows:...]`); each `Card` spans all 5
 * (`row-span-5`) and declares its own rows as `subgrid`, so its 5 direct
 * children — title+type / description / cited-fields / stats / citation —
 * size against the *same* 5 shared tracks every sibling card in that row
 * uses. That is what makes e.g. every card's "Your skills & interests"
 * badge row start at an identical height regardless of how long any one
 * card's rationale is — a fixed-height estimate would break the moment
 * real content varies; subgrid sizes each track from whichever sibling
 * actually needs the most room there. `items-stretch` on the outer grid
 * still makes same-row cards equal overall height; subgrid is what aligns
 * what's *inside* them.
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
  const monthlyPotentialSubLabel = t('card.monthlyPotentialSubLabel');
  const estimateLabel = t('card.estimateBadge');
  // Story 2.3 Fix2: the baseline-rate row's "estimate" badge now lives in
  // the label cell (below), not beside `BaselineRateDisplay`'s value — this
  // is the one place that decides whether it shows at all.
  const baselineRateIsEstimate =
    convertMoney(idea.baselineRateLow, currency).isEstimate || convertMoney(idea.baselineRateHigh, currency).isEstimate;
  // Fix round 4, fix 3: 2-3 bullet lines, newline-separated within the one
  // rationale string (shared/schemas/ideas.ts's rationaleSchema enforces
  // the shape) — split for a real <ul>/<li> list, never raw \n in prose.
  const rationaleLines = idea.rationale.split('\n');
  // Story 2.3 AC2: shared fixed-width label column so values start at a
  // consistent x-position regardless of label length/language (Code Map).
  const labelClassName = 'w-36 shrink-0 text-muted-foreground';

  return (
    <Card className="grid h-full row-span-5 grid-cols-1 [grid-template-rows:subgrid]">
      {/* Row 1: status badge (Story 2.3 AC2, only once the idea has left
       * `suggested`) + title + idea type. */}
      <CardHeader className="gap-1.5 pb-2">
        {idea.status !== 'suggested' ? (
          <Badge variant={idea.status === 'selected' ? 'default' : 'muted'} className="w-fit">
            {t(`status.${idea.status}`)}
          </Badge>
        ) : null}
        <CardTitle>{idea.title}</CardTitle>
        <Badge variant="muted" className="w-fit">
          {t(`ideaType.${idea.ideaType}`)}
        </Badge>
      </CardHeader>

      {/* Row 2: rationale, as a real list — why it fits / first step /
       * optional caveat (Boundary: AC still requires this directly on the
       * card, in both languages, never behind an expansion). */}
      <CardContent className="pt-0 pb-2">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {rationaleLines.map((line, index) => (
            // Index-keyed is fine here: this list is never reordered,
            // filtered, or edited in place — only ever rendered once from
            // a persisted, already-validated idea.
            <li key={index}>{line}</li>
          ))}
        </ul>
      </CardContent>

      {/* Row 3: cited intake fields. */}
      <CardContent className="flex flex-wrap content-start gap-1.5 pt-0 pb-2">
        {idea.citedIntakeFields.map((field) => (
          <Badge key={field} variant="outline">
            {t(`citedIntakeFields.${field}`)}
          </Badge>
        ))}
      </CardContent>

      {/* Row 4: structured stats. Story 2.3 AC2: every label cell shares
       * `labelClassName`'s fixed width so values start at a consistent
       * x-position regardless of label length/language — the per-row
       * `<div>` wrapper itself is unchanged (Design Notes: existing tests
       * locate a row via `closest('div')` on the label text). */}
      <CardContent className="flex flex-col content-start gap-2 pt-0 pb-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.weeklyTimeLabel')}</span>
          <span>{t(`weeklyTimeAvailability.${idea.weeklyTimeCommitment}`)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.startupCostLabel')}</span>
          <AmountWithEstimateBadge money={startupCost} locale={locale} estimateLabel={estimateLabel} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={labelClassName}>{t('card.riskLevelLabel')}</span>
          <span>{t(`riskTolerance.${idea.riskLevel}`)}</span>
        </div>
        {/* Story 2.3 Fix2: the "estimate" badge moved from beside the value
         * into this label cell (stacked below the label text) — the value
         * cell (`BaselineRateDisplay`) is now just the compact
         * amount+suffix, plus the vendor badge when applicable. */}
        <div className="flex items-start justify-between gap-3">
          <span className={`flex flex-col gap-0.5 ${labelClassName}`}>
            <span>{t('card.baselineRateLabel')}</span>
            {baselineRateIsEstimate ? <Badge variant="muted">{estimateLabel}</Badge> : null}
          </span>
          <BaselineRateDisplay idea={idea} currency={currency} locale={locale} vendorSourceLabel={t('card.vendorSourceLabel')} />
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
             * a currency conversion happens to occur. */}
            <span className="flex items-center gap-2">
              {formatMoney(monthlyPotentialConverted, locale)}
              <Badge variant="muted">{estimateLabel}</Badge>
            </span>
          </div>
        ) : null}
      </CardContent>

      {/* Row 5: citation — the last subgrid row, so always the card's
       * bottom-most section regardless of how tall rows 1-4 end up. The
       * source-trust tier and (when applicable) the "unverified" label sit
       * next to the citation link. Round 11 (user-requested removal): the
       * quoted evidence sentence (`baselineRateQuote`) no longer renders
       * here — checked against epics.md's Story 2.2 AC and AD-6 first: AD-6
       * only requires the rate *value + citation* to be persisted/shown on
       * the card, never the quote text itself, so this is a pure UI
       * simplification, not a requirement removal. `baselineRateQuote`
       * itself is untouched server-side — still required and verified
       * (AD-4's quote-matches-search-results check), just not displayed. */}
      <CardFooter className="flex flex-col items-stretch gap-1 pt-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Citation citation={idea.baselineRateCitation} />
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline">{t(`card.sourceTrustTier.${idea.sourceTrustTier}`)}</Badge>
            {idea.isRateUnverified ? <Badge variant="muted">{t('card.unverifiedLabel')}</Badge> : null}
          </span>
        </div>
        {/* Story 2.3 AC2: Select/Bookmark/Reject directly on every card,
         * never behind a menu — a second block stacked below the citation
         * row (`CardFooter` is already `flex flex-col`, so this doesn't need
         * its own subgrid track). The action matching the card's current
         * status renders as the primary (`default`) button; the others are
         * `outline`. None is primary while still `suggested`. */}
        <div className="flex gap-2 pt-1">
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
      </CardFooter>
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
  // Story 2.3: `pendingIdeaId` disables that one card's 3 actions while its
  // own request is in flight; `statusUpdateFailed` is independent of
  // `phase` (a status-change failure never replaces the load/generate error
  // messaging — the ideas grid itself stays exactly as it was, snapshot-
  // reverted, right next to this notice).
  const [pendingIdeaId, setPendingIdeaId] = React.useState<string | null>(null);
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
   * snapshot-based revert plus `error.statusUpdateFailed` if the real
   * `POST /api/ideas/:id/status` call fails or the response isn't ok. Never
   * calls `set_idea_status`'s persistence logic directly (Boundary) — only
   * ever this one HTTP call.
   */
  const handleSetIdeaStatus = React.useCallback(
    (ideaId: string, status: SettableStatus) => {
      setStatusUpdateFailed(false);
      setPendingIdeaId(ideaId);
      const snapshot = ideas;
      setIdeas((current) => applyOptimisticIdeaStatus(current, ideaId, status));

      fetch(`/api/ideas/${ideaId}/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
        .then((res) => {
          if (!res.ok && isMountedRef.current) {
            setIdeas(snapshot);
            setStatusUpdateFailed(true);
          }
        })
        .catch(() => {
          if (isMountedRef.current) {
            setIdeas(snapshot);
            setStatusUpdateFailed(true);
          }
        })
        .finally(() => {
          if (isMountedRef.current) setPendingIdeaId(null);
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
          <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3 [grid-auto-rows:auto_auto_auto_auto_auto]">
            {ideas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                currency={currency}
                locale={locale}
                onSetStatus={handleSetIdeaStatus}
                // Every card's 3 actions disable while *any* status request
                // is in flight, not just the clicked card's own — a second
                // concurrent request could race the first's transaction
                // (lock-order-inversion deadlock risk) and its failure-
                // revert could stomp a change the first request already
                // applied.
                pending={pendingIdeaId !== null}
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
