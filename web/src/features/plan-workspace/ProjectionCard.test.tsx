import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ProjectionResponse, UnlockedOpportunity } from '@app/shared';
import { ProjectionCard } from './ProjectionCard';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

function fakeProjection(unlockedOpportunity: UnlockedOpportunity | null): ProjectionResponse {
  return { estimate: { amountMinorUnits: 7100, currencyCode: 'EUR' }, currency: 'EUR', progressRatio: 0.5, unlockedOpportunity };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Bug fix (user-reported): "at this pace · unlocks: <title>" is a required
// part of the card (epics.md Story 4.4 AC) — restored under the estimate.
// Only the next step's own title renders (never its description, which
// `StatusPanel`'s own "Next" region already shows in full) to keep the
// duplication feeling minimal; the line is omitted entirely when there is
// no next step.
describe('ProjectionCard ("at this pace · unlocks: ..." line)', () => {
  it('shows the next step\'s title only, never its description', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/projection': () =>
          new Response(
            JSON.stringify(fakeProjection({ title: 'Write a simple lesson outline', description: ['Draft 3 bullet points for the lesson.'] })),
            { status: 200 },
          ),
      }),
    );

    render(<ProjectionCard planId="plan-1" />);

    expect(await screen.findByText('~€71.00')).toBeInTheDocument();
    expect(await screen.findByText('at this pace · unlocks: Write a simple lesson outline')).toBeInTheDocument();
    expect(screen.queryByText(/Draft 3 bullet points/)).not.toBeInTheDocument();
  });

  it('omits the line entirely when there is no next step (last step or a completed plan)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" />);

    expect(await screen.findByText('~€71.00')).toBeInTheDocument();
    expect(screen.queryByText(/at this pace/)).not.toBeInTheDocument();
  });
});
