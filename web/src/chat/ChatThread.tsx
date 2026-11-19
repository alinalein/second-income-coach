import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  chatHistoryResponseSchema,
  progressEventSchema,
  resultEventSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessage as ChatMessageType,
  type DetectedLanguage,
} from '@app/shared';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { cn, prefersReducedMotion } from '../lib/utils';
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

/** Story 2.13 (amended): how close to the bottom still counts as "already
 * there" for auto-follow — a user who's scrolled up even this far is still
 * treated as reading the tail, not browsing history, so a new message or
 * reply still pulls the view down. */
const NEAR_BOTTOM_THRESHOLD_PX = 80;


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
   * modes beside the text field)") — empty by default. Story 4.3 (render-
   * prop, Code Map, user-requested revision): a function that fills the
   * same draft the text input edits, rather than sending on its own — the
   * extension's result lands in the one input the user already knows, and
   * they hit this component's own existing Send button when ready, same as
   * a typed message. `detectedLanguage` (from a voice transcript) rides
   * along with whatever is eventually sent, attached at submit time;
   * `disabled` mirrors the text input's own `sending`-gated state. */
  inputExtra?: (fillDraft: (content: string, detectedLanguage?: DetectedLanguage) => void, disabled: boolean) => React.ReactNode;
  /** Spec 2.12 AC8: a message the caller wants shown live the moment it
   * arrives (here: `start_step`'s own direct-model-call acknowledgment),
   * without waiting for a reload/re-fetch of this thread's history. Id-
   * guarded below — the same message also lands in a later `GET .../messages`
   * history read (it was persisted server-side too), so it must never be
   * appended twice. */
  incomingMessage?: ChatMessageType;
}

