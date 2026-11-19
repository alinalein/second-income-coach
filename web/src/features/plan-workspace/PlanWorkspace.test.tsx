import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { PlanResponse, CurrentStepResponse, ProjectionResponse } from '@app/shared';
import { PlanWorkspace } from './PlanWorkspace';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

function fakePlan(overrides: Partial<PlanResponse> = {}): PlanResponse {
  const now = new Date().toISOString();
  return { id: 'plan-1', ideaId: 'idea-1', status: 'draft', threadId: 'plan:plan-1', createdAt: now, updatedAt: now, ...overrides };
}

// Story 4.4: `ProjectionCard` now fills the sidebar's projection extension
// point too, fetching this endpoint on mount alongside `StatusPanel`'s own
// `current-step` read — mocked here so these pre-existing (Story 3.1)
// tests keep passing unchanged.
function fakeProjection(): ProjectionResponse {
  return { estimate: { amountMinorUnits: 0, currencyCode: 'EUR' }, currency: 'EUR', progressRatio: 0, unlockedOpportunity: null, nextStepEstimate: null };
}

// Story 4.1 (AC, follow-up): `EnergyCheckInPopup` now also fetches this on
// mount — `answeredToday: true` here so these pre-existing (Story 3.1/4.4)
// tests never see the pop-up open and don't need to account for it.
const CHECK_IN_STATUS_ANSWERED = { '/api/plans/check-in-status': () => new Response(JSON.stringify({ answeredToday: true }), { status: 200 }) };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// Code Map: "`PlanWorkspace` fetched via `POST /api/plans/select/:ideaId`
// ... points `ChatThread` at `/api/plans/:planId/messages`". Confirms the
// lazily-created plan's own id flows all the way into the chat column's
// endpoint, not a hardcoded or discovery-thread path.
describe('PlanWorkspace (AC: lazy create-or-fetch wires ChatThread to the plan thread)', () => {
  it('fetches the plan via POST /api/plans/select/:ideaId and points ChatThread at /api/plans/:planId/messages', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
      ...CHECK_IN_STATUS_ANSWERED,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/plans/select/idea-1', expect.objectContaining({ method: 'POST' }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/plans/plan-1/messages', expect.anything());
    });
  });

  // Live-bug fix (user-reported, measured live: two real POST /select calls,
  // 11.2s and 10.3s): `main.tsx` always renders the real app inside
  // `<StrictMode>` (same precedent as `App.test.tsx`'s own `renderApp`),
  // which double-invokes effects on mount in dev. The lazy `create_plan`
  // call behind this fetch is not idempotent on its own model-call cost, so
  // a plain `let cancelled` guard (which doesn't survive the synthetic
  // cleanup+re-setup) let both invocations fire a real network request.
  it('calls POST /api/plans/select/:ideaId exactly once under StrictMode synthetic double-effect', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
      ...CHECK_IN_STATUS_ANSWERED,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/plans/plan-1/messages', expect.anything());
    });
    const selectCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/plans/select/'));
    expect(selectCalls).toHaveLength(1);
  });

  it('shows a load-failure message and never calls ChatThread/StatusPanel endpoints when the select call fails', async () => {
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(null, { status: 502 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/current-step'), expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/messages'), expect.anything());
  });

  // Bug fix (user-reported, live): the sidebar's "My plans" refresh (keyed
  // off `App.tsx`'s `plansRefreshKey`) fired the moment navigation into this
  // workspace *started* — before this component's own lazy
  // `POST /select/:ideaId` below had actually created the plan, so a
  // brand-new plan never showed up there. `onPlanLoaded` lets the caller
  // re-trigger that same refresh once the plan data is actually ready.
  it('calls onPlanLoaded with the resolved plan once POST /select/:ideaId succeeds', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
      ...CHECK_IN_STATUS_ANSWERED,
    });
    vi.stubGlobal('fetch', fetchMock);
    const onPlanLoaded = vi.fn();

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" onPlanLoaded={onPlanLoaded} />);

    await waitFor(() => {
      expect(onPlanLoaded).toHaveBeenCalledWith(plan);
    });
  });
});

