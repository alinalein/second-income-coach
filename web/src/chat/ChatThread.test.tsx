import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ChatThread } from './ChatThread';
import { createMessageFeedbackItem } from './MessageFeedback';
import chatEn from '../locales/en/chat.json';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

/** Builds an SSE `Response` (the `POST /api/chat/messages` wire format,
 * Story 1.5) from a list of pre-built `event: ...\ndata: ...\n\n` frames —
 * all enqueued as one chunk is enough here; `sse.test.ts` already covers
 * chunk-boundary parsing in isolation. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join('')));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function progressFrame(step: string): string {
  return `event: progress\ndata: ${JSON.stringify({ type: 'progress', step })}\n\n`;
}

function resultFrame(message: Record<string, unknown>): string {
  return `event: result\ndata: ${JSON.stringify({ type: 'result', message })}\n\n`;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// AC: "the chat UI, when built, then it is the shared ChatThread/ChatMessage
// component (message list, text input, error and neutral-notice rendering)".
describe('ChatThread (AC: chat UI)', () => {
  // Review follow-up: a notice renders through the exact same bubble as a
  // normal message now (no separate pill style) — the only remaining
  // distinction is non-visual, the bubble's `role="status"`.
  it('renders checkpointed history, giving a notice the same bubble as a normal message but an accessible "status" role', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/chat/messages': new Response(
          JSON.stringify({
            messages: [
              { id: '1', role: 'user', kind: 'message', content: 'Hi there', createdAt: new Date().toISOString() },
              {
                id: '2',
                role: 'assistant',
                kind: 'notice',
                content: "I can't help with that request.",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        ),
      }),
    );

    render(<ChatThread />);

    expect(await screen.findByText('Hi there')).toBeInTheDocument();
    const notice = screen.getByText(/can't help with that request/i);
    expect(notice).toBeInTheDocument();
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  // AC1/AC6: progress frames arrive before the terminal result frame, over
  // the one SSE connection the POST response now is.
  it('submits a typed message, clears the input, and renders the reply after the SSE stream completes', async () => {
    let postedBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          postedBody = JSON.parse(String(init.body));
          return Promise.resolve(
            sseResponse([
              progressFrame('checking_message'),
              progressFrame('generating_response'),
              progressFrame('checking_answer'),
              resultFrame({
                id: 'reply-1',
                role: 'assistant',
                kind: 'message',
                content: 'Sure, happy to help!',
                createdAt: new Date().toISOString(),
              }),
            ]),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );

    render(<ChatThread />);

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'How do I get started?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Sure, happy to help!')).toBeInTheDocument();
    expect(screen.getByText('How do I get started?')).toBeInTheDocument();
    await waitFor(() => expect(input.value).toBe(''));
    expect(postedBody).toEqual({ content: 'How do I get started?' });
  });

  // Story 4.3 (Code Map/AD-25, user-requested revision): `inputExtra` is a
  // render-prop handed `fillDraft` — proving an extension (e.g.
  // `VoiceInput`) fills the same draft the text input edits, with its
  // detected language carried through to the existing Send button's own
  // POST, once the user actually sends it.
  it('fills the draft via a render-prop inputExtra, carrying detectedLanguage through the existing Send button', async () => {
    let postedBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          postedBody = JSON.parse(String(init.body));
          return Promise.resolve(
            sseResponse([resultFrame({ id: 'reply-voice', role: 'assistant', kind: 'message', content: 'Klar!', createdAt: new Date().toISOString() })]),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );

    render(
      <ChatThread
        inputExtra={(fillDraft, disabled) => (
          <button disabled={disabled} onClick={() => fillDraft('Hallo', 'de')}>
            voice-fill
          </button>
        )}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'voice-fill' }));

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    expect(input.value).toBe('Hallo');

    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Klar!')).toBeInTheDocument();
    expect(postedBody).toEqual({ content: 'Hallo', detectedLanguage: 'de' });
  });

  // AC1/AC3: the localized progress label for the turn's current step is
  // shown while a message is in flight, sourced from the `progress` SSE
  // frames (not model text, not a raw step key).
  it('shows the localized progress label for each step as the SSE stream delivers it', async () => {
    let releaseFinalFrame: (() => void) | undefined;
    const finalFrameGate = new Promise<void>((resolve) => {
      releaseFinalFrame = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(progressFrame('checking_message')));
              await finalFrameGate;
              controller.enqueue(
                encoder.encode(
                  resultFrame({
                    id: 'reply-2',
                    role: 'assistant',
                    kind: 'message',
                    content: 'Done!',
                    createdAt: new Date().toISOString(),
                  }),
                ),
              );
              controller.close();
            },
          });
          return Promise.resolve(new Response(body, { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );

    render(<ChatThread />);

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText(chatEn.progress.checking_message)).toBeInTheDocument();

    releaseFinalFrame?.();
    expect(await screen.findByText('Done!')).toBeInTheDocument();
    expect(screen.queryByText(chatEn.progress.checking_message)).not.toBeInTheDocument();
  });

  // AC1 / I/O matrix: "Network/parse failure before any server reply" -> the
  // local fallback is resolved via `t('error.modelFailure')` against the
  // current UI language (no server round-trip happened, so no per-message
  // detection is possible — Design Notes). Guards the swap from the old
  // hardcoded `MODEL_FAILURE_MESSAGE` import to the i18n key: the rendered
  // text must still match that exact sentence in the default (English) UI.
  it('shows the localized model-failure fallback when the POST fetch itself rejects (no server round-trip)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') return Promise.reject(new Error('network down'));
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );

    render(<ChatThread />);

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText(chatEn.error.modelFailure)).toBeInTheDocument();
  });
});

// Story 2.13 AC (refined): pinning only kicks in once the chat is almost
// full. "the view scrolls so the user's new message sits at the top" / "a
// bottom spacer ... so the reply is never cut off" / "the user has scrolled
// up manually ... the view is not moved against their will".
describe('ChatThread (Story 2.13: chat scroll behaviour)', () => {
  // Simulates the scroll region's layout so the almost-full measurement
  // (`clientHeight` vs `scrollHeight`) can be controlled from a test —
  // jsdom never computes real layout, both are normally 0.
  function mockScrollRegionSize(clientHeight: number, scrollHeight: number): void {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: clientHeight });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, value: scrollHeight });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  // AC: "while the conversation still fits comfortably ... NO pinning, NO
  // bottom spacer" — content height below the container's own height.
  it('does not pin or add a bottom spacer when the chat comfortably fits', async () => {
    mockScrollRegionSize(600, 100);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          return Promise.resolve(
            sseResponse([resultFrame({ id: 'reply-4', role: 'assistant', kind: 'message', content: 'Sure!', createdAt: new Date().toISOString() })]),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );
    const scrollToSpy = vi.spyOn(Element.prototype, 'scrollTo');

    render(<ChatThread />);
    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Give me an example' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Sure!')).toBeInTheDocument();
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-bottom-spacer')).toHaveStyle({ minHeight: '0px' });
  });

  // AC: "almost full ... scroll the user's new message to the top ... keep
  // the bottom spacer of about one viewport" — content height already at/
  // above the container's own height (bug fix: a scrollbar must already be
  // warranted — see `ALMOST_FULL_THRESHOLD_RATIO`'s own comment).
  it('pins the new message to the top and keeps a bottom spacer when the chat is almost full', async () => {
    mockScrollRegionSize(600, 650);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          return Promise.resolve(
            sseResponse([resultFrame({ id: 'reply-5', role: 'assistant', kind: 'message', content: 'Here is a plan.', createdAt: new Date().toISOString() })]),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );
    const scrollToSpy = vi.spyOn(Element.prototype, 'scrollTo');

    render(<ChatThread />);
    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Plan my day' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Here is a plan.')).toBeInTheDocument();
    await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());
    expect(screen.getByTestId('chat-bottom-spacer')).not.toHaveStyle({ minHeight: '0px' });
  });

  it('stops auto-scrolling for the rest of the turn once the user scrolls away on their own', async () => {
    mockScrollRegionSize(600, 650);
    let releaseReply: (() => void) | undefined;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              await replyGate;
              controller.enqueue(
                encoder.encode(
                  resultFrame({ id: 'reply-6', role: 'assistant', kind: 'message', content: 'Here you go.', createdAt: new Date().toISOString() }),
                ),
              );
              controller.close();
            },
          });
          return Promise.resolve(new Response(body, { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );
    const scrollToSpy = vi.spyOn(Element.prototype, 'scrollTo');

    render(<ChatThread />);
    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Plan something' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());
    const callsBeforeManualScroll = scrollToSpy.mock.calls.length;

    // Past the programmatic-scroll suppression window, so the next `scroll`
    // event registers as the user's own, not an echo of the call above.
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.scroll(screen.getByTestId('chat-scroll-region'));

    releaseReply?.();
    await screen.findByText('Here you go.');

    expect(scrollToSpy.mock.calls.length).toBe(callsBeforeManualScroll);
  });

  // Bug fix (user-reported): the chat kept pinning on *every* send after the
  // first pin — a previous turn's bottom spacer (sized to ~one viewport)
  // stayed in the DOM and was counted in `scrollHeight`, so every later
  // measurement read as "almost full" no matter how little real content had
  // grown. `clientHeight`/`scrollHeight` are mocked on the real nodes here
  // (not the whole prototype) so `scrollHeight` reflects the spacer's own
  // live `offsetHeight` — exactly what the fix (collapsing the spacer before
  // measuring) must exclude.
  it('measures real content without the spacer, so a short follow-up does not re-pin right after an earlier pin', async () => {
    let realContentHeight = 100;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          const { content } = JSON.parse(String(init.body)) as { content: string };
          return Promise.resolve(
            sseResponse([
              resultFrame({ id: `reply-${content}`, role: 'assistant', kind: 'message', content: `Reply to ${content}`, createdAt: new Date().toISOString() }),
            ]),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      }),
    );
    const scrollToSpy = vi.spyOn(Element.prototype, 'scrollTo');

    render(<ChatThread />);
    const scrollNode = screen.getByTestId('chat-scroll-region');
    const spacerNode = screen.getByTestId('chat-bottom-spacer');
    Object.defineProperty(scrollNode, 'clientHeight', { configurable: true, value: 600 }); // tall container
    Object.defineProperty(spacerNode, 'offsetHeight', {
      configurable: true,
      get: () => parseFloat(spacerNode.style.minHeight || '0') || 0,
    });
    Object.defineProperty(scrollNode, 'scrollHeight', {
      configurable: true,
      get: () => realContentHeight + spacerNode.offsetHeight,
    });

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    async function send(content: string): Promise<void> {
      fireEvent.change(input, { target: { value: content } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      await screen.findByText(`Reply to ${content}`);
    }

    // 3 short messages: real content stays below the container's own
    // height (600) throughout — no pin on any of them.
    await send('one');
    expect(scrollToSpy).not.toHaveBeenCalled();
    realContentHeight = 300;
    await send('two');
    expect(scrollToSpy).not.toHaveBeenCalled();
    realContentHeight = 480;
    await send('three');
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Real content crosses the threshold (now already overflowing the
    // container, not just close to it): pins once, spacer grows to ~one
    // viewport.
    realContentHeight = 650;
    await send('four');
    expect(scrollToSpy).toHaveBeenCalled();
    expect(parseFloat(spacerNode.style.minHeight || '0')).toBeGreaterThan(0);
    const callsAfterPin = scrollToSpy.mock.calls.length;

    // Short follow-up right after: real content (spacer excluded) is back
    // below the threshold, so this one does not re-pin.
    realContentHeight = 200;
    await send('five');
    expect(scrollToSpy.mock.calls.length).toBe(callsAfterPin);
  });
});

// Story 5.3 Boundary (explicit test): "the chat input is never disabled or
// gated on a missing rating." `MessageFeedback` shares no state and no prop
// with `ChatThread`'s own input — this exercises them together, with no
// rating given at all and with a feedback request left pending, to prove
// neither state has any bearing on the input's `disabled` attribute.
describe('ChatThread (Story 5.3 Boundary: chat input independent of feedback)', () => {
  it('keeps the message input enabled with no rating given, and while a feedback request is in flight', async () => {
    let resolveFeedbackFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/feedback')) {
          return new Promise<Response>((resolve) => {
            resolveFeedbackFetch = resolve;
          });
        }
        if (url.includes('/api/chat/messages') && init?.method !== 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                messages: [{ id: 'reply-1', role: 'assistant', kind: 'message', content: 'Here is an idea.', createdAt: new Date().toISOString() }],
              }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    render(<ChatThread footerItems={[createMessageFeedbackItem('/api/chat/messages')]} />);

    const input = (await screen.findByRole('textbox', { name: /message/i })) as HTMLInputElement;
    expect(input).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('Good response'));
    expect(input).not.toBeDisabled();

    resolveFeedbackFetch(new Response(JSON.stringify({ feedback: { rating: 'up', comment: null } }), { status: 200 }));
    await waitFor(() => expect(screen.getByLabelText('Good response')).toHaveAttribute('aria-pressed', 'true'));
    expect(input).not.toBeDisabled();
  });
});
