import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { planResponseSchema, type PlanResponse } from '@app/shared';
import { ChatThread } from '../../chat/ChatThread';
import { MessageCost } from '../../chat/MessageCost';
import { createMessageFeedbackItem } from '../../chat/MessageFeedback';
import { StatusPanel } from './StatusPanel';
import { PlanActivationPanel } from './PlanActivationPanel';

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

  React.useEffect(() => {
    setPlan(null);
    setLoadFailed(false);

    if (inFlightRef.current?.ideaId === ideaId) {
      inFlightRef.current.cancelled = false;
      return () => {
        if (inFlightRef.current?.ideaId === ideaId) inFlightRef.current.cancelled = true;
      };
    }

    const inFlight = { ideaId, cancelled: false };
    inFlightRef.current = inFlight;

    fetch(`/api/plans/select/${ideaId}`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (inFlight.cancelled) return;
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
        if (!inFlight.cancelled) setLoadFailed(true);
      });

    return () => {
      inFlight.cancelled = true;
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
        // Matches IdeasPanel's own "Generating…" loading pattern (status
        // line + "this can take a few seconds" hint) rather than a bare
        // one-liner, for the same wait (a lazy `create_plan` LLM call).
        <div className="flex flex-col gap-2" aria-live="polite" role="status">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
          <p className="text-xs text-muted-foreground">{t('loadingHint')}</p>
        </div>
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
          <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
            <div className="flex flex-col gap-4 sm:w-64 sm:shrink-0">
              <StatusPanel planId={plan.id} ideaTitle={ideaTitle} />
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
              <ChatThread endpoint={`/api/plans/${plan.id}/messages`} footerItems={footerItems} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
