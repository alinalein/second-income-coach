import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { currentStepResponseSchema, type CurrentStepResponse, type ChatMessage, type PlanStatus } from '@app/shared';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { stripLeadingBulletMarker } from '../../lib/utils';
import { StepActions } from './StepActions';

/**
 * Bug fix (user-reported, live): "this should not happen, you were supposed
 * to fix that — how am I supposed to fix any dev server, or any user that
 * uses the app?" — a transient fetch failure (a cold start, a brief network
 * blip, a backend restart) used to be a dead end: "Couldn't load your
 * current step," forever, with no way forward short of a full page reload a
 * real user has no reason to think of. Two silent automatic retries
 * (backing off 1s, then 2s) absorb the common transient case with nothing
 * for the user to do at all; a "Try again" button is the fallback once
 * those are exhausted too.
 */
const AUTO_RETRY_DELAYS_MS = [1_000, 2_000];

export interface StatusPanelProps {
  planId: string;
  /** UI fix (user-reported): "it should not say 'your plan', it should say
   * 'your plan for <idea>'" — interpolated into `statusPanel.title`. */
  ideaTitle: string;
  /** Spec 2.12 AC8: forwarded from `PlanWorkspace` down through `StepActions`
   * — fires with the server's own start-of-step chat acknowledgment once
   * `start_step` succeeds and produced one (fail-open: omitted entirely on
   * any model-call failure/flag/timeout). */
  onStepStarted?: (message: ChatMessage) => void;
  /** Bug fix (user-reported, live): forwarded from `StepActions` — fires
   * once, only on the plan's final `complete_step`, so `PlanWorkspace.tsx`
   * can flip its own cached plan status to `completed` and show the
   * completion chat message live, instead of only after a reload. */
  onPlanCompleted?: (message?: ChatMessage) => void;
  /** Story 4.1 (AC, follow-up), item 2: fires whenever a Start/Complete
   * action here succeeds, in addition to this panel's own refetch — lets
   * `PlanWorkspace.tsx` refresh the projection card too, without this file
   * reaching into that sibling component directly. */
  onPlanActivityChanged?: () => void;
  /** Bug fix (user-reported, live): forwarded to `StepActions` as its own
   * `disabled` — a `draft` plan (still awaiting `PlanActivationPanel`'s
   * review) must not let Start/Mark-as-done be clicked yet. */
  planStatus: PlanStatus;
}

/** Bug fix (user-reported): the "Next" region shows only a short preview of
 * the next step's description, never the full text — word-boundary
 * truncation (never mid-word), same shape as the backend's own
 * `truncateAtWordBoundary` (`generate_ideas.ts`), kept local here since it's
 * a display-only concern with no shared schema behind it. */
const NEXT_STEP_PREVIEW_MAX_LENGTH = 60;

function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpaceIndex = cut.lastIndexOf(' ');
  const trimmed = (lastSpaceIndex > 0 ? cut.slice(0, lastSpaceIndex) : cut).replace(/[.,;:!?-]+$/, '');
  return `${trimmed}…`;
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
 * 4.1 adds the start/complete step actions as their own component rendered
 * here — this file's own layout is untouched by that later story (Code Map
 * ownership table). The energy/status check-in moved to its own dismissible
 * pop-up (`EnergyCheckInPopup`, AC follow-up) — no longer rendered here.
 *
 * Bug fix (user-reported): "there should be no transition [on the card] —
 * only the [Start this step] button disappears, smoothly, without the
 * card's height jumping." A refetch after an action just swaps `step`
 * directly, no fade on this card's own content — `StepActions`'s own
 * button animates its own disappearance instead.
 *
 * Bug fix (user-reported, live): `planStatus` disables `StepActions`
 * while the plan is still `draft` (awaiting review) — the backend rejects
 * the same call too (`PlanNotActiveError`), this is just the UI mirror.
 */
