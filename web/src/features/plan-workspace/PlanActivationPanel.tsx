import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  planActivationReviewSchema,
  createPlanDraftSchema,
  type PlanActivationReview,
  type PlanResponse,
  type CreatePlanDraft,
} from '@app/shared';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';

export interface PlanActivationPanelProps {
  planId: string;
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

/**
 * Story 3.2 (AD-14): the draft review/confirm/modify/reject panel. Own
 * component (Boundary: "own component, do not edit the layout file") —
 * `PlanWorkspace.tsx` only adds the one conditional render call for a
 * `draft` plan; this file owns all of the activation flow's own layout.
 */
export function PlanActivationPanel({ planId, onActivated }: PlanActivationPanelProps) {
  const { t } = useTranslation('plan');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [review, setReview] = React.useState<PlanActivationReview | null>(null);
  const [editableSteps, setEditableSteps] = React.useState<EditableStep[]>([]);
  const [editError, setEditError] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const [feedbackError, setFeedbackError] = React.useState(false);

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

  // Page-refresh mid-review: pick up any already-pending review instead of
  // starting a fresh one.
  React.useEffect(() => {
    const requestId = beginRequest();
    setPhase('loading');

    fetch(`/api/plans/${planId}/activate`, { credentials: 'include' })
      .then(async (res) => {
        if (isStale(requestId)) return;
        if (!res.ok) {
          setPhase('idle');
          return;
        }
        const body: unknown = await res.json();
        if (isStale(requestId)) return;
        const parsed = (body as { review?: unknown } | undefined)?.review;
        if (!parsed) {
          setPhase('idle');
          return;
        }
        const result = planActivationReviewSchema.safeParse(parsed);
        if (result.success) {
          setReview(result.data);
          setPhase('reviewing');
        } else {
          setPhase('idle');
        }
      })
      .catch(() => {
        if (!isStale(requestId)) setPhase('idle');
      });

    // Unmount counts as "stale" too (same precedent as `PlanWorkspace`'s own
    // `cancelled` flag) — bumping the counter here means this effect's own
    // `requestId` can never match again, so a response arriving after
    // unmount is silently dropped instead of calling `setState` on an
    // unmounted component.
    return () => {
      beginRequest();
    };
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
        onActivated(body as PlanResponse);
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
    setFeedbackError(false);
    setPhase('rejecting');
  }

  function submitReject() {
    if (feedback.trim().length === 0) {
      setFeedbackError(true);
      return;
    }
    setFeedbackError(false);
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

  if (phase === 'idle') {
    return (
      <Card>
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
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm" aria-live="polite" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('activation.loading')}
        </CardContent>
      </Card>
    );
  }

  if (phase === 'failed') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 p-6 text-sm">
          <p role="alert" className="text-muted-foreground">
            {t('activation.failed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setPhase(review ? 'reviewing' : 'idle')}>
            {t('activation.cancelButton')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!review) return null;

  if (phase === 'editing') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('activation.modifyButton')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
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
          <div className="flex gap-2">
            <Button type="button" onClick={saveEdits} disabled={phase === ('busy' as Phase)}>
              {t('activation.saveChangesButton')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPhase('reviewing')}>
              {t('activation.cancelButton')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (phase === 'rejecting') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('activation.rejectButton')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <Label htmlFor="activation-feedback">{t('activation.feedbackLabel')}</Label>
          <Textarea
            id="activation-feedback"
            placeholder={t('activation.feedbackPlaceholder') ?? ''}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          {feedbackError ? (
            <p role="alert" className="text-muted-foreground">
              {t('activation.feedbackRequired')}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" onClick={submitReject}>
              {t('activation.submitFeedbackButton')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPhase('reviewing')}>
              {t('activation.cancelButton')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // phase === 'reviewing' | 'busy' (with a review already loaded)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('activation.reviewTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {review.steps
          .slice()
          .sort((a, b) => a.stepOrder - b.stepOrder)
          .map((step, index) => (
            <div key={step.id} className="border-b border-dashed border-border pb-3 last:border-none">
              <p className="font-semibold">
                {t('activation.stepLabel', { index: index + 1 })}: {step.title}
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {step.description.map((action, actionIndex) => (
                  <li key={actionIndex}>{action}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">{t('activation.dayLabel', { day: step.dayOffset })}</p>
            </div>
          ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={confirm} disabled={phase === 'busy'}>
            {phase === 'busy' ? t('activation.activating') : t('activation.confirmButton')}
          </Button>
          <Button type="button" variant="outline" onClick={startEditing} disabled={phase === 'busy'}>
            {t('activation.modifyButton')}
          </Button>
          <Button type="button" variant="ghost" onClick={startRejecting} disabled={phase === 'busy'}>
            {t('activation.rejectButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
