import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { convertMoney, formatMoney, projectionResponseSchema, type ProjectionResponse, type PlanStatus } from '@app/shared';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';

export interface ProjectionCardProps {
  planId: string;
  /** Story 4.5 (AC2): optional so every existing caller/test keeps working
   * unchanged — only a `'completed'` plan relabels the card as the result
   * of the finished plan. */
  planStatus?: PlanStatus;
  /** Bug fix (user-reported, live): bump this to silently refetch in the
   * background instead of remounting via a `key` change (the previous
   * mechanism, `PlanWorkspace.tsx`'s own `projectionRefreshKey`) — a
   * remount reset `data` to `null` first, which dropped the card back to
   * its plain "Loading…" text and then snapped to the new numbers: a
   * visible jump right after "Mark as done" already updated the step
   * above it instantly. This refetches without ever clearing the
   * last-loaded data, so the old amount stays on screen until the new one
   * is ready to replace it outright. */
  refreshToken?: number;
}

/** Bug fix (user-reported, live): same precedent as `StatusPanel.tsx`'s own
 * `AUTO_RETRY_DELAYS_MS` — a transient fetch failure must never be a dead
 * end with no way forward. */
const AUTO_RETRY_DELAYS_MS = [1_000, 2_000];

/** Same i18n-language -> `Intl.NumberFormat` locale map as `IdeasPanel.tsx`
 * (AD-24: "locale and currency are independent axes"). */
const LOCALE_BY_LANGUAGE: Record<string, string> = { en: 'en-US', de: 'de-DE' };

