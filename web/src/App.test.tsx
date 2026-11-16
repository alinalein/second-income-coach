import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { App } from './App';
import { ThemeProvider } from './theme/theme-provider';

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}

function mockFetch(responses: Record<string, Response | Promise<Response>>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    return Promise.resolve(responses[match]);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// I/O matrix: "Unauthenticated API call" -> treated as "signed out" by the
// frontend, not an error; AC: unauthenticated view shows the sign-in card.
describe('App (AC: authenticated view renders)', () => {
  it('shows the sign-in card when GET /api/auth/session returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': new Response(null, { status: 401 }),
        '/api/health': new Response(JSON.stringify({ status: 'ok', service: 'api', timestamp: new Date().toISOString() }), {
          status: 200,
        }),
      }),
    );

    renderApp();

    expect(await screen.findByRole('heading', { name: /sign in to second income coach/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
  });

  // AC: "authenticated view renders" — a successful session response shows
  // the authenticated shell (sign-out control, chat UI) instead of the
  // sign-in card. Story 1.3 replaced the placeholder card with `ChatThread`
  // (Code Map); `web/src/chat/ChatThread.test.tsx` covers that component's
  // own behavior in detail.
  it('shows the authenticated shell, sign-out control, and chat UI when GET /api/auth/session returns a user', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': new Response(
          JSON.stringify({ user: { id: 'u1', email: 'a@example.com', name: 'Ada Lovelace', picture: null } }),
          { status: 200 },
        ),
        '/api/chat/messages': new Response(JSON.stringify({ messages: [] }), { status: 200 }),
        '/api/settings': new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [] }),
          { status: 200 },
        ),
      }),
    );

    renderApp();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  // Design Notes: "Callback failure" — a neutral, detail-free error is shown
  // once, and the `auth_error` flag is stripped from the URL (I/O matrix:
  // "Google OAuth failure/denial" -> "No stack trace or secret leaked").
  it('shows a neutral error and strips ?auth_error=1 from the URL on a failed sign-in', async () => {
    window.history.replaceState({}, '', '/?auth_error=1');
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': new Response(null, { status: 401 }),
        '/api/health': new Response(JSON.stringify({ status: 'ok', service: 'api', timestamp: new Date().toISOString() }), {
          status: 200,
        }),
      }),
    );

    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in didn't go through/i);
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});
