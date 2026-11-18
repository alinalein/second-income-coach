import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { planResponseSchema, type PlanResponse, type ChatMessage } from '@app/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'shadcn-glass-ui';
import { ChatThread } from '../../chat/ChatThread';
import { MessageCost } from '../../chat/MessageCost';
import { createMessageFeedbackItem } from '../../chat/MessageFeedback';
import { StatusPanel } from './StatusPanel';
import { PlanActivationPanel } from './PlanActivationPanel';

/**
 * Spec 2.12 AC2: the same time-based determinate-bar shape as
 * `IdeasPanel.tsx`'s own `DeterminateProgressBar` — duplicated rather than
 * imported (this file owns its own layout/Boundary; plan creation's timing
 * is unrelated to idea generation's) so a `create_plan` wait gets the same
 * "one continuous, never-restarting bar" treatment instead of the old
 * indeterminate spinner.
 */
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
        className={`h-full rounded-full bg-primary ease-linear ${percent === 0 ? '' : 'transition-[width] duration-300'}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Spec 2.12 AC2: `create_plan` is one plain structured-output call (no
 * nested search loop) — a much shorter typical duration than idea
 * generation's own `TYPICAL_GENERATE_DURATION_MS`. The bar fills toward 90%
 * over this duration, holds there for a run that takes longer, and the
 * caller forces it to 100% the instant the request settles. */
const TYPICAL_PLAN_DURATION_MS = 10_000;
const PROGRESS_HOLD_PERCENT = 90;
const PROGRESS_TICK_MS = 300;

export interface PlanWorkspaceProps {
  ideaId: string;
  /** UI fix (user-reported): shown in `StatusPanel`'s title ("Your plan for
   * <idea>") so the workspace is identifiable as belonging to this specific
   * idea, not a bare "Your plan". Passed down from the idea card that
   * navigated here — never re-fetched, since the idea's own title doesn't
   * change. */
  ideaTitle: string;
}

/**
 * Code Map/AC: "a single unified screen (option A) — a status sidebar/
 * header ... and a projection card alongside one chat thread ... never
 * split into separate 'Overview'/'Chat' tabs." This is the one file any
 * story may edit for this layout (Boundary) — later stories (4.x, 5.2,
 * 5.3) fill the extension points below without restructuring it.
 *
 * Lazily creates-or-fetches the plan via `POST /api/plans/select/:ideaId`
 * (AD-13: lazy, never eager) on mount, then renders the shell once it
 * resolves. 2.9 AC: on a desktop width this keeps layout-preview.html's own
 * layout — the status column beside the chat, side by side (`sm:flex-row`);
 * only a narrow screen stacks `StatusPanel` above the chat as a compact
 * header. 2.9 AC (global nav): there is no "Back to ideas" control here —
 * every navigation action lives in the app-wide sidebar now.
 */
export function PlanWorkspace({ ideaId, ideaTitle }: PlanWorkspaceProps) {
  const { t } = useTranslation('plan');
  const [plan, setPlan] = React.useState<PlanResponse | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  // Spec 2.12 AC2: drives the determinate bar below while `create_plan` is
  // in flight.
  const [progress, setProgress] = React.useState(0);
  // Spec 2.12 AC8: the start_step chat acknowledgment, threaded down from
  // `StatusPanel`/`StepActions` and shown live by `ChatThread` via its own
  // `incomingMessage` prop (id-guarded there against a later history re-GET
  // that also picks up this same server-persisted message).
  const [incomingMessage, setIncomingMessage] = React.useState<ChatMessage | undefined>(undefined);
  // Live-bug fix (user-reported): dev-only React StrictMode synchronously
  // runs this effect's cleanup and setup twice on mount, to surface exactly
  // this class of bug. The lazy `create_plan` call behind this fetch is not
  // idempotent on its own cost (two concurrent `POST /select/:ideaId`s each
  // trigger their own model call, even though the server-side unique
  // constraint means only one `plans` row ever persists) — tracking the
  // in-flight request by `ideaId` here, rather than a plain per-invocation
  // `let cancelled` flag, means the second (StrictMode-synthetic) effect run
  // recognizes a request already in flight for this same `ideaId` and
  // resumes it instead of starting a second real network request. Because
  // this re-run happens synchronously, before the fetch's own `.then` can
  // run as a microtask, flipping `cancelled` back here is enough to let the
  // original request's result through once it resolves. A genuine `ideaId`
  // change or unmount still starts/cancels exactly as before.
  const inFlightRef = React.useRef<{ ideaId: string; cancelled: boolean } | null>(null);
  // Spec 2.12 AC2: a ref (not a plain local variable) so `settle()` below
  // always clears whichever interval is *currently* running, regardless of
  // which effect invocation's own closure happens to call it — required for
  // the same StrictMode synthetic double-invoke this file's `inFlightRef`
  // pattern already accounts for (see that ref's own comment): the real
  // fetch's `.then` closure belongs to the *first* invocation, but by the
  // time it resolves the *second* invocation's interval is the one actually
  // still ticking.
  const progressIntervalRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    setPlan(null);
    setLoadFailed(false);
    setProgress(0);

    const startedAt = Date.now();
    progressIntervalRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setProgress(Math.min(PROGRESS_HOLD_PERCENT, (elapsedMs / TYPICAL_PLAN_DURATION_MS) * PROGRESS_HOLD_PERCENT));
    }, PROGRESS_TICK_MS);

    function clearProgressInterval() {
      if (progressIntervalRef.current !== null) {
        window.clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    }

    if (inFlightRef.current?.ideaId === ideaId) {
      inFlightRef.current.cancelled = false;
      return () => {
        if (inFlightRef.current?.ideaId === ideaId) inFlightRef.current.cancelled = true;
        clearProgressInterval();
      };
    }

    const inFlight = { ideaId, cancelled: false };
    inFlightRef.current = inFlight;

    fetch(`/api/plans/select/${ideaId}`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (inFlight.cancelled) return;
        // Story 2.6's own "let the bar actually reach 100%" precedent
        // (`IdeasPanel.tsx`) — forced to 100% the instant the request
        // settles, success or failure, then the interval stops so a later
        // tick can never regress it back down.
        setProgress(100);
        clearProgressInterval();
        if (!res.ok) {
          setLoadFailed(true);
          return;
        }
        const body: unknown = await res.json();
        const result = planResponseSchema.safeParse(body);
        if (inFlight.cancelled) return;
        if (result.success) setPlan(result.data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!inFlight.cancelled) {
          setProgress(100);
          clearProgressInterval();
          setLoadFailed(true);
        }
      });

    return () => {
      inFlight.cancelled = true;
      clearProgressInterval();
    };
  }, [ideaId]);

  const footerItems = React.useMemo(
    () => (plan ? [MessageCost, createMessageFeedbackItem(`/api/plans/${plan.id}/messages`)] : []),
    [plan],
  );

  return (
    // Bug fix (user-reported): "the chat should have the full height of the
    // window" — `sm:h-full sm:min-h-0` give the desktop layout a definite
    // height to pass down to the chat column (from `App.tsx`'s own
    // already-viewport-height `<main>`); the narrow-screen stack keeps its
    // natural, page-scrolling height (2.9's own compact-header behavior),
    // unaffected since these are `sm:`-only.
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 sm:h-full sm:min-h-0">
      {loadFailed ? (
        <p className="text-sm text-muted-foreground" role="alert">
          {t('loadFailed')}
        </p>
      ) : !plan ? (
        // Spec 2.12 AC2: the same determinate-bar/stage-text pattern as idea
        // generation (`IdeasPanel.tsx`) replaces the old indeterminate
        // spinner — visible from first paint, jumps to 100% the instant the
        // request settles, right before the plan itself replaces this view.
        // User-reported follow-up: now a centered, backdropped modal (same
        // `shadcn-glass-ui` Dialog pattern as `PlanActivationPanel`'s review)
        // instead of inline page content, so the rest of the page is blocked
        // while the plan is being created — same as that dialog. No close
        // affordance: there is nothing safe to cancel back to mid-creation.
        <Dialog open onOpenChange={() => undefined}>
          {/* User-reported follow-up: same `--modal-bg` override as
           * `PlanActivationPanel`'s review dialog — a solid card instead of
           * the library's glass/translucent default. */}
          <DialogContent
            showCloseButton={false}
            className="flex flex-col items-center gap-3 text-center [--modal-bg:var(--card)]"
          >
            <DialogHeader className="items-center text-center">
              <DialogTitle>{t('loading')}</DialogTitle>
            </DialogHeader>
            <div className="flex w-full flex-col gap-2" aria-live="polite" role="status">
              <DeterminateProgressBar percent={progress} label={t('loading')} />
              <p className="text-xs text-muted-foreground">{t('loadingHint')}</p>
            </div>
          </DialogContent>
        </Dialog>
      ) : (
        <div className="flex flex-col gap-4 sm:h-full sm:min-h-0">
          {/* Story 3.2 (AD-14): the draft review/confirm/modify/reject panel
           * — only a `draft` plan needs human confirmation before it can
           * become `active`; once confirmed/already active, it's gone. */}
          {plan.status === 'draft' ? (
            <PlanActivationPanel planId={plan.id} onActivated={(activatedPlan) => setPlan(activatedPlan)} />
          ) : null}
          {/* 2.9 AC: layout-preview.html's own layout — status column beside
           * the chat, side by side, on a desktop width; only a narrow
           * screen stacks the status panel above the chat as a compact
           * header (Story 3.1's own narrow-screen layout). `sm:items-stretch`
           * (the default — no longer overridden to `items-start`) lets the
           * chat column take this row's own full height; the status column
           * keeps its natural, content-sized height either way. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row sm:items-stretch">
            {/* Spec 2.12 AC6: `sm:self-start` opts this column out of the
             * row's own `items-stretch` — it keeps its natural, content-sized
             * height, while the chat column (no override) stretches to the
             * row's full height. */}
            <div className="flex flex-col gap-4 sm:w-64 sm:shrink-0 sm:self-start">
              <StatusPanel planId={plan.id} ideaTitle={ideaTitle} onStepStarted={setIncomingMessage} />
              {/* Code Map: "projection card extension point (a slot in the
               * sidebar/header) ... renders nothing until 4.4". */}
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Story 5.2/5.3: `MessageCost` + `MessageFeedback` registered
               * into the footer extension point built in Story 3.1 — alongside
               * each other, no restructuring of `ChatThread`/`ChatMessage`.
               * Memoized on `plan.id` so each `MessageFeedback` instance keeps
               * its own component identity (and its in-session rating state)
               * across unrelated `PlanWorkspace` re-renders. */}
              <ChatThread endpoint={`/api/plans/${plan.id}/messages`} footerItems={footerItems} incomingMessage={incomingMessage} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
