import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  planActivationReviewSchema,
  createPlanDraftSchema,
  MIN_PLAN_STEPS,
  MAX_PLAN_STEPS,
  type PlanActivationReview,
  type PlanResponse,
  type CreatePlanDraft,
} from '@app/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from 'shadcn-glass-ui';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { stripLeadingBulletMarker } from '../../lib/utils';

export interface PlanActivationPanelProps {
  planId: string;
  /** UI fix (user-reported): interpolated into `activation.reviewTitle` —
   * same already-known title `StatusPanel.tsx`'s own card uses, so "Review
   * your plan" names which plan without a second fetch. */
  ideaTitle: string;
  /** Lets `PlanWorkspace` swap its own `plan` state to the now-`active` row
   * once confirmed, which hides this panel on the next render (it only
   * renders for a `draft` plan). */
  onActivated: (plan: PlanResponse) => void;
}

type EditableStep = { title: string; descriptionText: string; dayOffset: number };

function toEditableSteps(steps: PlanActivationReview['steps']): EditableStep[] {
  return [...steps]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((step) => ({ title: step.title, descriptionText: step.description.join('\n'), dayOffset: step.dayOffset }));
}

/**
 * User-reported, live: "Not quite — regenerate" feedback asking for a step
 * count outside `create_plan`'s own 3-12 bound (`MIN_PLAN_STEPS`/
 * `MAX_PLAN_STEPS`, `shared/schemas/plans.ts`) used to reach the model
 * anyway — asked to satisfy both "exactly N steps" and "between 3 and 12
 * steps" at once, it padded a fake extra step with placeholder content
 * ("Step 3: x") rather than silently ignoring the out-of-range request.
 * Caught here, before the request ever reaches the model: a plain digit
 * count next to the word "step(s)"/"Schritt(e)" (English or German, this
 * feedback box's own two supported languages), rejected if it falls
 * outside the schema's own bound. Word-form numbers ("two steps") aren't
 * recognized — a known, narrow miss (the request still reaches the model,
 * same as today), never a false rejection of an in-range request.
 */
const REQUESTED_STEP_COUNT_PATTERN = /\b(\d{1,2})\s*(steps?|schritten?)\b/i;

function extractRequestedStepCount(feedback: string): number | null {
  const match = feedback.match(REQUESTED_STEP_COUNT_PATTERN);
  return match ? Number(match[1]) : null;
}

function toDraft(steps: EditableStep[]): CreatePlanDraft {
  return {
    steps: steps.map((step) => ({
      title: step.title,
      description: step.descriptionText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      dayOffset: step.dayOffset,
    })),
  };
}

type Phase = 'idle' | 'loading' | 'reviewing' | 'editing' | 'rejecting' | 'busy' | 'failed';

/** Matches `index.css`'s `.popup-glass-dense`/`.popup-glass-strong` 180ms
 * close transition, plus a small buffer. */
const DIALOG_EXIT_MS = 200;

/**
 * Story 3.2 (AD-14): the draft review/confirm/modify/reject panel. Own
 * component (Boundary: "own component, do not edit the layout file") —
 * `PlanWorkspace.tsx` only adds the one conditional render call for a
 * `draft` plan; this file owns all of the activation flow's own layout.
 */
