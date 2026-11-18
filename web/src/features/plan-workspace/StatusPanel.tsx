import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { currentStepResponseSchema, type CurrentStepResponse } from '@app/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { CheckInControl } from './CheckInControl';
import { StepActions } from './StepActions';

export interface StatusPanelProps {
  planId: string;
  /** UI fix (user-reported): "it should not say 'your plan', it should say
   * 'your plan for <idea>'" — interpolated into `statusPanel.title`. */
  ideaTitle: string;
}

/**
 * Code Map: "`StatusPanel` (current + next step via `get_current_step`,
 * timeline)" — the one place this story reads
 * `GET /api/plans/:planId/current-step`. Never fetches or renders more than
 * current+next (AD-4: "`get_current_step` is the sole path ... capped to
 * current+next" — there is no other endpoint to read the rest of the plan
 * from anyway). The "timeline" piece is the current step's own `dayOffset`
 * ("Day N") — a lightweight progress cue, not a list of every step.
 *
 * 4.1 adds the start/complete step actions and the check-in control as
 * their own components rendered here/by the chat input — this file's own
 * layout is untouched by that later story (Code Map ownership table).
 *
 * Bug fix (user-reported): "there should be no transition [on the card] —
 * only the [Start this step] button disappears, smoothly, without the
 * card's height jumping." A refetch after an action just swaps `step`
 * directly, no fade on this card's own content — `StepActions`'s own
 * button animates its own disappearance instead.
 */
export function StatusPanel({ planId, ideaTitle }: StatusPanelProps) {
  const { t } = useTranslation('plan');
  const [step, setStep] = React.useState<CurrentStepResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Story 4.2 (AD-15): true only for the fetch that just detected a gap —
  // the banner it drives is shown once, for this one load.
  const [showGapBanner, setShowGapBanner] = React.useState(false);

  const loadCurrentStep = React.useCallback(() => {
    let cancelled = false;

    fetch(`/api/plans/${planId}/current-step`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const body: unknown = await res.json();
        const result = currentStepResponseSchema.safeParse(body);
        if (result.success) {
          setStep(result.data);
          setFailed(false);
          if (result.data.gapDetected) setShowGapBanner(true);
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

  React.useEffect(() => {
    setStep(null);
    setFailed(false);
    setShowGapBanner(false);
    return loadCurrentStep();
  }, [loadCurrentStep]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('statusPanel.title', { ideaTitle })}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {showGapBanner ? (
          <p className="text-muted-foreground" role="status">
            {t('statusPanel.gapBanner')}
          </p>
        ) : null}
        {failed ? (
          <p className="text-muted-foreground" role="alert">
            {t('statusPanel.loadFailed')}
          </p>
        ) : !step ? (
          <p className="text-muted-foreground">{t('statusPanel.loading')}</p>
        ) : step.current ? (
          <>
            <div>
              <p className="font-semibold">{step.current.title}</p>
              {/* UI fix (user-reported): a step's description is a short
               * list of distinct actions (Code Map/create_plan.ts) —
               * rendered as a bullet list, never one prose paragraph. */}
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {step.current.description.map((action, index) => (
                  <li key={index}>{action}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">{t('statusPanel.dayLabel', { day: step.current.dayOffset })}</p>
            </div>
            {/* Story 4.1: the start/complete step actions and the
             * energy/status check-in control, as their own components —
             * this file's own layout otherwise unchanged. */}
            <StepActions planId={planId} step={step.current} onStepChanged={loadCurrentStep} />
            <CheckInControl planId={planId} checkedInToday={step.checkedInToday} />
            {step.next ? (
              <div className="border-t border-dashed border-border pt-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('statusPanel.nextLabel')}</p>
                <p>{step.next.title}</p>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">{t('statusPanel.noCurrentStep')}</p>
        )}
      </CardContent>
    </Card>
  );
}
