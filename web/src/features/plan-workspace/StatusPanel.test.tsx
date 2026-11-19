import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CurrentStepResponse } from '@app/shared';
import { StatusPanel } from './StatusPanel';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

type PlanStep = NonNullable<CurrentStepResponse['current']>;

function fakeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'step-1',
    stepOrder: 0,
    title: 'Current title',
    description: ['Current description'],
    dayOffset: 0,
    status: 'current',
    startedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// AC: "only the current and immediate-next step are visible —
// `get_current_step` is the sole path enforcing this." `StatusPanel` is the
// one UI surface that reads `GET /api/plans/:planId/current-step`; this
// confirms the current step's own content lands in the "current" region and
// the next step's title lands under the locked "Next" region, never mixed
// up or showing more than these two.
describe('StatusPanel (AC: only current+next step visible)', () => {
  it('renders the current step and the locked next step from the current-step response', async () => {
    const body: CurrentStepResponse = {
      current: fakeStep({ title: 'List your first item', description: ['Take one photo.', 'Write a caption.'] }),
      next: {
        id: 'step-2',
        stepOrder: 1,
        title: 'List a second item',
        description: ['Repeat.'],
        dayOffset: 2,
        status: 'pending',
        startedAt: null,
      },
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    // UI fix (user-reported): "it should not say 'your plan', it should say
    // 'your plan for <idea>'" — the idea's own title, not a bare generic
    // heading.
    expect(await screen.findByText('Your plan for Resell thrifted clothing')).toBeInTheDocument();
    // UX fix (user-requested): "Step N" and the title share one row now —
    // same element, same styling.
    expect(screen.getByText('Step 1 — List your first item')).toBeInTheDocument();
    // UI fix (user-reported): each description action is its own bullet
    // item, not one joined paragraph.
    expect(screen.getByText('Take one photo.')).toBeInTheDocument();
    expect(screen.getByText('Write a caption.')).toBeInTheDocument();

    // Spec 2.12 AC7: the day label sits above the step's own title, not
    // below the description.
    const dayLabel = screen.getByText('Day 0');
    const title = screen.getByText('Step 1 — List your first item');
    expect(dayLabel.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Spec 2.12 AC7: "Next (locked)" is renamed "Next step".
    const nextRegion = screen.getByText('Next step').closest('div')!;
    expect(nextRegion).toHaveTextContent('List a second item');
    // Bug fix (user-reported): the next step's own description now renders
    // here too (previously shown only on the projection card, duplicating
    // it there) — still only current+next steps are ever exposed at all.
    expect(screen.getByText('Repeat.')).toBeInTheDocument();
  });

  // Bug fix (user-reported): the next step's own full description was
  // shown — it must be a short preview (word-boundary-truncated, ending in
  // an ellipsis), never the complete text.
  it('shows a truncated preview (not the full text) of a long next-step description', async () => {
    const body: CurrentStepResponse = {
      current: fakeStep(),
      next: {
        id: 'step-2',
        stepOrder: 1,
        title: 'List a second item',
        description: ['This is a very long description that definitely exceeds the sixty character cutoff for sure.'],
        dayOffset: 2,
        status: 'pending',
        startedAt: null,
      },
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    vi.stubGlobal('fetch', mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }));

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    expect(await screen.findByText('This is a very long description that definitely exceeds the…')).toBeInTheDocument();
    expect(screen.queryByText(/sixty character cutoff for sure/)).not.toBeInTheDocument();
  });

  it('renders no next region when the current step is the plan\'s last one', async () => {
    const body: CurrentStepResponse = {
      current: fakeStep({ title: 'Last step' }),
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    expect(await screen.findByText('Step 1 — Last step')).toBeInTheDocument();
    expect(screen.queryByText('Next step')).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, live), item 2 (amended, later round): "the
// projection card refetches ... after Mark as done" — only a real
// `complete()` changes the completed-step count the projection is computed
// from, so only that action notifies `onPlanActivityChanged` (in addition
// to this panel's own refetch). `start()` used to notify it too (the
// original AC's own wording), which visibly flickered/remounted
// `ProjectionCard` for an action that never changes anything it shows —
// confirmed live, this is the bug-fix amendment, not the original AC.
describe('StatusPanel (bug fix, live: only Complete notifies onPlanActivityChanged, never Start)', () => {
  it.each([
    [
      'Start this step',
      '/api/plans/plan-1/steps/step-1/start',
      JSON.stringify({ step: { ...fakeStep(), startedAt: new Date().toISOString() } }),
      0,
    ],
    [
      'Mark as done',
      '/api/plans/plan-1/steps/step-1/complete',
      JSON.stringify({ step: { ...fakeStep(), status: 'completed' }, planCompleted: false }),
      1,
    ],
  ] as const)('clicking "%s" calls onPlanActivityChanged %i time(s) once it succeeds', async (buttonLabel, actionPath, actionResponseBody, expectedCalls) => {
    const body: CurrentStepResponse = { current: fakeStep(), next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const onPlanActivityChanged = vi.fn();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }),
        [actionPath]: () => new Response(actionResponseBody, { status: 200 }),
      }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" onPlanActivityChanged={onPlanActivityChanged} />);

    const button = await screen.findByRole('button', { name: buttonLabel });
    fireEvent.click(button);

    // `phase` returning to idle (the button re-enabling) only happens after
    // every synchronous statement in the action's own `.then()` callback has
    // run — including the `onStepChanged`/`onStepCompleted` calls the
    // assertion below cares about — so waiting on it rules out a race
    // without depending on the mock's own (unrelated to this fix) refetch
    // response shape.
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(onPlanActivityChanged).toHaveBeenCalledTimes(expectedCalls);
  });
});

// Story 4.5 (AC1): a completed plan's workspace shows a "Plan completed"
// card (completion date, number of completed steps) instead of "No current
// step yet", and renders no Start/Mark-as-done controls (points/streaks/
// levels/badges are a non-goal, never built at all — nothing to assert a
// negative on).
describe('StatusPanel (Story 4.5 AC1: completed plan)', () => {
  it('shows the "Plan completed" card with the completion date and step count, and no Start/Mark-as-done buttons', async () => {
    const body: CurrentStepResponse = {
      current: null,
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: { completedAt: '2026-01-15T00:00:00.000Z', completedSteps: 4 },
    };
    vi.stubGlobal('fetch', mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }));

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="completed" />);

    expect(await screen.findByText('Plan completed')).toBeInTheDocument();
    expect(screen.getByText('Steps completed: 4')).toBeInTheDocument();
    expect(screen.queryByText('No current step yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start this step' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as done' })).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, live): a plan still awaiting human review/
// activation must not let its current step be started/completed early —
// the backend rejects it too (`PlanNotActiveError`), this is the UI mirror.
describe('StatusPanel (AC follow-up: Start/Mark-as-done disabled before the plan is active)', () => {
  it('disables both buttons while planStatus is "draft"', async () => {
    const body: CurrentStepResponse = { current: fakeStep(), next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    vi.stubGlobal('fetch', mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }));

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="draft" />);

    expect(await screen.findByRole('button', { name: 'Start this step' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as done' })).toBeDisabled();
  });
});

// Bug fix (user-reported, live): "this should not happen — how am I
// supposed to fix any dev server, or any user that uses the app?" — a
// transient failure (the common real-world case: a cold start, a backend
// restart, a brief network blip) must never be a dead end with no way
// forward. Real timers (not faked) — the retry delays are short enough
// (1s, 2s) that this stays fast without the fake-timer/testing-library
// interaction pitfalls that come with faking them.
describe('StatusPanel (bug fix, live: a transient load failure retries instead of a dead end)', () => {
  it('recovers silently after transient failures — the error is never shown at all', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        callCount += 1;
        if (callCount < 3) return Promise.resolve(new Response(null, { status: 502 }));
        const body: CurrentStepResponse = { current: fakeStep(), next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    expect(await screen.findByText('Step 1 — Current title', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your current step.")).not.toBeInTheDocument();
    expect(callCount).toBe(3);
  }, 10_000);

  it('shows a "Try again" button once the automatic retries are exhausted, and retries again on click', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 502 })));
    vi.stubGlobal('fetch', fetchMock);

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    const retryButton = await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(retryButton);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3));
  }, 10_000);
});
