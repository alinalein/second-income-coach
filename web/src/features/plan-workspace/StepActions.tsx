import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { startStepResponseSchema, completeStepResponseSchema, type PlanStepResponse } from '@app/shared';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export interface StepActionsProps {
  planId: string;
  step: PlanStepResponse;
  /** Re-fetches `get_current_step` once an action succeeds, so the
   * newly-current/next step shows without a page reload. */
  onStepChanged: () => void;
}

type Phase = 'idle' | 'busy' | 'failed';

/**
 * Story 4.1 (AD-13 state-machine rule): the Start/Complete actions for the
 * plan's current step — its own component rendered by `StatusPanel`, never
 * editing `PlanWorkspace`'s layout. Calls the direct `start_step`/
 * `complete_step` routes, which reject (409) if `step` is no longer the
 * plan's own current step by the time the request lands.
 *
 * Bug fix (user-reported): "there should be no transition, only the
 * [Start] button disappears but smooth — the height of the div doesn't
 * change [abruptly]." No whole-card fade (`StatusPanel` no longer wraps its
 * content in one) — only the "Start this step" button itself animates
 * (`max-h-0`/`opacity-0`, `overflow-hidden`) once `step.startedAt` is set,
 * so it fades and collapses smoothly in place while everything around it
 * (the "Mark as done" button, the next-step region) stays put.
 */
export function StepActions({ planId, step, onStepChanged }: StepActionsProps) {
  const { t } = useTranslation('plan');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [planCompleted, setPlanCompleted] = React.useState(false);

  function start() {
    setPhase('busy');
    fetch(`/api/plans/${planId}/steps/${step.id}/start`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          setPhase('failed');
          return;
        }
        const body: unknown = await res.json();
        setPhase(startStepResponseSchema.safeParse(body).success ? 'idle' : 'failed');
        onStepChanged();
      })
      .catch(() => setPhase('failed'));
  }

  function complete() {
    setPhase('busy');
    fetch(`/api/plans/${planId}/steps/${step.id}/complete`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          setPhase('failed');
          return;
        }
        const body: unknown = await res.json();
        const parsed = completeStepResponseSchema.safeParse(body);
        if (!parsed.success) {
          setPhase('failed');
          return;
        }
        setPlanCompleted(parsed.data.planCompleted);
        setPhase('idle');
        onStepChanged();
      })
      .catch(() => setPhase('failed'));
  }

  if (planCompleted) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('stepActions.planCompletedHint')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className={cn('overflow-hidden transition-all duration-300 ease-in-out', step.startedAt ? 'max-h-0 opacity-0' : 'max-h-10 opacity-100')}>
          <Button type="button" size="sm" disabled={phase === 'busy'} onClick={start}>
            {phase === 'busy' ? t('stepActions.starting') : t('stepActions.startButton')}
          </Button>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={phase === 'busy'} onClick={complete}>
          {phase === 'busy' ? t('stepActions.completing') : t('stepActions.completeButton')}
        </Button>
      </div>
      {step.startedAt ? <p className="text-xs text-muted-foreground">{t('stepActions.startedHint')}</p> : null}
      {phase === 'failed' ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t('stepActions.failed')}
        </p>
      ) : null}
    </div>
  );
}
