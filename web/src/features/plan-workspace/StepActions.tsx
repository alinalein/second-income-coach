import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  startStepResponseSchema,
  startStepAckResponseSchema,
  completeStepResponseSchema,
  completeStepAckResponseSchema,
  type PlanStepResponse,
  type ChatMessage,
} from '@app/shared';
import { Button } from '../../components/ui/button';

export interface StepActionsProps {
  planId: string;
  step: PlanStepResponse;
  /** Re-fetches `get_current_step` once an action succeeds, so the
   * newly-current/next step shows without a page reload. */
  onStepChanged: () => void;
  /** Spec 2.12 AC8: fires once the chat-acknowledgment request (see
   * `onStepStarting` below) settles with a message — separate from
   * `onStepChanged` so `complete()` (which never produces one) can't
   * accidentally trigger it. */
  onStepStarted?: (message: ChatMessage) => void;
  /** Perf fix (user-reported, live): "Start this step" used to wait on the
   * acknowledgment's own direct model call before responding at all (~2-3s
   * on the default model) — the DB write (`POST .../start`) now responds on
   * its own, and this fires the instant that succeeds, before the
   * acknowledgment (`POST .../start-ack`, fired right after, never
   * awaited) has resolved. Lets the chat show a typing indicator
   * immediately instead of staying silent for however long that second,
   * independent request takes. */
  onStepStarting?: () => void;
  /** Perf fix (user-reported, live): fires once the acknowledgment request
   * settles with no message to show — any of its fail-open branches
   * (moderation/guilt-language flag, timeout) or the request itself
   * failing. Exactly one of this and `onStepStarted` fires per `start()`
   * call that gets past the DB write. */
  onStepStartAckFailed?: () => void;
  /** Bug fix (user-reported, live): fires once, only on a successful
   * `complete()` — never `start()`, which never changes the completed-step
   * count the projection is actually computed from. `StatusPanel.tsx` used
   * to fire its projection-refresh callback from `onStepChanged` itself
   * (shared by both actions), so clicking "Start this step" remounted
   * `ProjectionCard` (its `key` bumps on refresh) for no reason — a visible
   * flicker/jump in the untouched card below with nothing in it to
   * actually update. */
  onStepCompleted?: () => void;
  /** Bug fix (user-reported, live): fires once, only when `complete()`
   * succeeds on the plan's final step (`planCompleted`) — the parent needs
   * this (not just `onStepChanged`) to flip its own cached plan status to
   * `completed` immediately, same timing as before. Story 4.6: no longer
   * carries the completion chat message — that now arrives separately,
   * via `onStepCompletionAck` below, same split as the start flow. */
  onPlanCompleted?: () => void;
  /** Story 4.6 (mirrors `onStepStarting` exactly): fires the instant
   * `complete()`'s own DB write succeeds, before the acknowledgment
   * (`POST .../complete-ack`, fired right after, never awaited) has
   * resolved — lets the chat show a typing indicator immediately instead
   * of staying silent for however long that second, independent request
   * takes. Fires for both a per-step and a final-step completion. */
  onStepCompleting?: () => void;
  /** Story 4.6 (mirrors `onStepStarted` exactly): fires once the
   * acknowledgment request settles with a message to show — the plan's own
   * distinct completion message on the final step, or a per-step one
   * otherwise (never both; the final step's own message is the only one
   * produced for that step). */
  onStepCompletionAck?: (message: ChatMessage) => void;
  /** Story 4.6 (mirrors `onStepStartAckFailed` exactly): fires once the
   * acknowledgment request settles with no message to show. Exactly one of
   * this and `onStepCompletionAck` fires per `complete()` call that gets
   * past the DB write. */
  onStepCompletionAckFailed?: () => void;
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
export function StepActions({
  planId,
  step,
  onStepChanged,
  onStepStarted,
  onStepStarting,
  onStepStartAckFailed,
  onStepCompleted,
  onPlanCompleted,
  onStepCompleting,
  onStepCompletionAck,
  onStepCompletionAckFailed,
  disabled = false,
}: StepActionsProps) {
  const { t } = useTranslation('plan');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [planCompleted, setPlanCompleted] = React.useState(false);

  function start() {
    setPhase('busy');
    fetch(`/api/plans/${planId}/steps/${step.id}/start`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        // Bug fix (user-reported, live): a 409 means this `step` is no
        // longer the plan's own current step (or the plan isn't active) —
        // by the time the click landed, something else had already moved
        // it on. Retrying the exact same `stepId` would just 409 again
        // forever, stuck with no visible way out except a full reload.
        // `onStepChanged()` (the same refetch a success already triggers)
        // pulls the real current step instead, so the view self-corrects.
        if (res.status === 409) {
          setPhase('idle');
          onStepChanged();
          return;
        }
        if (!res.ok) {
          setPhase('failed');
          return;
        }
        const body: unknown = await res.json();
        const parsed = startStepResponseSchema.safeParse(body);
        setPhase(parsed.success ? 'idle' : 'failed');
        onStepChanged();
        if (!parsed.success) return;

        // Perf fix (user-reported, live): the chat acknowledgment is a
        // second, independent request — fired right after the DB write
        // above succeeds, never awaited before responding to the click, so
        // "Start this step" itself only ever waits on the DB write. Fully
        // fail-open, same as before this split: any non-success response,
        // a parse failure, or the fetch itself failing all just mean no
        // message to show, never a failure of the start action itself
        // (which already succeeded).
        onStepStarting?.();
        fetch(`/api/plans/${planId}/steps/${step.id}/start-ack`, { method: 'POST', credentials: 'include' })
          .then(async (ackRes) => {
            if (!ackRes.ok) {
              onStepStartAckFailed?.();
              return;
            }
            const ackBody: unknown = await ackRes.json();
            const ackParsed = startStepAckResponseSchema.safeParse(ackBody);
            if (ackParsed.success && ackParsed.data.chatMessage) {
              onStepStarted?.(ackParsed.data.chatMessage);
            } else {
              onStepStartAckFailed?.();
            }
          })
          .catch(() => onStepStartAckFailed?.());
      })
      .catch(() => setPhase('failed'));
  }

