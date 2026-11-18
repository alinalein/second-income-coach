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

function fakeIdeaFixture() {
  const now = new Date().toISOString();
  return {
    id: 'idea-1',
    status: 'suggested',
    title: 'Freelance tutoring',
    rationale: 'Fits the time you have free each week.\nStart by listing one lesson type online.',
    citedIntakeFields: ['weeklyTimeAvailability', 'startingBudgetRange', 'riskTolerance'],
    ideaType: 'service',
    weeklyTimeCommitment: '5_to_10h',
    startupCost: { amountMinorUnits: 2500, currencyCode: 'EUR' },
    riskLevel: 'low',
    baselineRateLow: { amountMinorUnits: 3000, currencyCode: 'USD' },
    baselineRateHigh: { amountMinorUnits: 3000, currencyCode: 'USD' },
    isVendorSource: false,
    rateUnit: 'hour',
    baselineRateCitation: 'https://example.com/rates',
    baselineRateQuote: 'Workers in this field earn $30.00 an hour on average.',
    sourceTrustTier: 'tier_3',
    isRateUnverified: false,
    demandEvidenceNote: null,
    demandEvidenceCitation: null,
    demandEvidenceQuote: null,
    isDemandEvidenceUnverified: false,
    growthPath: null,
    language: 'en',
    createdAt: now,
    updatedAt: now,
    hasPlan: false,
  };
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
    country: 'DE',
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
  // the authenticated shell (sign-out control, ideas panel) instead of the
  // sign-in card. Story 2.1: now gated behind an existing intake row (see
  // the "intake" describe block below for the no-intake branch). Story 2.8
  // (guided-flow fix, user-reported): the discovery `ChatThread` no longer
  // renders on this screen — it belongs once the user starts working on a
  // chosen idea (`PlanWorkspace`'s own plan-thread chat), not while ideas
  // are still being generated or picked from.
  it('shows the authenticated shell, sign-out control, and ideas panel when GET /api/auth/session returns a user with an existing intake row', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': new Response(
          JSON.stringify({ user: { id: 'u1', email: 'a@example.com', name: 'Ada Lovelace', picture: null } }),
          { status: 200 },
        ),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/plans': () => new Response(JSON.stringify({ plans: [] }), { status: 200 }),
        '/api/settings': new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
          { status: 200 },
        ),
      }),
    );

    renderApp();

    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /your tailored income ideas/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
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

// Story 2.1 (AC1/AC5): the intake form gates the ideas panel for a signed-in
// user with no saved intake, and a revisit link lets a user with one come
// back to it.
describe('App (Story 2.1: intake gates the ideas panel)', () => {
  it('shows the blank intake form for a user with no intake row, and shows the ideas panel after a successful submission', async () => {
    let postedBody: unknown;
    const generateFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 })));

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
        // Story 2.8 AC1: the first-ever intake submit auto-fires
        // `POST /api/ideas/generate` with no extra click — `GET /api/ideas`
        // (checked first below, via the `init?.method` guard) must still
        // report zero ideas so `IdeasPanel` is idle+empty when its
        // auto-generate effect runs.
        if (url.includes('/api/ideas/generate')) return generateFetch();
        if (url.includes('/api/ideas')) {
          return Promise.resolve(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }));
        }
        if (url.includes('/api/plans')) {
          return Promise.resolve(new Response(JSON.stringify({ plans: [] }), { status: 200 }));
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

    expect(await screen.findByRole('heading', { name: /your tailored income ideas/i })).toBeInTheDocument();
    expect(postedBody).toMatchObject({ skillsInterests: 'Woodworking', stoppedBeforeText: 'I got overwhelmed.' });
    // The only assertion this story's AC1 needs at the App level: generation
    // started with no extra click — `IdeasPanel.test.tsx` covers the
    // fire-once guard and the manual-trigger paths in detail.
    await waitFor(() => expect(generateFetch).toHaveBeenCalledOnce());
  });

  it('shows a revisit link when intake already exists, and revisiting shows the prefilled form', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/plans': () => new Response(JSON.stringify({ plans: [] }), { status: 200 }),
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

// Spec 2.12 AC1 (amended 2026-11-18, epics.md): the continuous save -> ideas
// redirect + auto-generation applies ONLY to a user's first-ever intake save
// (no intake stored yet). Editing an already-existing intake via "Review
// your intake answers" only saves (with a short confirmation), stays put,
// and never redirects or generates. One table-driven test, two rows.
describe('App (Spec 2.12 AC1 amendment: redirect/auto-generate only on first-ever intake save)', () => {
  it.each([
    ['no intake yet -> redirects to ideas and starts generation', null, true],
    ['intake already exists -> saves only, no redirect, no generate call', existingIntakeRecord(), false],
  ])('%s', async (_name, initialIntake, expectRedirect) => {
    const generateFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 })));

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/session')) return Promise.resolve(authSessionResponse());
        if (url.includes('/api/intake')) {
          if (init?.method === 'POST') {
            return Promise.resolve(new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ intake: initialIntake }), { status: 200 }));
        }
        if (url.includes('/api/ideas/generate')) return generateFetch();
        if (url.includes('/api/ideas')) return Promise.resolve(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }));
        if (url.includes('/api/plans')) return Promise.resolve(new Response(JSON.stringify({ plans: [] }), { status: 200 }));
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

    if (initialIntake) {
      fireEvent.click(await screen.findByRole('button', { name: intakeEn.revisitLink }));
      await screen.findByDisplayValue('Woodworking');
    } else {
      await screen.findByLabelText(intakeEn.skillsInterests.label);
    }
    fireEvent.change(screen.getByLabelText(intakeEn.skillsInterests.label), { target: { value: 'Woodworking' } });
    fireEvent.change(screen.getByLabelText(intakeEn.stoppedBeforeText.label), { target: { value: 'I got overwhelmed.' } });
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));

    if (expectRedirect) {
      expect(await screen.findByRole('heading', { name: /your tailored income ideas/i })).toBeInTheDocument();
      await waitFor(() => expect(generateFetch).toHaveBeenCalledOnce());
    } else {
      expect(await screen.findByText(intakeEn.savedConfirmation)).toBeInTheDocument();
      expect(screen.getByLabelText(intakeEn.skillsInterests.label)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /your tailored income ideas/i })).not.toBeInTheDocument();
      expect(generateFetch).not.toHaveBeenCalled();
    }
  });
});

