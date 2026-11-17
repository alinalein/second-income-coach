import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
    const currentStep: CurrentStepResponse = { current: null, next: null };
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(JSON.stringify(plan), { status: 200 }),
      '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(currentStep), { status: 200 }),
      '/api/plans/plan-1/messages': () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" onBack={() => undefined} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/plans/select/idea-1', expect.objectContaining({ method: 'POST' }));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/plans/plan-1/messages', expect.anything());
    });
  });

  it('shows a load-failure message and never calls ChatThread/StatusPanel endpoints when the select call fails', async () => {
    const fetchMock = mockFetch({
      '/api/plans/select/idea-1': () => new Response(null, { status: 502 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanWorkspace ideaId="idea-1" ideaTitle="Resell thrifted clothing" onBack={() => undefined} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/current-step'), expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/messages'), expect.anything());
  });
});