  function complete() {
    setPhase('busy');
    fetch(`/api/plans/${planId}/steps/${step.id}/complete`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        // Bug fix (user-reported, live): same self-correcting fix as
        // `start()` above — see that branch's own comment.
        if (res.status === 409) {
          setPhase('idle');
          onStepChanged();
          return;
        }
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
        if (parsed.data.planCompleted) onPlanCompleted?.();
        onStepChanged();
        onStepCompleted?.();

        // Story 4.6 (mirrors `start()`'s own split exactly): the chat
        // acknowledgment is a second, independent request — fired right
        // after the DB write above succeeds, never awaited before
        // responding to the click, so "Mark as done" itself only ever
        // waits on the DB write. Fully fail-open: any non-success response,
        // a parse failure, or the fetch itself failing all just mean no
        // message to show, never a failure of the complete action itself
        // (which already succeeded).
        onStepCompleting?.();
        fetch(`/api/plans/${planId}/steps/${step.id}/complete-ack`, { method: 'POST', credentials: 'include' })
          .then(async (ackRes) => {
            if (!ackRes.ok) {
              onStepCompletionAckFailed?.();
              return;
            }
            const ackBody: unknown = await ackRes.json();
            const ackParsed = completeStepAckResponseSchema.safeParse(ackBody);
            if (ackParsed.success && ackParsed.data.chatMessage) {
              onStepCompletionAck?.(ackParsed.data.chatMessage);
            } else {
              onStepCompletionAckFailed?.();
            }
          })
          .catch(() => onStepCompletionAckFailed?.());
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
