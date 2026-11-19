import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'shadcn-glass-ui';
import { checkInStatusResponseSchema } from '@app/shared';
import { CheckInControl } from './CheckInControl';

export interface EnergyCheckInPopupProps {
  /** The plan open at the moment the pop-up is shown — the check-in answer
   * is stored against this plan (AC: "the answer is stored against the
   * plan open at that moment"), via `CheckInControl`'s own existing
   * `POST /api/plans/:planId/check-in` call. */
  planId: string;
  /** Story 4.1 (AC, follow-up), item 2: fires the instant a check-in is
   * actually recorded (never on a mere dismiss) — the caller uses this to
   * refresh the projection card. */
  onCheckInRecorded?: () => void;
}

const DISMISSED_TODAY_STORAGE_KEY = 'energy-checkin-dismissed-date';

function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Per-viewer convenience only (AC: "a localStorage flag for dismiss-today"
 * — never the source of truth; a failed read is never treated as "already
 * dismissed," so a private-mode/blocked-storage viewer just gets asked
 * again, the safe direction to fail in). */
export function wasDismissedToday(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_TODAY_STORAGE_KEY) === todayUtcDateString();
  } catch {
    return false;
  }
}

export function markDismissedToday(): void {
  try {
    window.localStorage.setItem(DISMISSED_TODAY_STORAGE_KEY, todayUtcDateString());
  } catch {
    // Private mode / blocked storage — this viewer just gets asked again;
    // never silently suppressed forever.
  }
}

/**
 * Story 4.1 (AC, follow-up): the energy/status question as a small,
 * dismissible pop-up over the window — asked at most once per calendar day
 * per user across ALL plans, never a permanent control in the plan's
 * status column (`StatusPanel.tsx` no longer renders `CheckInControl` at
 * all). Mounted once by `PlanWorkspace.tsx`, so it only ever exists on the
 * plan-workspace route — never during intake or ideas.
 *
 * "Already answered today" is server-truth (`GET /api/plans/check-in-status`,
 * computed across every plan, never just this one); a same-day dismissal is
 * a `localStorage` convenience on top of that. `Dialog`/`DialogContent` (the
 * same `shadcn-glass-ui` pattern Story 2.8's confirm dialog already uses)
 * provides the close X and click-away/Escape dismissal for free — both map
 * to `onOpenChange(false)` below.
 */
export function EnergyCheckInPopup({ planId, onCheckInRecorded }: EnergyCheckInPopupProps) {
  const { t } = useTranslation('plan');
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (wasDismissedToday()) return;
    let cancelled = false;

    fetch('/api/plans/check-in-status', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = checkInStatusResponseSchema.safeParse(body);
        if (result.success && !result.data.answeredToday) setOpen(true);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  function handleOpenChange(next: boolean): void {
    // AC: "dismissing it counts as answered for that day: no energy
    // stored, no re-ask the same day" — only the X/click-away/Escape path
    // reaches this with `next === false` before an answer was ever sent;
    // `CheckInControl`'s own `onDone` (below) closes this the same way
    // after a real answer, where marking "dismissed" is harmless (the
    // server already knows the day is answered either way).
    if (!next) markDismissedToday();
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Bug fix (user-reported, live): "the X is far from the check-in
       * card" — the library's default size (`'sm'`, 28rem/448px) is wider
       * than this popup's own short content (a title + 3 small buttons),
       * so the close X (positioned relative to the *box*, not the
       * content) sat at the box's true right edge, with a lot of visibly
       * empty page background between it and the actual text/buttons.
       * `w-fit` shrinks the box down to its content's real width instead,
       * same `popup-glass-strong` look as the other short popups. */}
      <DialogContent className="popup-glass-strong w-fit">
        <DialogHeader>
          <DialogTitle>{t('checkIn.title')}</DialogTitle>
        </DialogHeader>
        <CheckInControl planId={planId} checkedInToday={false} onRecorded={onCheckInRecorded} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
