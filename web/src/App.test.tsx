import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { App } from './App';
import { ThemeProvider } from './theme/theme-provider';
import intakeEn from './locales/en/intake.json';

function authSessionResponse() {
  return new Response(
    JSON.stringify({ user: { id: 'u1', email: 'a@example.com', name: 'Ada Lovelace', picture: null } }),
    { status: 200 },
  );
}

/**
 * `main.tsx` always renders the real app inside `<StrictMode>`, which
 * double-invokes effects on mount (mount -> cleanup -> mount again) in dev.
 * Rendering without it here would miss exactly that class of bug (a mount-ref
 * guard that never resets after the first synthetic cleanup, silently
 * swallowing every later state update) — matching production's actual
 * rendering mode, not just a convenient test default.
 */
function renderApp() {
  return render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}

function existingIntakeRecord() {
  const now = new Date().toISOString();
  return {
    id: 'intake-1',
    skillsInterests: 'Woodworking',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed.',
    failurePattern: 'overwhelm',
    createdAt: now,
    updatedAt: now,
  };
}

/** `entry` may be a factory (same convention as `chat/ChatThread.test.tsx`'s
 * own `mockFetch`) — needed wherever a URL is fetched more than once in a
 * single test (e.g. `/api/intake`, read once by `App`'s own gate check and
 * again by `IntakeForm` on mount), since a `Response` body can only be
 * consumed once. */
function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    // `SettingsPage` and `useAppliedUiLanguage` both fetch `/api/settings` —
    // clone so each caller gets its own readable body.
    return Promise.resolve(typeof entry === 'function' ? entry() : entry.clone());
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
  // own behavior in detail. Story 2.1: now gated behind an existing intake
  // row (see the "intake" describe block below for the no-intake branch).
  it('shows the authenticated shell, sign-out control, and chat UI when GET /api/auth/session returns a user with an existing intake row', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': new Response(
          JSON.stringify({ user: { id: 'u1', email: 'a@example.com', name: 'Ada Lovelace', picture: null } }),
          { status: 200 },
        ),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/chat/messages': new Response(JSON.stringify({ messages: [] }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/settings': new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
          { status: 200 },
        ),
      }),
    );

    renderApp();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: /message/i })).toBeInTheDocument();
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

// Story 2.1 (AC1/AC5): the intake form gates chat for a signed-in user with
// no saved intake, and a revisit link lets a user with one come back to it.
describe('App (Story 2.1: intake gates chat)', () => {
  it('shows the blank intake form for a user with no intake row, and shows chat after a successful submission', async () => {
    let postedBody: unknown;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) return Promise.resolve(authSessionResponse());
        if (url.includes('/api/intake')) {
          if (init?.method === 'POST') {
            postedBody = JSON.parse(String(init.body));
            return Promise.resolve(new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ intake: null }), { status: 200 }));
        }
        if (url.includes('/api/chat/messages')) {
          return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
        }
        if (url.includes('/api/ideas')) {
          return Promise.resolve(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }));
        }
        if (url.includes('/api/settings')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
              { status: 200 },
            ),
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    renderApp();

    fireEvent.change(await screen.findByLabelText(intakeEn.skillsInterests.label), {
      target: { value: 'Woodworking' },
    });
    fireEvent.change(screen.getByLabelText(intakeEn.stoppedBeforeText.label), {
      target: { value: 'I got overwhelmed.' },
    });
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));

    expect(await screen.findByRole('textbox', { name: /message/i })).toBeInTheDocument();
    expect(postedBody).toMatchObject({ skillsInterests: 'Woodworking', stoppedBeforeText: 'I got overwhelmed.' });
  });

  it('shows chat with a revisit link when intake already exists, and revisiting shows the prefilled form', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/chat/messages': new Response(JSON.stringify({ messages: [] }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/settings': new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
          { status: 200 },
        ),
      }),
    );

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: intakeEn.revisitLink }));

    expect(await screen.findByDisplayValue('Woodworking')).toBeInTheDocument();
  });
});
