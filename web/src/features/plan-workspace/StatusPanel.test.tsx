import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" />);

    // UI fix (user-reported): "it should not say 'your plan', it should say
    // 'your plan for <idea>'" — the idea's own title, not a bare generic
    // heading.
    expect(await screen.findByText('Your plan for Resell thrifted clothing')).toBeInTheDocument();
    expect(screen.getByText('List your first item')).toBeInTheDocument();
    // UI fix (user-reported): each description action is its own bullet
    // item, not one joined paragraph.
    expect(screen.getByText('Take one photo.')).toBeInTheDocument();
    expect(screen.getByText('Write a caption.')).toBeInTheDocument();

    // Spec 2.12 AC7: the day label sits above the step's own title, not
    // below the description.
    const dayLabel = screen.getByText('Day 0');
    const title = screen.getByText('List your first item');
    expect(dayLabel.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Spec 2.12 AC7: "Next (locked)" is renamed "Next step".
    const nextRegion = screen.getByText('Next step').closest('div')!;
    expect(nextRegion).toHaveTextContent('List a second item');
    // The next step's own description never renders — only its title
    // (AC: "only ... immediate-next step are visible", not its full detail).
    expect(screen.queryByText('Repeat.')).not.toBeInTheDocument();
  });

  it('renders no next region when the current step is the plan\'s last one', async () => {
    const body: CurrentStepResponse = {
      current: fakeStep({ title: 'Last step' }),
      next: null,
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" />);

    expect(await screen.findByText('Last step')).toBeInTheDocument();
    expect(screen.queryByText('Next step')).not.toBeInTheDocument();
  });
});
