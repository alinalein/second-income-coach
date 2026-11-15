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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// AC: "the chat UI, when built, then it is the shared ChatThread/ChatMessage
// component (message list, text input, error and neutral-notice rendering)".
describe('ChatThread (AC: chat UI)', () => {
  it('renders checkpointed history, distinguishing a notice from a normal message', async () => {
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
    expect(notice).toHaveAttribute('role', 'status');
  });

  it('submits a typed message, clears the input, and renders the reply', async () => {
    let postedBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/api/chat/messages')) throw new Error(`Unmocked fetch: ${url}`);
        if (init?.method === 'POST') {
          postedBody = JSON.parse(String(init.body));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                message: {
                  id: 'reply-1',
                  role: 'assistant',
                  kind: 'message',
                  content: 'Sure, happy to help!',
                  createdAt: new Date().toISOString(),
                },
              }),
              { status: 200 },
            ),
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
