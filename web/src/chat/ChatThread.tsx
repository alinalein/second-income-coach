import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  chatHistoryResponseSchema,
  progressEventSchema,
  resultEventSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessage as ChatMessageType,
} from '@app/shared';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { cn } from '../lib/utils';
import { ChatMessage, type ChatMessageFooterItem } from './ChatMessage';
import { createProgressLabelScheduler } from './progressLabelScheduler';
import { parseSseStream } from './sse';

/** Story 3.1: the discovery thread's own default endpoint — unchanged
 * behavior for every existing caller that doesn't pass `endpoint`. */
const DEFAULT_CHAT_ENDPOINT = '/api/chat/messages';

/** Review follow-up: a crossfade (fade the old label out, swap text, fade
 * the new one in) instead of an instant pop, so a label change reads as a
 * smooth transition rather than a jump — the same cosmetic treatment as the
 * typing reveal (ChatMessage.tsx), just opacity instead of character reveal.
 * The very first label of a turn still appears immediately (no fade-in) —
 * nothing was on screen yet to transition from. */
const PROGRESS_LABEL_FADE_MS = 200;

function makeLocalMessage(role: ChatMessageType['role'], kind: ChatMessageType['kind'], content: string): ChatMessageType {
  return {
    id: `local-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    role,
    kind,
    content,
    createdAt: new Date().toISOString(),
  };
}

/** SSE frame `data` is raw text off the wire — parsed defensively so a
 * malformed frame is just skipped (schema `safeParse` below rejects it)
 * rather than crashing the submit flow. */
function safeJsonParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * AC: "the shared `ChatThread`/`ChatMessage` component ... not a one-off,
 * page-specific widget" — reads the signed-in user's history back from
 * `GET /api/chat/messages` (the checkpointer's own thread state, still plain
 * JSON) and sends new messages via `POST /api/chat/messages`, now consumed
 * as one turn-scoped SSE connection (Story 1.5, AD-19 amended) carrying
 * `progress` status frames followed by one terminal `result` frame — never
 * partial answer text.
 */
export interface ChatThreadProps {
  /**
   * Story 3.1 (Code Map: "accept an `endpoint`/`threadKind` prop (default
   * discovery, unchanged behavior) so `PlanWorkspace` can point it at
   * `/api/plans/:planId/messages`"). Both `GET` and `POST` are issued
   * against this same base path, mirroring the discovery thread's own
   * `/api/chat/messages` shape exactly.
   */
  endpoint?: string;
  /** Story 3.1 extension point, forwarded to every `ChatMessage` — empty by
   * default (see `ChatMessage.tsx`'s `ChatMessageFooterItem`). */
  footerItems?: readonly ChatMessageFooterItem[];
  /** Story 3.1 extension point: an extra chat-input mode rendered beside
   * the text field (Code Map: "chat input extension point (extra input
   * modes beside the text field)") — empty by default; Story 4.3 fills it
   * with a voice-record control. */
  inputExtra?: React.ReactNode;
}

export function ChatThread({ endpoint = DEFAULT_CHAT_ENDPOINT, footerItems = [], inputExtra }: ChatThreadProps = {}) {
  const { t } = useTranslation('chat');
  const [messages, setMessages] = React.useState<ChatMessageType[]>([]);
  const [historyLoaded, setHistoryLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  // AC1/AC3: the current turn's localized progress label, sourced from the
  // SSE `progress` frames (Code Map).
  const [currentStep, setCurrentStep] = React.useState<string | null>(null);
  // Review follow-up: what's actually rendered, one crossfade step behind
  // `currentStep` — see the effect below.
  const [displayedStep, setDisplayedStep] = React.useState<string | null>(null);
  const [labelVisible, setLabelVisible] = React.useState(false);
  // Design Notes: "Only the just-arrived message animates ... ChatThread
  // tracks ids delivered via the SSE `result` event (not history GET)".
  const [animatedIds, setAnimatedIds] = React.useState<ReadonlySet<string>>(new Set());

  // Review follow-up: crossfades `displayedStep` toward `currentStep`
  // instead of swapping instantly — fades the current label out, then swaps
  // the text (or clears it) and fades the new one in. The very first label
  // of a turn (nothing shown yet) appears immediately, matching AD-31's "the
  // very first label may appear immediately".
  React.useEffect(() => {
    if (currentStep === displayedStep) return undefined;

    if (displayedStep === null) {
      setDisplayedStep(currentStep);
      setLabelVisible(true);
      return undefined;
    }

    setLabelVisible(false);
    const timeoutId = setTimeout(() => {
      setDisplayedStep(currentStep);
      setLabelVisible(currentStep !== null);
    }, PROGRESS_LABEL_FADE_MS);

    return () => clearTimeout(timeoutId);
  }, [currentStep, displayedStep]);

  React.useEffect(() => {
    let cancelled = false;

    fetch(endpoint, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = chatHistoryResponseSchema.safeParse(body);
        if (result.success) setMessages(result.data.messages);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || sending) return;

      setMessages((prev) => [...prev, makeLocalMessage('user', 'message', content)]);
      setDraft('');
      setSending(true);
      setCurrentStep(null);

      // Review follow-up: enforces MIN_LABEL_MS before a label can be
      // replaced by the next one (never before the final answer, which
      // always clears immediately) — see progressLabelScheduler.ts.
      const labelScheduler = createProgressLabelScheduler(setCurrentStep);

      void (async () => {
        let settled = false;

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          });

          // Code Map: "submit flow switches from `res.json()` to
          // `for await (const frame of parseSseStream(res))`" — `progress`
          // frames feed `labelScheduler`; the `result` frame appends the
          // message, records its id as "newly arrived" (animates), and
          // clears the label.
          for await (const frame of parseSseStream(res)) {
            if (frame.event === 'progress') {
              const parsed = progressEventSchema.safeParse(safeJsonParse(frame.data));
              if (parsed.success) labelScheduler.push(parsed.data.step);
            } else if (frame.event === 'result') {
              const parsed = resultEventSchema.safeParse(safeJsonParse(frame.data));
              if (parsed.success) {
                settled = true;
                const { message } = parsed.data;
                setAnimatedIds((prev) => new Set(prev).add(message.id));
                setMessages((prev) => [...prev, message]);
              }
            }
          }
        } catch {
          // Covers two shapes: a network/parse failure before any server
          // reply arrived, and a failure mid-stream after one or more
          // `progress` frames (and their UI) already rendered. Either way no
          // per-message language detection is possible, so the local
          // fallback is resolved against the current UI language (I/O matrix).
        }

        if (!settled) {
          setMessages((prev) => [...prev, makeLocalMessage('assistant', 'error', t('error.modelFailure'))]);
        }
        // The answer is ready (or the turn failed) — clear immediately,
        // never delayed to satisfy the minimum (progressLabelScheduler.ts).
        labelScheduler.clear();
        setSending(false);
      })();
    },
    [draft, sending, t, endpoint],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!historyLoaded ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          messages.map((message) => (
            <ChatMessage key={message.id} message={message} animate={animatedIds.has(message.id)} footerItems={footerItems} />
          ))
        )}
        {sending && displayedStep && (
          <p
            className={cn(
              'text-sm text-muted-foreground transition-opacity duration-200 ease-in-out',
              labelVisible ? 'opacity-100' : 'opacity-0',
            )}
            role="status"
            aria-live="polite"
          >
            {/* AD-31: "never a blank state or the raw hook/tool name" — the
                registry only ever emits keys both locale files carry today,
                but this `defaultValue` keeps that true even if a future
                tool-introducing story's backend step key lands a deploy
                ahead of its i18n key. */}
            {t(`progress.${displayedStep}`, { defaultValue: t('progress.tool_fallback') })}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <form onSubmit={handleSubmit} className="flex w-full gap-2">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('placeholder')}
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            disabled={sending}
            aria-label={t('messageAriaLabel')}
            className="h-10 flex-1 rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          {/* Story 3.1 extension point: empty by default — Story 4.3 fills
           * this with a voice-record control; typed text stays available
           * either way. */}
          {inputExtra}
          <Button type="submit" disabled={sending || !draft.trim()}>
            {t('sendButton')}
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
}
