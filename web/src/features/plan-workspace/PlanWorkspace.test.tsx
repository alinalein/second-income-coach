import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import type { PlanResponse, CurrentStepResponse } from '@app/shared';
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

function fakePlan(): PlanResponse {
  const now = new Date().toISOString();
  return { id: 'plan-1', ideaId: 'idea-1', status: 'draft', threadId: 'plan:plan-1', createdAt: now, updatedAt: now };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Code Map: "`PlanWorkspace` fetched via `POST /api/plans/select/:ideaId`
// ... points `ChatThread` at `/api/plans/:planId/messages`". Confirms the
// lazily-created plan's own id flows all the way into the chat column's
// endpoint, not a hardcoded or discovery-thread path.
describe('PlanWorkspace (AC: lazy create-or-fetch wires ChatThread to the plan thread)', () => {
  it('fetches the plan via POST /api/plans/select/:ideaId and points ChatThread at /api/plans/:planId/messages', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
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
    const currentStep: CurrentStepResponse = { current: null, next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
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
});

// Spec 2.12 AC2: the old indeterminate spinner is replaced by the same
// determinate-bar/stage-text pattern idea generation uses — visible from
// first paint while `create_plan` is in flight, forced to 100% the instant
// the request settles, right before the plan itself replaces this view.
describe('PlanWorkspace (Spec 2.12 AC2: determinate bar while the plan is created)', () => {
  it('shows a determinate progress bar at 0% while select is in flight, then reveals the plan', async () => {
    const plan = fakePlan();
    const currentStep: CurrentStepResponse = { current: null, next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
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
      ].find(([key]) => url.includes(key as string));
      if (!match) throw new Error(`Unmocked fetch: ${url}`);
      return Promise.resolve(new Response(JSON.stringify(match[1]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" />);

    const statusRegion = await screen.findByRole('status');
    const progressBar = within(statusRegion).getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '0');

    resolveSelect(new Response(JSON.stringify(plan), { status: 200 }));

    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(await screen.findByText('Your plan for Resell thrifted clothing')).toBeInTheDocument();
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
    const currentStep: CurrentStepResponse = { current: null, next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      '/api/plans/plan-1/activate': () => new Response(JSON.stringify({ review: null }), { status: 200 }),
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