export function StatusPanel({ planId, ideaTitle, onStepStarted, onPlanCompleted, onPlanActivityChanged, planStatus }: StatusPanelProps) {
  const { t, i18n } = useTranslation('plan');
  const [step, setStep] = React.useState<CurrentStepResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Story 4.2 (AD-15): true only for the fetch that just detected a gap —
  // the banner it drives is shown once, for this one load.
  const [showGapBanner, setShowGapBanner] = React.useState(false);
  // Cancels whichever attempt chain (automatic retries included) is
  // currently in flight — reassigned every time `loadCurrentStep` starts a
  // new chain, and invoked both there (to cancel a stale previous chain)
  // and on unmount, so exactly one thing is ever responsible for stopping a
  // chain regardless of whether it was started by the mount effect or a
  // manual "Try again" click.
  const cancelLoadRef = React.useRef<() => void>(() => undefined);

  const loadCurrentStep = React.useCallback(() => {
    cancelLoadRef.current();
    let cancelled = false;
    let retryTimer: number | undefined;
    cancelLoadRef.current = () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };

    function attempt(attemptIndex: number) {
      fetch(`/api/plans/${planId}/current-step`, { credentials: 'include' })
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) {
            retryOrFail(attemptIndex);
            return;
          }
          const body: unknown = await res.json();
          const result = currentStepResponseSchema.safeParse(body);
          if (result.success) {
            setStep(result.data);
            setFailed(false);
            if (result.data.gapDetected) setShowGapBanner(true);
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
    setStep(null);
    setFailed(false);
    setShowGapBanner(false);
    loadCurrentStep();
    return () => cancelLoadRef.current();
  }, [loadCurrentStep]);

  const handleRetry = React.useCallback(() => {
    setFailed(false);
    loadCurrentStep();
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
          <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground" role="alert">
              {t('statusPanel.loadFailed')}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
              {t('statusPanel.retryButton')}
            </Button>
          </div>
        ) : !step ? (
          <p className="text-muted-foreground">{t('statusPanel.loading')}</p>
        ) : step.current ? (
          <>
            <div>
              {/* Spec 2.12 AC7: the day label sits above the step's own
               * title now (was below the description) — the first thing
               * read is "which day", then what the step is. */}
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('statusPanel.dayLabel', { day: step.current.dayOffset })}</p>
              <p className="font-semibold">{step.current.title}</p>
              {/* UI fix (user-reported): a step's description is a short
               * list of distinct actions (Code Map/create_plan.ts) —
               * rendered as a bullet list, never one prose paragraph.
               * Spec 2.12 AC4: `stripLeadingBulletMarker` drops a doubled
               * leading marker some descriptions already carry, so the
               * list's own CSS bullet is never doubled. */}
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {step.current.description.map((action, index) => (
                  <li key={index}>{stripLeadingBulletMarker(action)}</li>
                ))}
              </ul>
            </div>
            {/* Story 4.1: the start/complete step actions, as their own
             * component — this file's own layout otherwise unchanged. The
             * energy/status check-in control moved out of this permanent
             * column into `EnergyCheckInPopup` (AC, follow-up) — it's no
             * longer rendered here at all. */}
            <StepActions
              planId={planId}
              step={step.current}
              disabled={planStatus !== 'active'}
              onStepChanged={() => {
                loadCurrentStep();
                onPlanActivityChanged?.();
              }}
              onStepStarted={onStepStarted}
              onPlanCompleted={onPlanCompleted}
            />
            {step.next ? (
              <div className="border-t border-dashed border-border pt-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('statusPanel.nextLabel')}</p>
                <p className="font-semibold">{step.next.title}</p>
                {/* Bug fix (user-reported): a short preview only — never
                 * the next step's full description. */}
                <p className="text-muted-foreground">{truncatePreview(step.next.description[0]!, NEXT_STEP_PREVIEW_MAX_LENGTH)}</p>
              </div>
            ) : null}
          </>
        ) : step.completion ? (
          // Story 4.5 (AC1): "Plan completed" card (completion date, number
          // of completed steps) instead of "No current step yet" — no
          // points/streaks/levels/badges, no Start/Mark-as-done controls
          // (both already absent here since `step.current` is null for a
          // completed plan, which has no `current`-status row left at all).
          <div>
            <p className="font-semibold">{t('statusPanel.completedCard.title')}</p>
            <p className="text-muted-foreground">
              {t('statusPanel.completedCard.completedOn', {
                date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(step.completion.completedAt)),
              })}
            </p>
            <p className="text-muted-foreground">
              {t('statusPanel.completedCard.stepsCompleted', { count: step.completion.completedSteps })}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">{t('statusPanel.noCurrentStep')}</p>
        )}
      </CardContent>
    </Card>
  );
}