// Bug fix (user-reported, live): completing the plan's final step via
// "Mark as done" left this component's own cached `plan.status` at `active`
// until a full reload — the projection card kept its ongoing framing, the
// sidebar kept showing "Active" (nothing re-fetched `/api/plans`), and the
// completion chat message only appeared after that reload. All three must
// now update live, from this one click.
describe('PlanWorkspace (bug fix, live: completing the final step updates everything live, no reload)', () => {
  it('shows the completion message in chat and relabels the projection card the instant the final step completes', async () => {
    const plan = fakePlan({ status: 'active' });
    const step = {
      id: 'step-1',
      stepOrder: 0,
      title: 'Only step',
      description: ['Do it.'],
      dayOffset: 0,
      status: 'current' as const,
      startedAt: null,
    };
    const currentStep: CurrentStepResponse = {
      current: step,
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    const onPlanLoaded = vi.fn();
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/steps/step-1/complete': () =>
        new Response(
          JSON.stringify({
            step: { ...step, status: 'completed' },
            planCompleted: true,
            chatMessage: { id: 'msg-1', role: 'assistant', kind: 'message', content: 'You finished the whole plan — nice work! 🎉', createdAt: new Date().toISOString() },
          }),
          { status: 200 },
        ),
      ...CHECK_IN_STATUS_ANSWERED,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" onPlanLoaded={onPlanLoaded} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as done' }));

    expect(await screen.findByText('You finished the whole plan — nice work! 🎉')).toBeInTheDocument();
    expect(await screen.findByText('Result')).toBeInTheDocument();
    await waitFor(() => expect(onPlanLoaded).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' })));
  });
});

// Story 4.5 (AC1): the energy pop-up is not shown for a completed plan —
// there's nothing left to check in about.
describe('PlanWorkspace (Story 4.5 AC1: energy pop-up suppressed for a completed plan)', () => {
  it('never fetches check-in-status (never mounts the pop-up) when the plan is completed', async () => {
    const plan = fakePlan({ status: 'completed' });
    const currentStep: CurrentStepResponse = {
      current: null,
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: { completedAt: new Date().toISOString(), completedSteps: 3 },
    };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      ...CHECK_IN_STATUS_ANSWERED,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    expect(await screen.findByText('Plan completed')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/plans/check-in-status'))).toBe(false);
  });
});

// Spec 2.12 AC2: the old indeterminate spinner is replaced by the same
// determinate-bar/stage-text pattern idea generation uses — visible from
// first paint while `create_plan` is in flight, forced to 100% the instant
// the request settles, right before the plan itself replaces this view.
describe('PlanWorkspace (Spec 2.12 AC2: determinate bar while the plan is created)', () => {
  it('shows a determinate progress bar at 0% while select is in flight, then reveals the plan', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    let resolveSelect!: (value: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/plans/select/idea-1')) {
        return new Promise<Response>((resolve) => {
          resolveSelect = resolve;
        });
      }
      const match = [
        ['/api/plans/plan-1/current-step', currentStep],
        ['/api/plans/plan-1/messages', { messages: [] }],
        ['/api/plans/plan-1/activate', { review: null }],
        ['/api/plans/check-in-status', { answeredToday: true }],
        ['/api/plans/plan-1/projection', fakeProjection()],
      ].find(([key]) => url.includes(key as string));
      if (!match) throw new Error(`Unmocked fetch: ${url}`);
      return Promise.resolve(new Response(JSON.stringify(match[1]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    // Bug fix (user-reported, live): the modal itself now only appears
    // after `LOADING_MODAL_DELAY_MS` (a fast, already-existing-plan fetch
    // never shows it at all) — by the time it does, for a genuinely slow
    // request like this one, a little real progress may already have
    // ticked. The bar still starting low and *not yet finished* (not
    // already at 100%) is what this AC is actually about.
    const statusRegion = await screen.findByRole('status');
    const progressBar = within(statusRegion).getByRole('progressbar');
    expect(Number(progressBar.getAttribute('aria-valuenow'))).toBeLessThan(100);

    resolveSelect(new Response(JSON.stringify(plan), { status: 200 }));

    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(await screen.findByText('Your plan for Resell thrifted clothing')).toBeInTheDocument();
  });
});

// Bug fix (user-reported, live): "switching between plans flashes the
// 'creating your plan' progress bar for a split second — I want a smooth
// transition, not that modal popping in between." `POST /select/:ideaId`
// resolves near-instantly for an already-existing plan (the common case
// when switching, unlike selecting a brand-new idea) — the modal must
// never appear at all for that case, not even briefly.
describe('PlanWorkspace (bug fix, live: a fast plan switch never flashes the loading modal)', () => {
  it('never shows the loading modal when select resolves within the delay window', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Resolves on the microtask queue — real timers win every race
      // against it (microtasks always run before the next macrotask), so
      // this is deterministic under any machine load, unlike an artificial
      // real-timer delay would be. Simulates the common "already exists"
      // case, not a genuine first-time creation.
      if (url.includes('/api/plans/select/idea-1')) return Promise.resolve(new Response(JSON.stringify(plan), { status: 200 }));
      const match = [
        ['/api/plans/plan-1/current-step', currentStep],
        ['/api/plans/plan-1/messages', { messages: [] }],
        ['/api/plans/plan-1/activate', { review: null }],
        ['/api/plans/check-in-status', { answeredToday: true }],
        ['/api/plans/plan-1/projection', fakeProjection()],
      ].find(([key]) => url.includes(key as string));
      if (!match) throw new Error(`Unmocked fetch: ${url}`);
      return Promise.resolve(new Response(JSON.stringify(match[1]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    expect(await screen.findByText('Your plan for Resell thrifted clothing')).toBeInTheDocument();
    // Scoped to *this* loading modal by its own accessible name, not a bare
    // `queryByRole('dialog')` — `fakePlan()`'s default `status: 'draft'`
    // means `PlanActivationPanel`'s own (separate, legitimately-shown)
    // "Loading your plan for review…" dialog is on screen at this point
    // too, by design (bug fix, live, later round: it now starts in its own
    // loading phase immediately, never a flash of the plain idle card).
    expect(screen.queryByRole('dialog', { name: 'Setting up your plan…' })).not.toBeInTheDocument();
    expect(screen.queryByText('Setting up your plan…')).not.toBeInTheDocument();
  });
});

// Spec 2.12 AC6: the status column opts out of the row's own `items-stretch`
// (keeps its natural height) while the chat column does not (stretches to
// the row's full height, which — once `FadeIn`/`<main>` pass through a real
// viewport-bounded height above this component — reaches the viewport's own
// bottom edge). Asserted at the class level: jsdom has no real layout
// engine, so the actual rendered pixel height can't be asserted here.
describe('PlanWorkspace (Spec 2.12 AC6: chat column fills height, status column keeps its own)', () => {
  it('applies sm:self-start to the status column only, not the chat column', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, completedSteps: [], gapDetected: false, missedDays: 0, checkedInToday: false, completion: null };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
      ...CHECK_IN_STATUS_ANSWERED,
      '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection()), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    const statusHeading = await screen.findByText('Your plan for Resell thrifted clothing');
    const statusColumn = statusHeading.closest('.sm\\:w-64')!;
    expect(statusColumn.className).toContain('sm:self-start');

    const chatColumn = statusColumn.nextElementSibling as HTMLElement;
    expect(chatColumn.className).not.toContain('self-start');
    expect(chatColumn.className).toContain('flex-1');
  });
});

// Bug fix (user-reported, live): "I asked the AI to change the plan
// [during review], then approved, then wanted to start the first item —
// but the first (and later) items weren't updated accordingly." Root cause:
// `StatusPanel` fetches `current-step` once on mount and never refetches on
// its own; editing/regenerating the draft during review deletes and
// reinserts `plan_steps` under new row ids, but `StatusPanel` had already
// fetched the *original* draft's steps before the review ever opened.
// Confirming then left it showing stale step data — clicking Start sent a
// step id the server no longer recognized as current (409).
describe('PlanWorkspace (bug fix, live: confirming activation refreshes the status panel with the final steps)', () => {
  it('shows the post-regenerate step, not the original draft\'s, once the plan is confirmed', async () => {
    const draftPlan = fakePlan({ status: 'draft' });
    const activePlan = fakePlan({ status: 'active' });
    const originalStep: CurrentStepResponse = {
      current: { id: 'step-original', stepOrder: 0, title: 'Original first step', description: ['Do the old thing.'], dayOffset: 0, status: 'current', startedAt: null },
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    const regeneratedStep: CurrentStepResponse = {
      current: { id: 'step-regenerated', stepOrder: 0, title: 'Regenerated first step', description: ['Do the new thing.'], dayOffset: 0, status: 'current', startedAt: null },
      next: null,
      completedSteps: [],
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
      completion: null,
    };
    // Deliberately a *different* literal string from `regeneratedStep`'s own
    // title below — this is what the review modal shows while reviewing,
    // never what `StatusPanel` is being asserted on, so the two can't be
    // confused with each other in the assertions below.
    const review = { plan: draftPlan, steps: [{ id: 'step-regenerated', stepOrder: 0, title: 'Regenerated review step', description: ['Do the new thing.'], dayOffset: 0, status: 'current' as const, startedAt: null }] };

    let currentStepCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.includes('/api/plans/select/idea-1')) return Promise.resolve(new Response(JSON.stringify(draftPlan), { status: 200 }));
      if (url.includes('/current-step')) {
        currentStepCalls += 1;
        const body = currentStepCalls === 1 ? originalStep : regeneratedStep;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      if (url.includes('/projection')) return Promise.resolve(new Response(JSON.stringify(fakeProjection()), { status: 200 }));
      if (url.includes('/messages')) return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      if (url.includes('/activate/confirm')) return Promise.resolve(new Response(JSON.stringify(activePlan), { status: 200 }));
      if (url.endsWith('/activate') && method === 'POST') return Promise.resolve(new Response(JSON.stringify(review), { status: 200 }));
      if (url.endsWith('/activate') && method === 'GET') return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
      if (url.includes('/check-in-status')) return Promise.resolve(new Response(JSON.stringify({ answeredToday: true }), { status: 200 }));
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    // The review auto-opens (Story 4.5 live fix) showing the regenerated
    // draft's own step — `StatusPanel`, mounted underneath it, still shows
    // the *original* step it fetched before the review ever ran.
    // UX fix (user-requested): `StatusPanel` now shares "Step N" and the
    // title on one row/element.
    expect(await screen.findByText('Step 1 — Original first step')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Regenerated review step/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm & activate' }));

    // Bug fix: `StatusPanel` must refetch and show the real, final step —
    // never stay stuck on the one it fetched before the review ran.
    expect(await screen.findByText('Step 1 — Regenerated first step')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Step 1 — Original first step')).not.toBeInTheDocument());
    expect(currentStepCalls).toBe(2);
  });
});