export function ChatThread({ endpoint = DEFAULT_CHAT_ENDPOINT, footerItems = [], inputExtra, incomingMessage }: ChatThreadProps = {}) {
  const { t } = useTranslation('chat');
  const [messages, setMessages] = React.useState<ChatMessageType[]>([]);
  const [historyLoaded, setHistoryLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  // Story 4.3 (user-requested revision): a voice transcript's own detected
  // language, held until the message it rode in on is actually sent — set
  // by `inputExtra`'s `fillDraft`, read (and cleared) by `handleSubmit`.
  // Not cleared on further edits to `draft`: the AC expects the user to
  // review/correct the transcript in this same input before sending, and
  // an edit is still the same (voice-originated) message.
  const [pendingVoiceLanguage, setPendingVoiceLanguage] = React.useState<DetectedLanguage | undefined>(undefined);
  // User-reported: the composer's text field stayed a fixed one-line
  // height even as `draft` grew past it (typed, or filled by voice) — the
  // end of a long message was never visible at once. Uncapped auto-grow
  // (user-reported follow-up: no internal scrollbar, the field itself
  // just gets taller to fit everything).
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
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
  const scrollRegionRef = React.useRef<HTMLDivElement | null>(null);
  // Story 2.13 (amended): whether the user is currently at/near the bottom
  // of the scroll region — read by the auto-follow effect below, updated by
  // every scroll (both the user's own and our programmatic ones, which
  // always land within the threshold anyway). Starts `true` so the first
  // history load and the first turn both follow.
  const isNearBottomRef = React.useRef(true);

  React.useEffect(() => {
    const node = scrollRegionRef.current;
    if (!node) return undefined;
    function handleScroll(): void {
      if (!node) return;
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
    }
    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, []);

  // Opening/reloading the thread jumps straight to the latest activity (the
  // conversation's tail). Always instant (a page load, not a live scroll the
  // user would perceive as a jump) — no `behavior` needed either way.
  React.useEffect(() => {
    if (!historyLoaded) return;
    const node = scrollRegionRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [historyLoaded]);

  // Story 2.13 (amended) AC: "the view follows the newest content only
  // while the user is already at (or near) the bottom ... never moved when
  // the user has scrolled up." No jump to a computed position — just the
  // bottom, instant under reduced motion, otherwise a short smooth scroll.
  // Re-runs on `displayedStep` too, since the progress label toggling on/off
  // also changes the scroll region's content height.
  React.useEffect(() => {
    if (!isNearBottomRef.current) return;
    const node = scrollRegionRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [messages, displayedStep]);

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

  // Spec 2.12 AC8: appends `incomingMessage` the moment it arrives (a prop
  // change, not a fetch) — id-guarded against both an already-appended copy
  // of itself (a re-render with the same prop value) and the history GET
  // above, which may have already loaded this same server-persisted message
  // by the time this fires. Animated the same way a fresh SSE `result`
  // message is, so it reads as just having arrived rather than always
  // having been there.
  React.useEffect(() => {
    if (!incomingMessage) return;
    setMessages((prev) => (prev.some((message) => message.id === incomingMessage.id) ? prev : [...prev, incomingMessage]));
    setAnimatedIds((prev) => (prev.has(incomingMessage.id) ? prev : new Set(prev).add(incomingMessage.id)));
  }, [incomingMessage]);

  // Story 4.3 (Code Map): `handleSubmit`'s inner fetch/SSE logic, extracted
  // into this reusable function — the typed-text form below and the
  // `inputExtra` render-prop (e.g. `VoiceInput`) both call it, so a
  // confirmed voice transcript is "processed identically to a typed
  // check-in" (AC) all the way down to this one send path. `detectedLanguage`
  // is `undefined` for a typed message (unchanged request body/behavior);
  // set only by a voice send, carrying `gpt-transcribe`'s own detected
  // language downstream (AD-25).
  const sendMessage = React.useCallback(
    (content: string, detectedLanguage?: DetectedLanguage) => {
      if (!content || sending) return;

      const userMessage = makeLocalMessage('user', 'message', content);
      setMessages((prev) => [...prev, userMessage]);
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
            body: JSON.stringify({ content, detectedLanguage }),
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
    [sending, t, endpoint],
  );

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || sending) return;
      setDraft('');
      sendMessage(content, pendingVoiceLanguage);
      setPendingVoiceLanguage(undefined);
    },
    [draft, sending, sendMessage, pendingVoiceLanguage],
  );

  // Story 4.3 (user-requested revision, Code Map): what `inputExtra` (e.g.
  // `VoiceInput`) calls once a transcript is ready — fills this same `draft`
  // the text input edits (no separate review UI) and remembers its detected
  // language for `handleSubmit` to attach when the user actually sends it.
  const fillDraft = React.useCallback((content: string, detectedLanguage?: DetectedLanguage) => {
    setDraft(content);
    setPendingVoiceLanguage(detectedLanguage);
  }, []);

  return (
    // User-reported: the chat fills the full height of its column (PlanWorkspace gives
    // it a definite height); the scroll region below is the only scrolling part.
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="shrink-0">
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        {/* `CardContent` itself only bounds the height (`flex-1 min-h-0`);
         * this inner div is the actual scroll region — kept separate so
         * `ref` doesn't need to be threaded through `CardContent`'s own
         * `HTMLAttributes`-typed props. Carries `CardContent`'s usual
         * `p-6 pt-0` padding itself, since the outer one now opts out of it. */}
        <div
          ref={scrollRegionRef}
          data-testid="chat-scroll-region"
          className="chat-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto p-6 pt-0"
        >
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
        </div>
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-1.5 pb-3 shrink-0">
        <form ref={formRef} onSubmit={handleSubmit} className="flex w-full items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends (matching the single-line input's old native
              // behavior); Shift+Enter inserts a newline, same as every
              // other chat composer.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            placeholder={t('placeholder')}
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            disabled={sending}
            aria-label={t('messageAriaLabel')}
            rows={1}
            className="min-h-10 flex-1 resize-none overflow-hidden rounded-md border border-border bg-card px-3 py-2 text-sm leading-normal text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <Button type="submit" disabled={sending || !draft.trim()}>
            {t('sendButton')}
          </Button>
        </form>
        {/* User-reported: moved below the composer (was inline between the
         * text field and Send) — Story 3.1 extension point, empty by
         * default; Story 4.3 fills it with a voice-record control. The
         * disclaimer sits next to it either way. */}
        <div className="flex items-center gap-2">
          {inputExtra?.(fillDraft, sending)}
          <p className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">{t('aiDisclaimer')}</p>
        </div>
      </CardFooter>
    </Card>
  );
}