// Story 2.9 (AC: "the active view/plan survives a reload — use the URL").
// A reload is simulated by setting the URL before the first render, same as
// a fresh browser navigation to that path would.
describe('App (Story 2.9: the active view/plan survives a reload)', () => {
  it('a direct load of /settings shows the Settings view, not the ideas list', async () => {
    window.history.replaceState({}, '', '/settings');
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/plans': () => new Response(JSON.stringify({ plans: [] }), { status: 200 }),
        '/api/settings': () =>
          new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
            { status: 200 },
          ),
      }),
    );

    renderApp();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /your tailored income ideas/i })).not.toBeInTheDocument();
  });

  it('a direct load of /plan/:ideaId shows that idea\'s plan workspace, resolving its title from the My-plans list', async () => {
    window.history.replaceState({}, '', '/plan/idea-1');
    const now = new Date().toISOString();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/select/idea-1': () =>
          new Response(JSON.stringify({ id: 'plan-1', ideaId: 'idea-1', status: 'active', threadId: 'plan:plan-1', createdAt: now, updatedAt: now }), {
            status: 200,
          }),
        '/current-step': () => new Response(JSON.stringify({ current: null, next: null }), { status: 200 }),
        '/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
        '/api/plans': () =>
          new Response(
            JSON.stringify({ plans: [{ id: 'plan-1', ideaId: 'idea-1', ideaTitle: 'Resell thrifted items', status: 'active', updatedAt: now }] }),
            { status: 200 },
          ),
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/settings': () =>
          new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
            { status: 200 },
          ),
      }),
    );

    renderApp();

    expect(await screen.findByRole('heading', { name: 'Your plan for Resell thrifted items' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /your tailored income ideas/i })).not.toBeInTheDocument();
  });

  // UX fix (user-reported, live): a Bookmarked sidebar entry's own
  // single-idea view is a real route too, same reload guarantee.
  it('a direct load of /bookmarked/:ideaId shows only that one idea\'s card', async () => {
    window.history.replaceState({}, '', '/bookmarked/idea-2');
    const bookmarked = { id: 'idea-2', title: 'Only this one' };
    const other = { id: 'idea-1', title: 'A different idea' };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/plans': () => new Response(JSON.stringify({ plans: [] }), { status: 200 }),
        '/api/settings': () =>
          new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
            { status: 200 },
          ),
        '/api/ideas': () =>
          new Response(
            JSON.stringify({
              ideas: [
                { ...fakeIdeaFixture(), ...other, status: 'suggested' },
                { ...fakeIdeaFixture(), ...bookmarked, status: 'bookmarked' },
              ],
              currency: 'EUR',
            }),
            { status: 200 },
          ),
      }),
    );

    renderApp();

    expect(await screen.findByText('Only this one')).toBeInTheDocument();
    expect(screen.queryByText('A different idea')).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, live): opening "Review your intake answers" from
// the sidebar sets a flag that rendered *above* the routed view — nothing
// reset it on a later sidebar click, so every other sidebar button looked
// unresponsive (clicking one updated the route underneath, but the intake
// form kept covering it) once that flag was set.
describe('App (bug fix: a sidebar click always leaves intake-review mode)', () => {
  it('clicking "New ideas" after opening "Review your intake answers" shows the ideas view, not the stuck intake form', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/auth/session': authSessionResponse(),
        '/api/intake': () => new Response(JSON.stringify({ intake: existingIntakeRecord() }), { status: 200 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
        '/api/plans': () => new Response(JSON.stringify({ plans: [] }), { status: 200 }),
        '/api/settings': () =>
          new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English' }),
            { status: 200 },
          ),
      }),
    );

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Review your intake answers' }));
    expect(await screen.findByDisplayValue('Woodworking')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New ideas' }));

    expect(await screen.findByRole('heading', { name: /your tailored income ideas/i })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Woodworking')).not.toBeInTheDocument();
  });
});
