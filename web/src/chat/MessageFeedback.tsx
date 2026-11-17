import * as React from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage as ChatMessageType, FeedbackRating } from '@app/shared';
import { cn } from '../lib/utils';
import type { ChatMessageFooterItem } from './ChatMessage';

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
    const [comment, setComment] = React.useState('');
    const [commentOpen, setCommentOpen] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState(false);

    if (message.role !== 'assistant') return null;

    const feedbackUrl = `${endpoint}/${message.id}/feedback`;

    async function submitRating(nextRating: FeedbackRating): Promise<void> {
      setSaving(true);
      setError(false);
      try {
        const res = await fetch(feedbackUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: nextRating, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
        });
        if (!res.ok) throw new Error('feedback request failed');
        setRating(nextRating);
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
        setComment('');
        setCommentOpen(false);
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
      else void submitRating(nextRating);
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
            className={cn('rounded p-1 text-muted-foreground hover:text-foreground', rating === 'up' && 'text-foreground')}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t('feedback.thumbsDownLabel')}
            aria-pressed={rating === 'down'}
            disabled={saving}
            onClick={() => handleClick('down')}
            className={cn('rounded p-1 text-muted-foreground hover:text-foreground', rating === 'down' && 'text-foreground')}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
          {rating ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              disabled={saving}
              onClick={() => setCommentOpen((open) => !open)}
            >
              {t('feedback.commentToggle')}
            </button>
          ) : null}
        </span>
        {rating && commentOpen ? (
          <span className="flex items-center gap-1">
            <input
              type="text"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('feedback.commentPlaceholder')}
              className="h-7 flex-1 rounded border border-border bg-card px-2 text-xs"
            />
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              disabled={saving}
              onClick={() => void submitRating(rating)}
            >
              {t('feedback.submit')}
            </button>
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-destructive" role="alert">
            {t('feedback.error')}
          </span>
        ) : null}
      </span>
    );
  };
}
