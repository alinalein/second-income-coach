import * as React from 'react';
import { createPortal } from 'react-dom';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage as ChatMessageType, FeedbackRating } from '@app/shared';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import type { ChatMessageFooterItem } from './ChatMessage';

/**
 * UI fix (user-reported): a comment is now written in a modal dialog
 * (matching the reference screenshot's own feedback popup), not an inline-
 * expanding input row. Rendered via `createPortal` to `document.body` —
 * `Card`'s own `glass-panel` utility sets `backdrop-filter`, which creates
 * a new containing block for any `position: fixed` descendant (same effect
 * as `transform`), so a fixed-positioned overlay nested inside one would be
 * clipped/mispositioned to the card's own bounds instead of the viewport.
 * Escaping to `document.body` sidesteps that entirely.
 */
function CommentModal({
  rating,
  initialComment,
  saving,
  onCancel,
  onSave,
}: {
  rating: FeedbackRating;
  initialComment: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (comment: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [draft, setDraft] = React.useState(initialComment);
  const titleId = React.useId();

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass-panel w-full max-w-md rounded-xl border p-5 shadow-[var(--shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {rating === 'up' ? t('feedback.modalTitlePositive') : t('feedback.modalTitleNegative')}
        </h2>
        <label className="mt-3 block text-sm text-muted-foreground" htmlFor={`${titleId}-textarea`}>
          {t('feedback.modalLabel')}
        </label>
        <Textarea
          id={`${titleId}-textarea`}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('feedback.commentPlaceholder')}
          className="mt-1"
        />
        <p className="mt-2 text-xs italic text-muted-foreground">{t('feedback.modalDisclosure')}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>
            {t('feedback.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => onSave(draft)}>
            {t('feedback.submit')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Story 5.3: the `MessageFeedback` footer item, as a factory
 * (`createMessageFeedbackItem(endpoint)`) rather than a plain component —
 * `ChatMessageFooterItem`'s contract is `{ message }` only (Story 3.1,
 * never widened for this), so which router to call (`/api/chat/messages`
 * vs. `/api/plans/:planId/messages`) has to be closed over instead, the
 * same `endpoint` shape `ChatThread`'s own prop already uses.
 *
 * Deliberately holds no feedback state fetched from the server — `GET /
 * messages` never grows a feedback field (Boundary: only one new field,
 * `cost`, on `ChatMessage`) — so a rating set in an earlier session isn't
 * reflected after a reload; this component's own state is this page
 * session's view of it only.
 *
 * Boundary (explicit test, `ChatThread.test.tsx`): this component has no
 * way to reach `ChatThread`'s own input state at all (no shared state, no
 * prop threading) — the chat input can never be disabled or gated on
 * feedback, by construction.
 */
export function createMessageFeedbackItem(endpoint: string): ChatMessageFooterItem {
  return function MessageFeedback({ message }: { message: ChatMessageType }) {
    const { t } = useTranslation('chat');
    const [rating, setRating] = React.useState<FeedbackRating | null>(null);
    const [modalOpen, setModalOpen] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState(false);
    // Bug fix (user-reported): clicking "Save" with a comment typed did
    // POST successfully, but gave no visible sign anything happened when
    // the rating itself didn't change (the common case — a comment is
    // always attached to an already-set rating). Closing the modal and
    // showing the saved text back is the confirmation.
    const [savedComment, setSavedComment] = React.useState<string | null>(null);

    if (message.role !== 'assistant') return null;

    const feedbackUrl = `${endpoint}/${message.id}/feedback`;

    async function submitRating(nextRating: FeedbackRating, comment?: string): Promise<void> {
      setSaving(true);
      setError(false);
      try {
        const trimmed = comment?.trim();
        const res = await fetch(feedbackUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: nextRating, ...(trimmed ? { comment: trimmed } : {}) }),
        });
        if (!res.ok) throw new Error('feedback request failed');
        setRating(nextRating);
        setSavedComment(trimmed || null);
        setModalOpen(false);
      } catch {
        setError(true);
      } finally {
        setSaving(false);
      }
    }

    async function removeRating(): Promise<void> {
      setSaving(true);
      setError(false);
      try {
        const res = await fetch(feedbackUrl, { method: 'DELETE', credentials: 'include' });
        if (!res.ok && res.status !== 404) throw new Error('feedback removal failed');
        setRating(null);
        setModalOpen(false);
        setSavedComment(null);
      } catch {
        setError(true);
      } finally {
        setSaving(false);
      }
    }

    function handleClick(nextRating: FeedbackRating): void {
      // I/O matrix: "Change/remove rating" — clicking the already-active
      // thumb removes it; clicking the other one sets/changes it.
      if (rating === nextRating) void removeRating();
      else void submitRating(nextRating, savedComment ?? undefined);
    }

    return (
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('feedback.thumbsUpLabel')}
            aria-pressed={rating === 'up'}
            disabled={saving}
            onClick={() => handleClick('up')}
            className={cn(
              'rounded p-1 text-muted-foreground hover:text-foreground',
              // Bug fix (user-reported): the old "muted -> foreground" text
              // color swap was barely visible against the bubble background.
              // Active state is now a distinct color plus a filled icon and
              // its own background tint, not a single subtle text-color step.
              rating === 'up' && 'bg-primary/10 text-primary hover:text-primary',
            )}
          >
            <ThumbsUp className="h-3.5 w-3.5" fill={rating === 'up' ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            aria-label={t('feedback.thumbsDownLabel')}
            aria-pressed={rating === 'down'}
            disabled={saving}
            onClick={() => handleClick('down')}
            className={cn(
              'rounded p-1 text-muted-foreground hover:text-foreground',
              rating === 'down' && 'bg-destructive/10 text-destructive hover:text-destructive',
            )}
          >
            <ThumbsDown className="h-3.5 w-3.5" fill={rating === 'down' ? 'currentColor' : 'none'} />
          </button>
          {rating ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              disabled={saving}
              onClick={() => setModalOpen(true)}
            >
              {savedComment ? t('feedback.editComment') : t('feedback.commentToggle')}
            </button>
          ) : null}
        </span>
        {savedComment ? (
          <span className="text-xs text-muted-foreground" aria-label={t('feedback.savedCommentLabel')}>
            “{savedComment}”
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-destructive" role="alert">
            {t('feedback.error')}
          </span>
        ) : null}
        {rating && modalOpen ? (
          <CommentModal
            rating={rating}
            initialComment={savedComment ?? ''}
            saving={saving}
            onCancel={() => setModalOpen(false)}
            onSave={(comment) => void submitRating(rating, comment)}
          />
        ) : null}
      </span>
    );
  };
}
