import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ProjectionResponse } from '@app/shared';
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

/** `nextStepEstimate` drives the "next step brings you to ..." line now
 * (never the next step's own title) — `unlockedOpportunity` is derived
 * alongside it just to keep fixtures schema-realistic; `ProjectionCard`
 * itself no longer reads its `title`. */
function fakeProjection(nextStepEstimate: ProjectionResponse['nextStepEstimate'], overrides: Partial<ProjectionResponse> = {}): ProjectionResponse {
  return {
    estimate: { amountMinorUnits: 7100, currencyCode: 'EUR' },
    currency: 'EUR',
    progressRatio: 0.5,
    unlockedOpportunity: nextStepEstimate ? { title: 'Write a simple lesson outline', description: ['Draft 3 bullet points.'] } : null,
    nextStepEstimate,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Bug fix (user-reported, live, correction to an earlier message): never
// the next step's own title (duplicates `StatusPanel`'s own "Next" region)
// — the concrete value the next step unlocks instead, same money
// formatting/currency/locale/est.-badge rules as the main amount. Omitted
// when there is no next step (last step, completed plan, draft).
describe('ProjectionCard ("at this pace · next step brings you to ..." line)', () => {
  it('shows the next-step estimate, formatted the same way as the main amount, with its own est. badge', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/projection': () =>
          new Response(JSON.stringify(fakeProjection({ amountMinorUnits: 3140, currencyCode: 'EUR' })), { status: 200 }),
      }),
    );

    render(<ProjectionCard planId="plan-1" />);

    expect(await screen.findByText('~€71.00')).toBeInTheDocument();
    expect(await screen.findByText('At this pace · next step brings you to ~€31.40')).toBeInTheDocument();
    expect(screen.queryByText(/Write a simple lesson outline/)).not.toBeInTheDocument();
  });

  it('omits the line entirely when there is no next step (last step or a completed plan)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" />);

    expect(await screen.findByText('~€71.00')).toBeInTheDocument();
    expect(screen.queryByText(/at this pace/i)).not.toBeInTheDocument();
  });

  it('omits the line for a draft plan even when the server returns a next-step estimate', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/projection': () =>
          new Response(JSON.stringify(fakeProjection({ amountMinorUnits: 3140, currencyCode: 'EUR' })), { status: 200 }),
      }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="draft" />);

    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/at this pace/i)).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, small): a one-line explanation of what the
// number is, under the "Projection" title — never shown for the
// completed-plan framing, which already has its own "Result of your
// finished plan" line.
describe('ProjectionCard (bug fix, small: subtitle under the title)', () => {
  it('shows the subtitle for an ongoing projection, not for a completed one', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" />);

    expect(await screen.findByText('Estimated extra income per month at your current pace')).toBeInTheDocument();
  });

  it('omits the subtitle for a completed plan', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="completed" />);

    expect(await screen.findByText('Result')).toBeInTheDocument();
    expect(screen.queryByText('Estimated extra income per month at your current pace')).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, small): "a bare 0 must never stand alone" — a
// genuine zero estimate (active, but no step/check-in yet) gets an
// explanatory line; a `draft` (unconfirmed) plan shows "—" instead of
// "~€0.00" entirely, since nothing has even been confirmed yet.
describe('ProjectionCard (bug fix, small: zero estimate and draft placeholder)', () => {
  it('shows the zero-estimate hint under a genuine ~€0.00 (active, no progress yet)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/projection': () =>
          new Response(JSON.stringify(fakeProjection(null, { estimate: { amountMinorUnits: 0, currencyCode: 'EUR' } })), { status: 200 }),
      }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="active" />);

    expect(await screen.findByText('~€0.00')).toBeInTheDocument();
    expect(screen.getByText('Complete your first step to see your estimate grow.')).toBeInTheDocument();
  });

  it('shows "—" instead of an amount for a draft (unconfirmed) plan, with no zero-estimate hint', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/projection': () =>
          new Response(JSON.stringify(fakeProjection(null, { estimate: { amountMinorUnits: 0, currencyCode: 'EUR' } })), { status: 200 }),
      }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="draft" />);

    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/€0.00/)).not.toBeInTheDocument();
    expect(screen.queryByText('Complete your first step to see your estimate grow.')).not.toBeInTheDocument();
  });

  it('shows neither the hint nor "—" once there is genuine non-zero progress', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="active" />);

    expect(await screen.findByText('~€71.00')).toBeInTheDocument();
    expect(screen.queryByText('Complete your first step to see your estimate grow.')).not.toBeInTheDocument();
  });
});

// Story 4.5 (AC2): a completed plan's projection card shows the same final
// estimate (Story 4.4's own math, unchanged), labelled as the result of the
// finished plan rather than an ongoing projection.
describe('ProjectionCard (Story 4.5 AC2: completed-plan framing)', () => {
  it('relabels the card as a result instead of a projection when planStatus is "completed"', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/projection': () => new Response(JSON.stringify(fakeProjection(null)), { status: 200 }) }),
    );

    render(<ProjectionCard planId="plan-1" planStatus="completed" />);

    expect(await screen.findByText('Result')).toBeInTheDocument();
    expect(screen.getByText('~€71.00')).toBeInTheDocument();
    expect(screen.getByText('Result of your finished plan')).toBeInTheDocument();
    expect(screen.queryByText('Projection')).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, live): same fix as `StatusPanel.tsx`'s own
// `AUTO_RETRY_DELAYS_MS` — a transient failure must never be a dead end.
// Real timers (not faked) — short enough (1s, 2s) to stay fast.
describe('ProjectionCard (bug fix, live: a transient load failure retries instead of a dead end)', () => {
  it('recovers silently after transient failures, and shows "Try again" once retries are exhausted', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        callCount += 1;
        return Promise.resolve(new Response(null, { status: 502 }));
      }),
    );

    render(<ProjectionCard planId="plan-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument(), { timeout: 5000 });
    expect(callCount).toBe(3);
    expect(screen.queryByText('~€71.00')).not.toBeInTheDocument();
  }, 10_000);
});
