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
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
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
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
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
      gapDetected: false,
      missedDays: 0,
      checkedInToday: false,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" />);

    expect(await screen.findByText('Last step')).toBeInTheDocument();
    expect(screen.queryByText('Next step')).not.toBeInTheDocument();
  });
});

// Bug fix (user-reported, live), item 2: "the projection card refetches ...
// after Start this step [or] Mark as done" — `StatusPanel` is the one
// surface that owns those two actions (via `StepActions`); this confirms it
// notifies `onPlanActivityChanged` (in addition to its own refetch) once
// either one actually succeeds.
describe('StatusPanel (AC follow-up: Start/Complete notify onPlanActivityChanged)', () => {
  it.each([
    [
      'Start this step',
      '/api/plans/plan-1/steps/step-1/start',
      JSON.stringify({ step: { ...fakeStep(), startedAt: new Date().toISOString() } }),
    ],
    [
      'Mark as done',
      '/api/plans/plan-1/steps/step-1/complete',
      JSON.stringify({ step: { ...fakeStep(), status: 'completed' }, planCompleted: false }),
    ],
  ] as const)('clicking "%s" calls onPlanActivityChanged once it succeeds', async (buttonLabel, actionPath, actionResponseBody) => {
    const body: CurrentStepResponse = { current: fakeStep(), next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
    const onPlanActivityChanged = vi.fn();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }),
        [actionPath]: () => new Response(actionResponseBody, { status: 200 }),
      }),
    );

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="active" onPlanActivityChanged={onPlanActivityChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: buttonLabel }));

    await waitFor(() => expect(onPlanActivityChanged).toHaveBeenCalledTimes(1));
  });
});

// Bug fix (user-reported, live): a plan still awaiting human review/
// activation must not let its current step be started/completed early —
// the backend rejects it too (`PlanNotActiveError`), this is the UI mirror.
describe('StatusPanel (AC follow-up: Start/Mark-as-done disabled before the plan is active)', () => {
  it('disables both buttons while planStatus is "draft"', async () => {
    const body: CurrentStepResponse = { current: fakeStep(), next: null, gapDetected: false, missedDays: 0, checkedInToday: false };
    vi.stubGlobal('fetch', mockFetch({ '/api/plans/plan-1/current-step': () => new Response(JSON.stringify(body), { status: 200 }) }));

    render(<StatusPanel planId="plan-1" ideaTitle="Resell thrifted clothing" planStatus="draft" />);

    expect(await screen.findByRole('button', { name: 'Start this step' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as done' })).toBeDisabled();
  });
});
