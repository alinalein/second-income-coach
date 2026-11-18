import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { startStepResponseSchema, completeStepResponseSchema, type PlanStepResponse, type ChatMessage } from '@app/shared';
import { Button } from '../../components/ui/button';

export interface StepActionsProps {
  planId: string;
  step: PlanStepResponse;
  /** Re-fetches `get_current_step` once an action succeeds, so the
   * newly-current/next step shows without a page reload. */
  onStepChanged: () => void;
  /** Spec 2.12 AC8: fires once, only on a successful `start`, with the
   * server's own chat acknowledgment — separate from `onStepChanged` so
   * `complete()` (which never produces one) can't accidentally trigger it. */
  onStepStarted?: (message: ChatMessage) => void;
  /** Bug fix (user-reported, live): true while the plan itself isn't
   * `active` yet (still `draft`, awaiting `PlanActivationPanel`'s review) —
   * both buttons are disabled; the route rejects the call either way
   * (`PlanNotActiveError`), this is the UI-level mirror of that, not the
   * only guard. */
  disabled?: boolean;
}

type Phase = 'idle' | 'busy' | 'failed';

/**
 * Story 4.1 (AD-13 state-machine rule): the Start/Complete actions for the
 * plan's current step — its own component rendered by `StatusPanel`, never
 * editing `PlanWorkspace`'s layout. Calls the direct `start_step`/
 * `complete_step` routes, which reject (409) if `step` is no longer the
 * plan's own current step by the time the request lands.
 *
 * Bug fix (user-reported, follow-up — reserved-slot redesign): pressing
 * "Start this step" must never change this block's rendered height (the
 * status card jumping pushed the projection card below it). Earlier rounds
 * tried animating the Start button's collapse (`max-height`, then
 * `grid-template-rows`) — both still removed the button from flow, so the
 * block's height (and therefore the cards below it) still moved, just with
 * a transition instead of a snap. This version reserves a fixed slot
 * instead: the Start button always renders, at the same size — once
 * `step.startedAt` is set, it becomes a disabled "In progress" pill *in the
 * same slot* rather than disappearing. "Mark as done" stays at its own
 * fixed position below it the whole time. No height animation anywhere in
 * this block; both buttons are `w-full` (same width, text centered the
 * same way on both).
 *
 * Spec 2.12 AC8: the old static "You've started this step." hint is
 * dropped entirely (not just moved to a reserved slot) — the server's own
 * live chat acknowledgment (`onStepStarted`, appended to the plan thread
 * via `ChatThread`'s `incomingMessage` prop) already tells the user this,
 * so a second, static confirmation in this card would be redundant.
 * `stepActions.startedHint` stays unused in the locale files (Code Map:
 * avoids touching unrelated i18n key-coverage tests).
 *
 * Bug fix (user-reported): `phase` ("busy" while either request is in
 * flight) used to also drive each button's own *label* ("Starting…" /
 * "Finishing…") — since it's one shared flag, starting the step made the
 * *other*, untouched "Mark as done" button say "Finishing…" too. Labels no
 * longer depend on `phase` at all: the Start slot only ever reads "Start
 * this step" or (once `step.startedAt` is set) "In progress" — no
 * transitional text — and "Mark as done" always reads exactly that.
 * `phase === 'busy'` still disables both buttons during the in-flight
 * request (prevents a double-submit), just without changing either label.
 */
export function StepActions({ planId, step, onStepChanged, onStepStarted, disabled = false }: StepActionsProps) {
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
        const parsed = startStepResponseSchema.safeParse(body);
        setPhase(parsed.success ? 'idle' : 'failed');
        // Spec 2.12 AC8: `chatMessage` is present only when the server's own
        // direct model call produced one (fail-open — absent on any
        // failure/flag/timeout, never an error on its own).
        if (parsed.success && parsed.data.chatMessage) onStepStarted?.(parsed.data.chatMessage);
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

  const startDisabled = phase === 'busy' || disabled || Boolean(step.startedAt);

  return (
    <div className="flex flex-col gap-2">
      {/* Bug fix (user-reported, follow-up): this is the one reserved slot
       * — always one `Button`, never swapped for a different element or
       * removed from flow, so its height never changes. */}
      <Button type="button" size="sm" className="w-full" disabled={startDisabled} onClick={start}>
        {step.startedAt ? t('stepActions.inProgress') : t('stepActions.startButton')}
      </Button>
      <Button type="button" size="sm" variant="outline" className="w-full" disabled={phase === 'busy' || disabled} onClick={complete}>
        {t('stepActions.completeButton')}
      </Button>
      {phase === 'failed' ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t('stepActions.failed')}
        </p>
      ) : null}
    </div>
  );
}
