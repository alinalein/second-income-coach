import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { checkInResponseSchema, type CheckInEnergy } from '@app/shared';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export interface CheckInControlProps {
  planId: string;
  /** Bug fix (user-reported): "how's your energy today" must appear at
   * most once a day — even after a week away, it should ask only about
   * *today*, not once per missed day. Server-truth flag from
   * `get_current_step` (`checkedInToday`), so a page reload the same day
   * still starts in the answered state. */
  checkedInToday: boolean;
  /** Story 4.1 (AC, follow-up), item 2: fires the instant the check-in
   * write succeeds — before the "thanks" animation plays. `EnergyCheckInPopup`
   * uses this to refresh the projection card right away, not after the
   * multi-second confirmation sequence below. */
  onRecorded?: () => void;
  /** Story 4.1 (AC, follow-up): fires once this component reaches its
   * final `'done'` state — either immediately (`checkedInToday` was already
   * true) or after the confirmation sequence finishes. `EnergyCheckInPopup`
   * uses this to close itself ("after choosing, show the short thanks and
   * close"). */
  onDone?: () => void;
}

const ENERGY_LEVELS: readonly CheckInEnergy[] = ['low', 'medium', 'high'];

// Same 200ms crossfade duration as ChatThread.tsx's own progress-label fade
// (PROGRESS_LABEL_FADE_MS) — the prompt fades out before it's replaced by
// the confirmation, instead of both being visible at once.
const FADE_MS = 200;

// Bug fix (user-reported): "Thanks for checking in! should disappear after
// like 3 seconds, not constantly be shown."
const CONFIRMATION_VISIBLE_MS = 3000;

type Status = 'idle' | 'sending' | 'sent' | 'done' | 'failed';

/**
 * Story 4.1 (CAP-4): the energy/status check-in control — its own component
 * rendered by `EnergyCheckInPopup`, never editing `PlanWorkspace`'s layout. A quick
 * tap records the energy level via `POST /api/plans/:planId/check-in`
 * (`record_check_in`, AD-4: a plain deterministic write, never an LLM call).
 */
export function CheckInControl({ planId, checkedInToday, onRecorded, onDone }: CheckInControlProps) {
  const { t } = useTranslation('plan');
  // `checkedInToday` already true at mount (e.g. a reload later the same
  // day) goes straight to `done` — the transient "Thanks" confirmation is
  // only for the moment the user just answered, never replayed on reload.
  const [status, setStatus] = React.useState<Status>(checkedInToday ? 'done' : 'idle');
  // Bug fix (user-reported): "it should just say thanks for checking in and
  // the request should disappear" — the prompt+buttons fade out (this flag)
  // before `status` flips to `sent` and actually removes them, instead of
  // both the buttons and the confirmation showing at the same time.
  const [promptVisible, setPromptVisible] = React.useState(!checkedInToday);
  const [confirmationVisible, setConfirmationVisible] = React.useState(false);
  const timeoutIdsRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  // Kept in refs (same precedent as `PlanWorkspace.tsx`'s own
  // `onPlanLoadedRef`) so a new callback identity on every parent render
  // never changes when these actually fire — only the real state
  // transitions below do.
  const onRecordedRef = React.useRef(onRecorded);
  React.useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);
  const onDoneRef = React.useRef(onDone);
  React.useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  React.useEffect(() => {
    if (checkedInToday) {
      setStatus('done');
      setPromptVisible(false);
      onDoneRef.current?.();
    }
  }, [checkedInToday]);

  React.useEffect(() => {
    const timeoutIds = timeoutIdsRef.current;
    return () => {
      timeoutIds.forEach(clearTimeout);
    };
  }, []);

  function after(ms: number, callback: () => void): void {
    timeoutIdsRef.current.push(setTimeout(callback, ms));
  }

  function sendCheckIn(energy: CheckInEnergy) {
    setStatus('sending');
    fetch(`/api/plans/${planId}/check-in`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ energy }),
    })
      .then(async (res) => {
        if (!res.ok) {
          setStatus('failed');
          return;
        }
        const body: unknown = await res.json();
        if (!checkInResponseSchema.safeParse(body).success) {
          setStatus('failed');
          return;
        }
        onRecordedRef.current?.();
        setPromptVisible(false);
        after(FADE_MS, () => {
          setStatus('sent');
          setConfirmationVisible(true);
          after(CONFIRMATION_VISIBLE_MS, () => {
            setConfirmationVisible(false);
            after(FADE_MS, () => {
              setStatus('done');
              onDoneRef.current?.();
            });
          });
        });
      })
      .catch(() => setStatus('failed'));
  }

  if (status === 'done') {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border pt-2 text-sm">
      {status !== 'sent' ? (
        <div
          className={cn('flex flex-col gap-2 transition-opacity ease-in-out', promptVisible ? 'opacity-100 duration-0' : 'opacity-0 duration-200')}
        >
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('checkIn.prompt')}</p>
          <div className="flex flex-wrap gap-2">
            {ENERGY_LEVELS.map((level) => (
              <Button
                key={level}
                type="button"
                variant="outline"
                size="sm"
                disabled={status === 'sending'}
                onClick={() => sendCheckIn(level)}
              >
                {t(`checkIn.energy${level.charAt(0).toUpperCase()}${level.slice(1)}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <p role="status" className={cn('text-muted-foreground transition-opacity duration-200 ease-in-out', confirmationVisible ? 'opacity-100' : 'opacity-0')}>
          {t('checkIn.sent')}
        </p>
      )}
      {status === 'failed' ? (
        <p role="alert" className="text-muted-foreground">
          {t('checkIn.failed')}
        </p>
      ) : null}
    </div>
  );
}
