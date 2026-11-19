import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { planResponseSchema, type PlanResponse, type ChatMessage } from '@app/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'shadcn-glass-ui';
import { ChatThread } from '../../chat/ChatThread';
import { MessageCost } from '../../chat/MessageCost';
import { createMessageFeedbackItem } from '../../chat/MessageFeedback';
import { VoiceInput } from '../../chat/VoiceInput';
import { StatusPanel } from './StatusPanel';
import { PlanActivationPanel } from './PlanActivationPanel';
import { ProjectionCard } from './ProjectionCard';
import { EnergyCheckInPopup } from './EnergyCheckInPopup';
import { ConfettiBurst } from '../../components/ui/confetti-burst';

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

/** Bug fix (user-reported, live): the "Setting up your plan…" dialog's own
 * glass backdrop-blur only reads as "glass" when there's something with
 * real edges/contrast behind it to soften — by the time this dialog mounts,
 * the previous screen is already gone (nothing but the flat page background
 * behind it). A shape-only skeleton of the real layout below (status/
 * projection column + chat column) gives the blur real boxes to soften.
 *
 * Bug fix (user-reported, live, round 2): the first attempt filled the
 * *entire* shape (including the chat column, which legitimately fills the
 * remaining flex height — same as the real content once loaded) solid with
 * `var(--blob)` — at that size it read as one large saturated rectangle,
 * not a subtle blur ingredient, and its `animate-pulse` was distracting
 * ("too much animation in the background"). Two small, individually
 * blurred circles (`filter: blur(60px)` on themselves, `overflow-hidden`
 * on the wrapper so they can never grow past it) is `index.css`'s own
 * page-level blob decoration's exact recipe — soft/diffuse by construction,
 * regardless of how big the wrapper is. The layout boxes themselves are
 * outlined (`border border-border`), not filled — a crisp edge is what the
 * dialog's own `backdrop-filter: blur()` visibly softens (the actual
 * "glass" cue); a flat color fill gives it nothing sharp to soften. No
 * animation — purely decorative, static is enough. */
