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

/** Story 2.13 refinement: pinning (scroll the new message to the top, keep a
 * one-viewport bottom spacer) only kicks in once the conversation window is
 * actually full — measured on send as the scroll region's content height
 * (`scrollHeight`, before the new message is appended, bottom spacer
 * collapsed first — see `handleSubmit`) against this fraction of its own
 * visible height (`clientHeight`). Below the threshold the thread behaves
 * like a plain, unpinned list (AC: "behaves normally ... NO pinning, NO
 * bottom spacer").
 *
 * Bug fix (user-reported, screenshots): a single short exchange with
 * plenty of blank space still below it was pinning — "not full" by the
 * user's own example. 1.0 means the existing content must already fill (or
 * overflow) the window on its own, with nothing to spare, before pinning —
 * matching their "full" example (a scrollbar already showing). Previously
 * 0.85, before that 0.7. */
const ALMOST_FULL_THRESHOLD_RATIO = 1;


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
  // Layout fix (user-reported, companion to the fixed-height scroll
  // region): without this, a new exchange can land below the now-fixed
  // window's visible fold, requiring a manual scroll — the scrollable
  // region didn't exist before that fix, so neither did the need to manage
  // its scroll position. Pins the just-sent *user* message to the top of
  // the visible area (set in `handleSubmit` below) rather than always
  // jumping to the very bottom — a long reply then reads top-down from the
  // question that triggered it, instead of hiding that question above the
  // fold the moment the answer is long enough to fill the window.
  const scrollRegionRef = React.useRef<HTMLDivElement | null>(null);
  const bottomSpacerRef = React.useRef<HTMLDivElement | null>(null);
  const pinToTopMessageIdRef = React.useRef<string | null>(null);
  // Story 2.13 AC: "the user has scrolled up manually ... the view is not
  // moved against their will." Distinguishes a genuine user-initiated
  // scroll from the `scroll` event our own programmatic `scrollTo` below
  // also fires — set right before that call, for a window a little longer
  // than the smooth-scroll animation itself; a `scroll` event seen after it
  // expires is the user's own.
  const programmaticScrollUntilRef = React.useRef(0);
  const userScrolledAwayRef = React.useRef(false);
  // Story 2.13 refinement: whether the *last sent* turn crossed the
  // almost-full threshold — unlike `pinToTopMessageIdRef` (cleared once the
  // turn settles, so the one-time scroll-to-top never re-fires on an
  // unrelated later scroll), this stays put so the bottom spacer keeps that
  // turn's reply clear of the input for as long as it's the latest exchange.
  const almostFullRef = React.useRef(false);

  React.useEffect(() => {
    const node = scrollRegionRef.current;
    if (!node) return undefined;
    function handleScroll(): void {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      userScrolledAwayRef.current = true;
    }
    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, []);

  // The one case the pin-to-top behavior below doesn't cover: opening/
  // reloading the thread — there's no "just sent" message to pin, so this
  // instead jumps straight to the latest activity (the conversation's
  // tail). Always instant (a page load, not a live scroll the user would
  // perceive as a jump) — no `behavior` needed either way.
  React.useEffect(() => {
    if (!historyLoaded) return;
    const node = scrollRegionRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [historyLoaded]);

  // Bug fix (user-reported): the first version cleared the pin right after
  // its first (necessarily premature) scroll — at that point the reply
  // hadn't arrived yet, so there was nothing below the fold to scroll past,
  // and the pin never re-applied once the reply (and the content height
  // that comes with it) actually showed up. Re-asserts on every relevant
  // change instead, for as long as this turn is still in flight — the
  // progress label toggling on/off also changes the scroll region's
  // content height, so it's included alongside `messages`.
  //
  // Bug fix round 2 (user-reported: still landed scrolled to the bottom,
  // question hidden above the fold): `scrollIntoView` scrolls *every*
  // scrollable ancestor as needed to bring the target into view, not just
  // this one region — when the page itself is also tall enough to scroll
  // (header/sidebar content above the chat card), the browser can satisfy
  // the "bring it into view" request by scrolling the *page*, leaving this
  // region's own `scrollTop` wherever it already was. Computing the exact
  // delta via `getBoundingClientRect()` and calling *this node's own*
  // `scrollTo` can never touch any ancestor's scroll position.
  //
  // Story 2.13: smooth (or instant under reduced motion, AC) via
  // `scrollTo`'s own `behavior` option; suppressed entirely once the user
  // has scrolled away on their own during this turn (`userScrolledAwayRef`).
  React.useEffect(() => {
    const pendingId = pinToTopMessageIdRef.current;
    if (!pendingId || userScrolledAwayRef.current) return;
    const node = scrollRegionRef.current;
    const target = node?.querySelector<HTMLElement>(`[data-message-id="${pendingId}"]`);
    if (!node || !target) return;
    const nodeRect = node.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = node.scrollTop + (targetRect.top - nodeRect.top);
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    programmaticScrollUntilRef.current = Date.now() + 500;
    node.scrollTo({ top, behavior });
  }, [messages, displayedStep]);

  // Stops re-pinning once the turn settles — a later, unrelated scroll (the
  // user reading back up through history) is then never fought.
  React.useEffect(() => {
    if (!sending) pinToTopMessageIdRef.current = null;
  }, [sending]);

  // Story 2.13 AC: "a bottom spacer of about one viewport so the reply is
  // never cut off by the input" — `min-height` = this region's own visible
  // height minus the height of the last user+assistant pair (never
  // negative), recomputed whenever that pair's content changes. Measures
  // from the most recent *user* message's own top (the same row the pin-
  // to-top effect above targets) down to the spacer's own position — that
  // span covers the user message plus whatever reply/progress-label
  // followed it, with no need to special-case "has the reply arrived yet".
  React.useEffect(() => {
    const node = scrollRegionRef.current;
    const spacer = bottomSpacerRef.current;
    if (!node || !spacer) return;

    // Story 2.13 refinement AC: "while the conversation still fits
    // comfortably ... NO bottom spacer" — only the almost-full turn gets one.
    if (!almostFullRef.current) {
      spacer.style.minHeight = '0px';
      return;
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const pairStart = lastUserMessage ? node.querySelector<HTMLElement>(`[data-message-id="${lastUserMessage.id}"]`) : null;
    if (!pairStart) {
      spacer.style.minHeight = '0px';
      return;
    }

    const pairHeight = spacer.offsetTop - pairStart.offsetTop;
    spacer.style.minHeight = `${Math.max(0, node.clientHeight - pairHeight)}px`;
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

      // Story 2.13 refinement: measured against the content height *before*
      // this message is appended — the "would no longer fit" check is about
      // the room left, not the room this message itself will take up.
      //
      // Bug fix (user-reported): a previous turn's bottom spacer (sized to
      // ~one viewport once pinned) stays in the DOM and counts toward
      // `scrollHeight`, so every later send kept reading as "almost full"
      // forever, even for a short follow-up. Collapsing it first measures
      // only the real message content; the spacer effect below (keyed on
      // `messages`/`displayedStep`) re-sizes it right after, from this
      // turn's own `almostFullRef`.
      const scrollNode = scrollRegionRef.current;
      const spacerNode = bottomSpacerRef.current;
      if (spacerNode) spacerNode.style.minHeight = '0px';
      const isAlmostFull =
        !!scrollNode && scrollNode.clientHeight > 0 && scrollNode.scrollHeight >= scrollNode.clientHeight * ALMOST_FULL_THRESHOLD_RATIO;
      almostFullRef.current = isAlmostFull;

      const userMessage = makeLocalMessage('user', 'message', content);
      pinToTopMessageIdRef.current = isAlmostFull ? userMessage.id : null;
      // A fresh turn always re-pins to *its own* new message — any scroll-
      // away the user did during a previous turn never carries over.
      userScrolledAwayRef.current = false;
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
        <div ref={scrollRegionRef} data-testid="chat-scroll-region" className="flex flex-1 flex-col gap-3 overflow-y-auto p-6 pt-0">
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
          {/* Story 2.13 AC: "a bottom spacer of about one viewport so the
           * reply is never cut off by the input" — height set imperatively
           * by the effect above, not a static class, since it depends on
           * the last user+assistant pair's own (dynamic) height. */}
          <div ref={bottomSpacerRef} data-testid="chat-bottom-spacer" aria-hidden="true" />
        </div>
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2 shrink-0">
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
        <div className="flex items-center gap-2 px-1">
          {inputExtra?.(fillDraft, sending)}
          <p className="text-xs text-muted-foreground">{t('aiDisclaimer')}</p>
        </div>
      </CardFooter>
    </Card>
  );
}