export function PlanActivationPanel({ planId, ideaTitle, onActivated }: PlanActivationPanelProps) {
  const { t } = useTranslation('plan');
  // Bug fix (user-reported, live): starts at `'loading'`, not `'idle'` — the
  // mount effect below always flips it to `'loading'` anyway (synchronously
  // within the same effect, before any fetch), but that flip only happens
  // *after* the first paint. Starting at `'idle'` meant that first paint
  // briefly showed the small inline "reopen" card (the eventual idle state,
  // reached only via an explicit later close) instead of this file's own
  // loading `Dialog` — one more jarring mode-switch in the "setting up your
  // plan" -> "review your plan" hand-off (`PlanWorkspace.tsx`'s own loading
  // modal was already gone by this point, having nothing left to blend
  // into).
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [review, setReview] = React.useState<PlanActivationReview | null>(null);
  const [editableSteps, setEditableSteps] = React.useState<EditableStep[]>([]);
  const [editError, setEditError] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  // User-reported, live: `'stepCount'` is the new out-of-range guard above
  // (`extractRequestedStepCount`); `'required'` is the pre-existing empty-
  // feedback guard, unchanged.
  const [feedbackError, setFeedbackError] = React.useState<'required' | 'stepCount' | null>(null);
  // UX fix (user-reported, live): "Confirm & activate" used to call
  // `onActivated` the instant the request resolved, which flips the
  // parent's `plan.status` away from `'draft'` and unmounts this whole
  // component in that same render — an unmounted Dialog never gets
  // Radix's own close transition, so the review dialog just vanished.
  // `exiting` flips the Dialog's own `open` to `false` first (now a real
  // close, which `index.css`'s `[data-state='closed']` rule fades out),
  // and `onActivated` itself is delayed by `DIALOG_EXIT_MS` so the parent
  // only unmounts this component after that fade has actually played.
  const [exiting, setExiting] = React.useState(false);
  const exitTimeoutRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    return () => {
      if (exitTimeoutRef.current !== undefined) window.clearTimeout(exitTimeoutRef.current);
    };
  }, []);

  // Review fix: the mount-time GET (page-refresh resume) and a user-
  // triggered POST (`startReview`/`saveEdits`/`submitReject`) can resolve
  // out of order — nothing otherwise stops a slow GET that predates a POST
  // from resolving *after* it and clobbering the POST's freshly-loaded
  // review/phase with its own stale `null`. Every request captures the
  // current counter value; a response is applied only if it's still the
  // most recent request issued.
  const requestIdRef = React.useRef(0);
  function beginRequest(): number {
    requestIdRef.current += 1;
    return requestIdRef.current;
  }
  function isStale(requestId: number): boolean {
    return requestId !== requestIdRef.current;
  }

  // Bug fix (user-reported, live): "we can remove that [intermediate
  // 'Review & activate your plan' card] entirely" — this mount effect used
  // to fall back to an `'idle'` card with its own "Review plan" button
  // whenever a page-refresh mid-review found no review already pending
  // (the common case: a freshly-created draft nobody has reviewed yet).
  // It now starts the review immediately instead. AD-14's actual
  // human-in-the-loop requirement (the explicit Confirm & activate / Edit /
  // Regenerate choice inside the modal) is unaffected — only the extra
  // click to *open* that modal is gone. A page-refresh mid-review still
  // picks up the already-pending one, same as before.
  React.useEffect(() => {
    const requestId = beginRequest();
    setPhase('loading');

    fetch(`/api/plans/${planId}/activate`, { credentials: 'include' })
      .then(async (res) => {
        if (isStale(requestId)) return;
        if (!res.ok) {
          startReview();
          return;
        }
        const body: unknown = await res.json();
        if (isStale(requestId)) return;
        const parsed = (body as { review?: unknown } | undefined)?.review;
        if (!parsed) {
          startReview();
          return;
        }
        const result = planActivationReviewSchema.safeParse(parsed);
        if (result.success) {
          setReview(result.data);
          setPhase('reviewing');
        } else {
          startReview();
        }
      })
      .catch(() => {
        if (!isStale(requestId)) startReview();
      });

    // Unmount counts as "stale" too (same precedent as `PlanWorkspace`'s own
    // `cancelled` flag) — bumping the counter here means this effect's own
    // `requestId` can never match again, so a response arriving after
    // unmount is silently dropped instead of calling `setState` on an
    // unmounted component.
    return () => {
      beginRequest();
    };
    // `startReview` is a fresh closure every render (not memoized) — adding
    // it here would re-run this effect on every render instead of only
    // when `planId` changes, which is the one thing it's actually meant to
    // react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  function startReview() {
    const requestId = beginRequest();
    setPhase('loading');
    fetch(`/api/plans/${planId}/activate`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        const body: unknown = await res.json();
        if (isStale(requestId)) return;
        const result = planActivationReviewSchema.safeParse(body);
        if (result.success) {
          setReview(result.data);
          setPhase('reviewing');
        } else {
          setPhase('failed');
        }
      })
      .catch(() => {
        if (!isStale(requestId)) setPhase('failed');
      });
  }

  function confirm() {
    const requestId = beginRequest();
    setPhase('busy');
    fetch(`/api/plans/${planId}/activate/confirm`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        const body: unknown = await res.json();
        if (isStale(requestId)) return;
        setExiting(true);
        exitTimeoutRef.current = window.setTimeout(() => onActivated(body as PlanResponse), DIALOG_EXIT_MS);
      })
      .catch(() => {
        if (!isStale(requestId)) setPhase('failed');
      });
  }

  function startEditing() {
    if (review) setEditableSteps(toEditableSteps(review.steps));
    setEditError(false);
    setPhase('editing');
  }

  function saveEdits() {
    const draft = toDraft(editableSteps);
    const parsed = createPlanDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setEditError(true);
      return;
    }
    setEditError(false);
    const requestId = beginRequest();
    setPhase('busy');
    fetch(`/api/plans/${planId}/activate/modify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: parsed.data }),
    })
      .then(async (res) => {
        if (!res.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        // Bug fix (user-reported): modify resolves the pending interrupt —
        // the graph run completes, it does NOT pause again on its own. A
        // GET here (the original code) reads back `{ review: null }` (no
        // pending interrupt left), which failed Zod validation and always
        // landed on "Something went wrong." A fresh `POST /activate` is
        // what actually starts a new pause over the just-saved draft, the
        // same way the initial "Review plan" click does.
        const reviewRes = await fetch(`/api/plans/${planId}/activate`, { method: 'POST', credentials: 'include' });
        if (!reviewRes.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        const body: unknown = await reviewRes.json();
        if (isStale(requestId)) return;
        const parsedReview = planActivationReviewSchema.safeParse(body);
        if (parsedReview.success) {
          setReview(parsedReview.data);
          setPhase('reviewing');
        } else {
          setPhase('failed');
        }
      })
      .catch(() => {
        if (!isStale(requestId)) setPhase('failed');
      });
  }

  function startRejecting() {
    setFeedback('');
    setFeedbackError(null);
    setPhase('rejecting');
  }

  function submitReject() {
    if (feedback.trim().length === 0) {
      setFeedbackError('required');
      return;
    }
    const requestedStepCount = extractRequestedStepCount(feedback);
    if (requestedStepCount !== null && (requestedStepCount < MIN_PLAN_STEPS || requestedStepCount > MAX_PLAN_STEPS)) {
      setFeedbackError('stepCount');
      return;
    }
    setFeedbackError(null);
    const requestId = beginRequest();
    setPhase('busy');
    fetch(`/api/plans/${planId}/activate/reject`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: feedback.trim() }),
    })
      .then(async (res) => {
        if (!res.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        // Bug fix (user-reported): same as `saveEdits` — reject resolves the
        // pending interrupt and the graph run completes; a fresh
        // `POST /activate` (not a `GET`) is what starts a new pause over the
        // just-regenerated draft.
        const reviewRes = await fetch(`/api/plans/${planId}/activate`, { method: 'POST', credentials: 'include' });
        if (!reviewRes.ok) {
          if (!isStale(requestId)) setPhase('failed');
          return;
        }
        const body: unknown = await reviewRes.json();
        if (isStale(requestId)) return;
        const parsedReview = planActivationReviewSchema.safeParse(body);
        if (parsedReview.success) {
          setReview(parsedReview.data);
          setPhase('reviewing');
        } else {
          setPhase('failed');
        }
      })
      .catch(() => {
        if (!isStale(requestId)) setPhase('failed');
      });
  }

  // Bug fix (user-reported, live): no longer the *first* thing shown for a
  // fresh draft (the mount effect above starts the review immediately for
  // that case) — only reached if the user explicitly closes the review
  // modal (X/Escape/backdrop, `onOpenChange` below) and needs a way back
  // to it. Still the exact same card/copy; it's a reopen affordance now,
  // not a gate.
  if (phase === 'idle') {
    // User-reported, live: closing the review/edit/reject `Dialog` (X,
    // Escape, backdrop) used to swap straight into this inline `Card` with
    // no transition at all — unlike every phase swap *inside* the Dialog
    // above (`content-fade-in`, keyed by `phase`), the harder dialog-to-card
    // swap right here had nothing, so this card (and whatever it pushes
    // down, per the Boundary note above) just popped in. Same
    // `content-fade-in` keyframe (`index.css`) as everywhere else in this
    // file — it's a fresh mount each time this branch is reached, so it
    // replays automatically, no `key` needed.
    return (
      <Card className="content-fade-in">
        <CardHeader>
          <CardTitle>{t('activation.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">{t('activation.hint')}</p>
          <Button type="button" onClick={startReview}>
            {t('activation.startButton')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (phase === 'loading' || (phase === 'busy' && !review)) {
    // Bug fix (user-reported, live): a backdropped `Dialog`, not a plain
    // inline `Card` — the previous inline card meant the page visibly
    // dropped out of "Setting up your plan…"'s full-screen blocking modal
    // (`PlanWorkspace.tsx`) into ordinary page layout for however long this
    // fetch/generate call takes, then popped straight into the "Review
    // your plan" modal — two jarring mode switches. Staying in one
    // continuous backdropped-modal state the whole time (same
    // `popup-glass-strong` look) reads as one smooth hand-off instead.
    return (
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent showCloseButton={false} className="popup-glass-strong flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2 text-sm" aria-live="polite" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('activation.loading')}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (phase === 'failed' && !review) {
    // Same gap/fix as the `'idle'` card just above.
    return (
      <Card className="content-fade-in">
        <CardContent className="flex flex-col gap-2 p-6 text-sm">
          <p role="alert" className="text-muted-foreground">
            {t('activation.failed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setPhase('idle')}>
            {t('activation.cancelButton')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!review) return null;

  // Spec 2.12 AC4: every review-needing phase (reviewing/editing/rejecting),
  // plus a `busy`/`failed` state reached while a review is already loaded,
  // renders inside this one backdropped `Dialog` (same `shadcn-glass-ui`
  // import/usage as `IdeasPanel.tsx`'s idea-select confirm dialog) instead
  // of its own inline `Card` — so it never pushes `PlanWorkspace`'s status
  // column or chat down. User-reported follow-up: the X/Escape/backdrop
  // close now works (it used to no-op) — closing returns to the `'idle'`
  // trigger card below, same target `phase === 'failed' && !review`'s own
  // Cancel button already uses; it's a no-op while `'busy'` (a confirm/
  // modify/reject request in flight), so an in-progress mutation is never
  // abandoned from under itself. User-reported follow-up: `size="lg"`
  // (800px — was the library default `'sm'`/480px, then widened once
  // already to `'md'`/640px; this is the next tier up, ~25% wider than
  // that, closest available to a further +20% ask) plus a bounded,
  // scrollable height — a 6-step review's own content was tall enough to
  // clip the footer buttons past the viewport's bottom edge with no way to
  // reach them. `popup-glass-dense` (`index.css`) overrides the library's
  // own defaults (by design elsewhere, strengthened in round 3, then
  // explicitly set to "80% of" `popup-glass-strong`'s own see-through
  // amount in round 4 — see that class's own doc comment for the exact
  // numbers and for why it's a plain hand-written class, not a Tailwind
  // arbitrary-value one) — user-reported follow-up: a review this
  // information-dense still reads better more opaque than the other
  // popups' own `popup-glass-strong`, not as see-through as a short
  // confirm dialog like `IdeasPanel.tsx`'s own idea-select confirm — but
  // the original fully-solid `var(--card)` went further than asked;
  // `color-mix` keeps it mostly `--card` with a bit of the blurred page
  // behind it showing through.
  return (
    <Dialog
      open={!exiting}
      onOpenChange={(open: boolean) => {
        // UX fix (user-reported, live): this used to call `setPhase('idle')`
        // directly, which switches this component's own top-level return to
        // the plain `<Card>` branch above in the very same render — the
        // whole `<Dialog>` subtree is removed from the React tree outright,
        // so Radix never keeps a mounted `data-state='closed'` node around
        // for the `[data-state='closed']` fade (`index.css`) to actually
        // play on. Same `exiting`/`DIALOG_EXIT_MS` delay as `confirm()`'s
        // own success path below: flip `open` to `false` first (a real
        // close Radix/CSS can animate), only switch to the `'idle'` branch
        // once that fade has had time to play.
        if (!open && phase !== 'busy' && !exiting) {
          setExiting(true);
          exitTimeoutRef.current = window.setTimeout(() => {
            setExiting(false);
            setPhase('idle');
          }, DIALOG_EXIT_MS);
        }
      }}
    >
      <DialogContent size="lg" className="popup-glass-dense max-h-[85vh] overflow-y-auto">
        <div key={phase} className="content-fade-in">
          {phase === 'editing' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('activation.modifyButton')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 text-sm">
              {editableSteps.map((step, index) => (
                <div key={index} className="flex flex-col gap-2 border-b border-dashed border-border pb-3 last:border-none">
                  <Label htmlFor={`activation-title-${index}`}>
                    {t('activation.stepLabel', { index: index + 1 })} — {t('activation.titleLabel')}
                  </Label>
                  <input
                    id={`activation-title-${index}`}
                    className="h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={step.title}
                    onChange={(event) => {
                      const value = event.target.value;
                      setEditableSteps((prev) => prev.map((s, i) => (i === index ? { ...s, title: value } : s)));
                    }}
                  />
                  <Label htmlFor={`activation-description-${index}`}>{t('activation.descriptionLabel')}</Label>
                  <Textarea
                    id={`activation-description-${index}`}
                    value={step.descriptionText}
                    onChange={(event) => {
                      const value = event.target.value;
                      setEditableSteps((prev) => prev.map((s, i) => (i === index ? { ...s, descriptionText: value } : s)));
                    }}
                  />
                  <Label htmlFor={`activation-day-${index}`}>{t('activation.dayOffsetLabel')}</Label>
                  <input
                    id={`activation-day-${index}`}
                    type="number"
                    min={0}
                    className="h-10 w-24 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    value={step.dayOffset}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setEditableSteps((prev) => prev.map((s, i) => (i === index ? { ...s, dayOffset: value } : s)));
                    }}
                  />
                </div>
              ))}
              {editError ? (
                <p role="alert" className="text-muted-foreground">
                  {t('activation.invalidDraft')}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" onClick={saveEdits} disabled={phase === ('busy' as Phase)}>
                {t('activation.saveChangesButton')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPhase('reviewing')}>
                {t('activation.cancelButton')}
              </Button>
            </DialogFooter>
          </>
        ) : phase === 'rejecting' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('activation.rejectButton')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-sm">
              <Label htmlFor="activation-feedback">{t('activation.feedbackLabel')}</Label>
              <Textarea
                id="activation-feedback"
                placeholder={t('activation.feedbackPlaceholder') ?? ''}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
              />
              {feedbackError ? (
                <p role="alert" className="text-muted-foreground">
                  {feedbackError === 'stepCount'
                    ? t('activation.feedbackStepCountOutOfRange', { min: MIN_PLAN_STEPS, max: MAX_PLAN_STEPS })
                    : t('activation.feedbackRequired')}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" onClick={submitReject}>
                {t('activation.submitFeedbackButton')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPhase('reviewing')}>
                {t('activation.cancelButton')}
              </Button>
            </DialogFooter>
          </>
        ) : phase === 'failed' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('activation.reviewTitle', { ideaTitle })}</DialogTitle>
            </DialogHeader>
            <p role="alert" className="text-sm text-muted-foreground">
              {t('activation.failed')}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setPhase('reviewing')}>
                {t('activation.cancelButton')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          // phase === 'reviewing' | 'busy' (with a review already loaded)
          <>
            <DialogHeader>
              <DialogTitle>{t('activation.reviewTitle', { ideaTitle })}</DialogTitle>
              <DialogDescription>{t('activation.hint')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 text-sm">
              {review.steps
                .slice()
                .sort((a, b) => a.stepOrder - b.stepOrder)
                .map((step, index) => (
                  <div key={step.id} className="border-b border-dashed border-border pb-3 last:border-none">
                    {/* User-reported follow-up: the day now reads above the
                     * step, not below its actions — same text/translation,
                     * just moved. */}
                    <p className="text-xs text-muted-foreground">{t('activation.dayLabel', { day: step.dayOffset })}</p>
                    <p className="font-semibold">
                      {t('activation.stepLabel', { index: index + 1 })}: {step.title}
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {step.description.map((action, actionIndex) => (
                        <li key={actionIndex}>{stripLeadingBulletMarker(action)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
            <DialogFooter>
              <Button type="button" onClick={confirm} disabled={phase === 'busy'}>
                {phase === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {phase === 'busy' ? t('activation.activating') : t('activation.confirmButton')}
              </Button>
              <Button type="button" variant="outline" onClick={startEditing} disabled={phase === 'busy'}>
                {t('activation.modifyButton')}
              </Button>
              <Button type="button" variant="ghost" onClick={startRejecting} disabled={phase === 'busy'}>
                {t('activation.rejectButton')}
              </Button>
            </DialogFooter>
          </>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