function WorkspaceSkeleton() {
  return (
    <div aria-hidden="true" className="relative min-h-0 flex-1 overflow-hidden rounded-lg">
      <div
        className="absolute rounded-full"
        style={{ width: 220, height: 220, top: -40, left: 60, background: 'var(--blob)', opacity: 'var(--blob-opacity)', filter: 'blur(60px)' }}
      />
      <div
        className="absolute rounded-full"
        style={{ width: 220, height: 220, bottom: -40, right: 80, background: 'var(--blob)', opacity: 'var(--blob-opacity)', filter: 'blur(60px)' }}
      />
      <div className="relative flex h-full flex-col gap-4 p-4 sm:flex-row sm:items-stretch">
        <div className="flex flex-col gap-4 sm:w-64 sm:shrink-0 sm:self-start">
          <div className="h-40 rounded-lg border border-border" />
          <div className="h-24 rounded-lg border border-border" />
        </div>
        <div className="min-h-0 flex-1 rounded-lg border border-border" />
      </div>
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

/** Bug fix (user-reported, live): "switching between plans flashes the
 * 'creating your plan' progress bar for a split second — this shouldn't
 * happen, I want a smooth transition, not that modal popping in between."
 * `POST /select/:ideaId` is lazy-create-or-fetch (AD-13) — for a plan that
 * already exists (the common case when switching, as opposed to selecting
 * a brand-new idea) it resolves near-instantly, with no real LLM call
 * behind it at all. The loading modal below only shows once the request
 * has been pending for longer than this — long enough that a fast,
 * already-exists fetch never shows it at all, short enough that a genuine
 * first-time creation (which takes seconds, per `TYPICAL_PLAN_DURATION_MS`)
 * still shows it almost immediately. */
const LOADING_MODAL_DELAY_MS = 200;

export interface PlanWorkspaceProps {
  ideaId: string;
  /** UI fix (user-reported): shown in `StatusPanel`'s title ("Your plan for
   * <idea>") so the workspace is identifiable as belonging to this specific
   * idea, not a bare "Your plan". Passed down from the idea card that
   * navigated here — never re-fetched, since the idea's own title doesn't
   * change. */
  ideaTitle: string;
  /**
   * Bug fix (user-reported, live): "My plans" in the sidebar didn't show a
   * just-selected idea's brand-new plan. `App.tsx` bumps its own
   * `plansRefreshKey` the moment navigation *into* this workspace starts
   * (before the plan actually exists yet, since creation is this
   * component's own lazy `POST /select/:ideaId` below) — so the sidebar's
   * `GET /api/plans` fetch that triggers raced ahead of the real creation
   * and never ran again afterward. This fires once the fetch above actually
   * resolves (new or pre-existing plan alike — idempotent either way),
   * letting the caller re-trigger that same refresh at the moment the data
   * is actually ready.
   */
  onPlanLoaded?: (plan: PlanResponse) => void;
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
export function PlanWorkspace({ ideaId, ideaTitle, onPlanLoaded }: PlanWorkspaceProps) {
  const { t } = useTranslation('plan');
  const [plan, setPlan] = React.useState<PlanResponse | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  // Bug fix (user-reported, live): see `LOADING_MODAL_DELAY_MS`'s own doc
  // comment — `!plan` alone used to gate the modal, showing it the instant
  // any `ideaId` change started a fetch, even one that resolves in a few
  // milliseconds. This is the actual gate now; `!plan` still decides
  // whether the *real* workspace renders at all.
  const [showLoadingModal, setShowLoadingModal] = React.useState(false);
  // Spec 2.12 AC2: drives the determinate bar below while `create_plan` is
  // in flight.
  const [progress, setProgress] = React.useState(0);
  // Spec 2.12 AC8: the start_step chat acknowledgment, threaded down from
  // `StatusPanel`/`StepActions` and shown live by `ChatThread` via its own
  // `incomingMessage` prop (id-guarded there against a later history re-GET
  // that also picks up this same server-persisted message).
  const [incomingMessage, setIncomingMessage] = React.useState<ChatMessage | undefined>(undefined);
  // Kept in a ref (not the main effect's own dependency array below) so a
  // new `onPlanLoaded` function identity on every parent render never
  // re-triggers the lazy `POST /select/:ideaId` fetch — only a genuine
  // `ideaId` change does that.
  const onPlanLoadedRef = React.useRef(onPlanLoaded);
  React.useEffect(() => {
    onPlanLoadedRef.current = onPlanLoaded;
  }, [onPlanLoaded]);
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
  // Bug fix (user-reported, live): see `LOADING_MODAL_DELAY_MS`'s own doc
  // comment — a dedicated ref, cleared from every exit path below (success,
  // failure, StrictMode's synthetic re-run, and unmount), the same
  // precedent as `progressIntervalRef` right above.
  const loadingModalTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    setPlan(null);
    setLoadFailed(false);
    setProgress(0);
    setShowLoadingModal(false);

    const startedAt = Date.now();
    progressIntervalRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setProgress(Math.min(PROGRESS_HOLD_PERCENT, (elapsedMs / TYPICAL_PLAN_DURATION_MS) * PROGRESS_HOLD_PERCENT));
    }, PROGRESS_TICK_MS);
    loadingModalTimerRef.current = window.setTimeout(() => setShowLoadingModal(true), LOADING_MODAL_DELAY_MS);

    function clearProgressInterval() {
      if (progressIntervalRef.current !== null) {
        window.clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    }

    function clearLoadingModalTimer() {
      if (loadingModalTimerRef.current !== null) {
        window.clearTimeout(loadingModalTimerRef.current);
        loadingModalTimerRef.current = null;
      }
    }

    if (inFlightRef.current?.ideaId === ideaId) {
      inFlightRef.current.cancelled = false;
      return () => {
        if (inFlightRef.current?.ideaId === ideaId) inFlightRef.current.cancelled = true;
        clearProgressInterval();
        clearLoadingModalTimer();
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
        clearLoadingModalTimer();
        if (!res.ok) {
          setLoadFailed(true);
          return;
        }
        const body: unknown = await res.json();
        const result = planResponseSchema.safeParse(body);
        if (inFlight.cancelled) return;
        if (result.success) {
          setPlan(result.data);
          onPlanLoadedRef.current?.(result.data);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!inFlight.cancelled) {
          setProgress(100);
          clearProgressInterval();
          clearLoadingModalTimer();
          setLoadFailed(true);
        }
      });

    return () => {
      inFlight.cancelled = true;
      clearProgressInterval();
      clearLoadingModalTimer();
    };
  }, [ideaId]);

  const footerItems = React.useMemo(
    () => (plan ? [MessageCost, createMessageFeedbackItem(`/api/plans/${plan.id}/messages`)] : []),
    [plan],
  );

  // Story 4.4 (AC, follow-up), item 2: a small shared refresh signal — bumped
  // after Start/Complete (via `StatusPanel`'s `onPlanActivityChanged`) or a
  // check-in answer (via `EnergyCheckInPopup`'s `onCheckInRecorded`), and
  // consumed by `ProjectionCard`'s own `key` below to force a fresh fetch.
  // No workspace restructuring — one new state value, two existing callback
  // props, one `key` attribute.
  const [projectionRefreshKey, setProjectionRefreshKey] = React.useState(0);
  const refreshProjection = React.useCallback(() => setProjectionRefreshKey((key) => key + 1), []);

  // Bug fix (user-reported, live): a *separate* key from the one above —
  // `onPlanActivityChanged` already bumps `projectionRefreshKey` after
  // every single successful Start/Complete, and `StatusPanel` already
  // refetches itself for that case via its own `loadCurrentStep()`; tying
  // its `key` to that same signal would force a wasteful full remount on
  // every click too. This one bumps only on plan activation (`onActivated`
  // below) — the one moment a draft's steps can have silently changed
  // (Edit plan / Not quite — regenerate, both delete+reinsert `plan_steps`
  // under new row ids) without `StatusPanel` ever having refetched since
  // its initial mount.
  const [statusRefreshKey, setStatusRefreshKey] = React.useState(0);
  // Bug fix (user-reported, live): "the text from the AI alone isn't
  // enough" — a one-shot `ConfettiBurst` overlay alongside the completion
  // chat message, not instead of it.
  const [showConfetti, setShowConfetti] = React.useState(false);

  // Bug fix (user-reported, live): completing the plan's final step left
  // this component's own cached `plan.status` at `active` until a full
  // reload — the projection card kept its ongoing-projection framing (AC2),
  // the energy pop-up stayed mounted (AC1), and the sidebar kept showing
  // "Active" (AC5) because nothing ever told `App.tsx` to re-fetch
  // `/api/plans`. Flipping `plan.status` here locally fixes the first two
  // immediately; re-using `onPlanLoaded` (the same hook `App.tsx` already
  // bumps `plansRefreshKey` from on the initial load) fixes the sidebar
  // without adding a second refresh mechanism. `message` (the completion
  // chat acknowledgment) is shown the same live way `onStepStarted` already
  // shows a start acknowledgment — it previously only ever reached the
  // thread via a later page reload's own history read.
  const handlePlanCompleted = React.useCallback((message?: ChatMessage) => {
    setPlan((prev) => {
      if (!prev || prev.status === 'completed') return prev;
      const updated: PlanResponse = { ...prev, status: 'completed' };
      onPlanLoadedRef.current?.(updated);
      return updated;
    });
    if (message) setIncomingMessage(message);
    setShowConfetti(true);
  }, []);

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
        // Bug fix (user-reported, live, round 2): the skeleton now waits on
        // `showLoadingModal` too, same as the modal below (both or
        // neither — never the skeleton alone) — the previous round's own
        // reasoning ("a brief skeleton frame either way reads as normal
        // loading") was wrong in practice: its vivid `var(--blob)` fill
        // (needed for the modal's own backdrop-blur to have something to
        // soften) read as a jarring flash/jump on a fast switch between
        // two already-loaded plans, exactly the case this delay exists to
        // avoid in the first place.
        showLoadingModal ? (
          <>
            <WorkspaceSkeleton />
            {/* Spec 2.12 AC2: the same determinate-bar/stage-text pattern as
             * idea generation (`IdeasPanel.tsx`) replaces the old
             * indeterminate spinner — visible from first paint, jumps to
             * 100% the instant the request settles, right before the plan
             * itself replaces this view. User-reported follow-up: now a
             * centered, backdropped modal (same `shadcn-glass-ui` Dialog
             * pattern as `PlanActivationPanel`'s review) instead of inline
             * page content, so the rest of the page is blocked while the
             * plan is being created — same as that dialog. No close
             * affordance: there is nothing safe to cancel back to
             * mid-creation. */}
            <Dialog open onOpenChange={() => undefined}>
              {/* `popup-glass-strong` (`index.css`, user-reported, live,
               * round 3 — see its own doc comment there for why this is a
               * plain hand-written class, not a Tailwind arbitrary-value
               * one). `WorkspaceSkeleton` above (rendered behind this
               * Dialog, same DOM position either way) is what gives its
               * backdrop-blur real boxes to soften. `border
               * shadow-[var(--shadow)]` (user-reported, live, explicit
               * follow-up): a visible outline around the panel itself —
               * this app's own `Card` component's exact recipe
               * (`card.tsx`). */}
              <DialogContent
                showCloseButton={false}
                className="popup-glass-strong flex flex-col items-center gap-3 border text-center shadow-[var(--shadow)]"
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
          </>
        ) : null
      ) : (
        <div className="flex flex-col gap-4 sm:h-full sm:min-h-0">
          {/* Story 3.2 (AD-14): the draft review/confirm/modify/reject panel
           * — only a `draft` plan needs human confirmation before it can
           * become `active`; once confirmed/already active, it's gone. */}
          {plan.status === 'draft' ? (
            <PlanActivationPanel
              planId={plan.id}
              ideaTitle={ideaTitle}
              onActivated={(activatedPlan) => {
                setPlan(activatedPlan);
                // Bug fix (user-reported, live): "I asked the AI to change
                // the plan [during review, via Edit plan / Not quite —
                // regenerate], then approved — the steps the user sees
                // must be automatically updated, not still show the old
                // plan." `StatusPanel` fetches `current-step` once on mount
                // and never again on its own; editing or regenerating the
                // draft deletes and reinserts `plan_steps` with brand-new
                // row ids, but `StatusPanel` kept showing the *original*
                // draft's steps (fetched before the user ever opened the
                // review) straight through confirmation. Clicking Start/
                // Mark-as-done then sent that stale, no-longer-current
                // step id, which the server correctly 409'd. Bumping
                // `statusRefreshKey` forces `StatusPanel` to remount and
                // refetch the real, final steps.
                setStatusRefreshKey((key) => key + 1);
                refreshProjection();
              }}
            />
          ) : null}
          {/* Story 4.1 (AC, follow-up): the energy pop-up — mounted here
           * (not a permanent status-column control) so it only ever exists
           * on the plan-workspace route, never during intake or ideas; a
           * Radix dialog portals itself regardless of where it sits in this
           * tree, so its position here doesn't affect layout.
           * Story 4.5 (AC1): never shown for a completed plan — there is
           * nothing left to check in about.
           * Bug fix (user-reported, live): never for a `draft` plan either
           * — `PlanActivationPanel`'s own review `Dialog` is still open at
           * that point (a draft always needs review before it's active),
           * so this popup's own `Dialog` could end up mounting *underneath
           * an already-open one*. Two overlapping Radix dialogs is a
           * plausible source of the broken close-button position reported
           * live (its own scroll-lock/portal bookkeeping isn't designed
           * for a second dialog opening mid-flight) — and semantically, a
           * plan the user hasn't even confirmed yet has no "today" to ask
           * about anyway. */}
          {plan.status === 'active' ? <EnergyCheckInPopup planId={plan.id} onCheckInRecorded={refreshProjection} /> : null}
          {showConfetti ? <ConfettiBurst onDone={() => setShowConfetti(false)} /> : null}
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
              {/* Bug fix (user-reported, live): `ProjectionCard` now sits
               * above `StatusPanel` (was the reverse) — with
               * `StatusPanel`'s own current-step card now last in this
               * column again (no fixed height, see that file's own doc
               * comment), its height changing between steps only ever
               * grows/shrinks the empty space *below* it, never jostles
               * anything else in the column the way it did sitting above
               * `ProjectionCard`.
               *
               * Code Map: "projection card extension point (a slot in the
               * sidebar/header) ... renders nothing until 4.4". Story 4.4
               * fills it here — this file's own layout is otherwise
               * unchanged.
               *
               * Bug fix (user-reported, live): `refreshToken` (a plain
               * prop `ProjectionCard` itself refetches on, never clearing
               * its own last-loaded data first), not a `key` remount — a
               * remount dropped the card back to "Loading…" and then
               * snapped to the new numbers, a visible jump right after
               * "Mark as done" already updated the step above it
               * instantly. */}
              <ProjectionCard planId={plan.id} planStatus={plan.status} refreshToken={projectionRefreshKey} />
              {/* Bug fix (user-reported, live): `key` forces a fresh mount/
               * fetch on plan activation (`statusRefreshKey`, bumped only
               * from `onActivated` above, never on every ordinary step
               * action) — otherwise `current-step` is fetched once on
               * mount and never again on its own, so editing or
               * regenerating the draft during review (new `plan_steps`
               * rows, same `plan.id`) left this showing the *original*
               * draft's steps straight through confirmation.
               *
               * Bug fix (found while fixing the above): a bare number here
               * used to collide with `ProjectionCard`'s own bare-number
               * `key` (since removed — that card now refetches via a plain
               * `refreshToken` prop instead, never a remount) — both
               * started at 0 and both got bumped together by `onActivated`,
               * so the two (different-typed!) sibling elements ended up
               * sharing the literal key `1`. React's sibling key-matching
               * doesn't exempt same-key-different-type elements — it
               * genuinely duplicated `StatusPanel` on screen (confirmed
               * live: "two children with the same key" warning, both the
               * old and new instance visible at once). Still namespaced
               * (`status-${...}`) as a result, even with nothing left to
               * collide with. */}
              <StatusPanel
                key={`status-${statusRefreshKey}`}
                planId={plan.id}
                ideaTitle={ideaTitle}
                planStatus={plan.status}
                onStepStarted={setIncomingMessage}
                onPlanCompleted={handlePlanCompleted}
                onPlanActivityChanged={refreshProjection}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Story 5.2/5.3: `MessageCost` + `MessageFeedback` registered
               * into the footer extension point built in Story 3.1 — alongside
               * each other, no restructuring of `ChatThread`/`ChatMessage`.
               * Memoized on `plan.id` so each `MessageFeedback` instance keeps
               * its own component identity (and its in-session rating state)
               * across unrelated `PlanWorkspace` re-renders. */}
              {/* Story 4.3: `ChatThread`'s render-prop input-extension point,
               * filled with the voice-record control — fills the same draft
               * the text input edits (user-requested revision), no layout
               * change here. */}
              <ChatThread
                endpoint={`/api/plans/${plan.id}/messages`}
                footerItems={footerItems}
                incomingMessage={incomingMessage}
                inputExtra={(fillDraft, disabled) => <VoiceInput fillDraft={fillDraft} disabled={disabled} />}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
