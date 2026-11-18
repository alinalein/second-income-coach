import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { convertMoney, formatMoney, projectionResponseSchema, type ProjectionResponse } from '@app/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';

export interface ProjectionCardProps {
  planId: string;
}

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
export function ProjectionCard({ planId }: ProjectionCardProps) {
  const { t, i18n } = useTranslation('plan');
  const [data, setData] = React.useState<ProjectionResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);

    fetch(`/api/plans/${planId}/projection`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const body: unknown = await res.json();
        const result = projectionResponseSchema.safeParse(body);
        if (result.success) {
          setData(result.data);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [planId]);

  const locale = LOCALE_BY_LANGUAGE[i18n.language] ?? 'en-US';
  const progressPercent = data ? Math.round(data.progressRatio * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projectionCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {failed ? (
          <p className="text-muted-foreground" role="alert">
            {t('projectionCard.loadFailed')}
          </p>
        ) : !data ? (
          <p className="text-muted-foreground">{t('projectionCard.loading')}</p>
        ) : (
          <>
            <AmountLine
              data={data}
              locale={locale}
              prefix={t('projectionCard.amountPrefix')}
              estimateLabel={t('projectionCard.estimateBadge')}
              estimateLabelFull={t('projectionCard.estimateBadgeFull')}
            />
            {/* Bug fix (user-reported): restored as a required part of the
             * card (epics.md Story 4.4 AC) — this line stays even though
             * `StatusPanel`'s own "Next" region also names the next step
             * with its full description; only the *title* renders here
             * (never the description) to keep the duplication feeling
             * minimal. Omitted entirely when there is no next step (the
             * plan's last step, or a completed plan) — AC: "the next
             * step's own title ... no invented text." */}
            {data.unlockedOpportunity ? (
              <p className="text-xs text-muted-foreground">
                {t('projectionCard.paceSubline', { opportunity: data.unlockedOpportunity.title })}
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
