import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ChatThread } from './ChatThread';
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