function AmountLine({
  data,
  locale,
  prefix,
  estimateLabel,
  estimateLabelFull,
}: {
  data: ProjectionResponse;
  locale: string;
  prefix: string;
  estimateLabel: string;
  estimateLabelFull: string;
}) {
  // AD-27: "every converted amount is visibly labeled as an estimate" — the
  // "(est.)" badge below is that label, shown only on a genuine currency
  // conversion. `prefix` ("~") is a separate, always-shown cue that the
  // projection itself is approximate (layout-preview.html's own "~$38/mo"),
  // independent of whether a conversion happened.
  const converted = convertMoney(data.estimate, data.currency);
  return (
    <p className="text-lg font-semibold">
      {prefix}
      {formatMoney(converted, locale)}
      {converted.isEstimate ? (
        <span className="ml-1 text-xs font-normal text-muted-foreground" aria-label={estimateLabelFull}>
          {estimateLabel}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Code Map (Story 3.1): "projection card extension point (a slot in the
 * sidebar/header) ... renders nothing until 4.4. Projection card content:
 * own component, filled via `get_projection`." Fills that slot in
 * `PlanWorkspace.tsx` — this story never edits the workspace layout file
 * itself.
 *
 * Fetches `GET /api/plans/:planId/projection` on mount (same fetch-on-mount
 * shape as `StatusPanel.tsx`'s own `current-step` read). Money is handled
 * exactly like Story 2.2's idea cards: the server returns the raw sourced
 * `estimate` + the user's `currency` setting; this component converts and
 * formats it via the one shared `shared/money.ts` helper (AD-27) — never a
 * second money implementation.
 */
export function ProjectionCard({ planId, planStatus, refreshToken }: ProjectionCardProps) {
  const { t, i18n } = useTranslation('plan');
  const [data, setData] = React.useState<ProjectionResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  // See `StatusPanel.tsx`'s own `cancelLoadRef` for the full doc comment —
  // identical shape, same reason: one thing responsible for cancelling
  // whichever attempt chain is in flight, regardless of whether it was
  // started by the mount effect or a manual "Try again" click.
  const cancelLoadRef = React.useRef<() => void>(() => undefined);

  const loadProjection = React.useCallback(() => {
    cancelLoadRef.current();
    let cancelled = false;
    let retryTimer: number | undefined;
    cancelLoadRef.current = () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };

    function attempt(attemptIndex: number) {
      fetch(`/api/plans/${planId}/projection`, { credentials: 'include' })
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) {
            retryOrFail(attemptIndex);
            return;
          }
          const body: unknown = await res.json();
          const result = projectionResponseSchema.safeParse(body);
          if (result.success) {
            setData(result.data);
            setFailed(false);
          } else {
            retryOrFail(attemptIndex);
          }
        })
        .catch(() => {
          if (!cancelled) retryOrFail(attemptIndex);
        });
    }

    function retryOrFail(attemptIndex: number) {
      if (cancelled) return;
      if (attemptIndex < AUTO_RETRY_DELAYS_MS.length) {
        retryTimer = window.setTimeout(() => attempt(attemptIndex + 1), AUTO_RETRY_DELAYS_MS[attemptIndex]);
      } else {
        setFailed(true);
      }
    }

    attempt(0);
  }, [planId]);

  React.useEffect(() => {
    setData(null);
    setFailed(false);
    loadProjection();
    return () => cancelLoadRef.current();
  }, [loadProjection]);

  // Bug fix (user-reported, live): a silent background refetch — never
  // clears `data`/`failed` first, so the card keeps showing whatever it
  // last loaded for the whole duration of this request, swapping straight
  // to the new numbers once it resolves. Skips its own first run (the
  // mount effect above already covers the initial load for this exact
  // `refreshToken` value) — only a later *change* means "something
  // happened, refresh in the background."
  const isFirstRefreshRef = React.useRef(true);
  React.useEffect(() => {
    if (isFirstRefreshRef.current) {
      isFirstRefreshRef.current = false;
      return;
    }
    loadProjection();
    // `loadProjection` is `planId`-scoped and already covered by the mount
    // effect above; this effect must fire only on a genuine `refreshToken`
    // bump, never a `planId` change re-creating `loadProjection` too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleRetry = React.useCallback(() => {
    setFailed(false);
    loadProjection();
  }, [loadProjection]);

  const locale = LOCALE_BY_LANGUAGE[i18n.language] ?? 'en-US';
  const progressPercent = data ? Math.round(data.progressRatio * 100) : 0;
  // Story 4.5 (AC2): the final estimate is labelled as the result of the
  // finished plan, not an ongoing projection — same estimate/math as
  // before (Story 4.4), only the card's own framing changes.
  const isCompleted = planStatus === 'completed';
  // Bug fix (user-reported, live): a `draft` plan hasn't been confirmed
  // yet — showing a computed-looking "~€0.00" here would read as if a real
  // (zero) estimate had already run; "—" is the honest "nothing to show
  // yet" placeholder instead.
  const isDraft = planStatus === 'draft';
  // Bug fix (user-reported, live): "a bare 0 must never stand alone" — a
  // genuine zero estimate (the plan is active, but no step/check-in has
  // happened yet) gets an explanatory line under it instead of just
  // sitting there looking broken. Never shown for `isDraft` (which shows
  // "—", not a "0" at all) or `isCompleted` (that card has its own
  // framing, and a finished plan realistically never nets exactly 0).
  const showsZeroEstimateHint = !isDraft && !isCompleted && data?.estimate.amountMinorUnits === 0;
  // Bug fix (user-reported, live, correction to an earlier message): never
  // the next step's own title (that duplicates `StatusPanel`'s own "Next"
  // region) — the concrete value it unlocks instead, computed server-side
  // (`get_projection.ts`) by the same `computeProjection` with the next
  // step counted as completed. `null` under the exact same "no next step"
  // condition as `unlockedOpportunity` (last step, completed plan) — and
  // never shown for a draft either, same as the main amount above.
  const nextStepConverted =
    !isCompleted && !isDraft && data?.nextStepEstimate ? convertMoney(data.nextStepEstimate, data.currency) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isCompleted ? t('projectionCard.completedTitle') : t('projectionCard.title')}</CardTitle>
        {/* Bug fix (user-reported, live): a one-line explanation of what
         * this number even is — never shown for the completed-plan framing,
         * which already has its own "Result of your finished plan" line. */}
        {!isCompleted ? <p className="text-xs text-muted-foreground">{t('projectionCard.subtitle')}</p> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {failed ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground" role="alert">
              {t('projectionCard.loadFailed')}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
              {t('projectionCard.retryButton')}
            </Button>
          </div>
        ) : !data ? (
          <p className="text-muted-foreground">{t('projectionCard.loading')}</p>
        ) : (
          <>
            {isDraft ? (
              <p className="text-lg font-semibold">—</p>
            ) : (
              <AmountLine
                data={data}
                locale={locale}
                prefix={t('projectionCard.amountPrefix')}
                estimateLabel={t('projectionCard.estimateBadge')}
                estimateLabelFull={t('projectionCard.estimateBadgeFull')}
              />
            )}
            {showsZeroEstimateHint ? <p className="text-xs text-muted-foreground">{t('projectionCard.zeroEstimateHint')}</p> : null}
            {isCompleted ? (
              <p className="text-xs text-muted-foreground">{t('projectionCard.completedLabel')}</p>
            ) : nextStepConverted ? (
              <p className="text-xs text-muted-foreground">
                {t('projectionCard.paceSubline', {
                  amount: `${t('projectionCard.amountPrefix')}${formatMoney(nextStepConverted, locale)}`,
                })}
                {nextStepConverted.isEstimate ? (
                  <span className="ml-1" aria-label={t('projectionCard.estimateBadgeFull')}>
                    {t('projectionCard.estimateBadge')}
                  </span>
                ) : null}
              </p>
            ) : null}
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${progressPercent}%` }} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
