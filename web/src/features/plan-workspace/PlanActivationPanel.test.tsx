import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { PlanActivationReview } from '@app/shared';
import { PlanActivationPanel } from './PlanActivationPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fakeReview(overrides: Partial<PlanActivationReview> = {}): PlanActivationReview {
  const now = new Date().toISOString();
  return {
    plan: { id: 'plan-1', ideaId: 'idea-1', status: 'draft', threadId: 'plan:plan-1', createdAt: now, updatedAt: now },
    steps: [
      { id: 'step-1', stepOrder: 0, title: 'First action', description: ['Do it.'], dayOffset: 0, status: 'current', startedAt: null },
      { id: 'step-2', stepOrder: 1, title: 'Second action', description: ['Then this.'], dayOffset: 2, status: 'pending', startedAt: null },
      { id: 'step-3', stepOrder: 2, title: 'Third action', description: ['Then that.'], dayOffset: 5, status: 'pending', startedAt: null },
    ],
    ...overrides,
  };
}

/**
 * Bug fix (user-reported, live): "Edit -> change a step -> Save shows
 * 'something went wrong'." Mocks the real server contract exactly —
 * `POST /activate/modify` resolves the pending interrupt (the graph run
 * completes), so a subsequent `GET /activate` genuinely has nothing
 * pending (`{ review: null }`); only a fresh `POST /activate` starts a new
 * pause over the saved draft. Before the fix, `saveEdits` called `GET`
 * here and always landed on "Something went wrong" — this fails under
 * that old code and passes under the fix.
 */
describe('PlanActivationPanel (bug fix: modify/reject must re-POST /activate, never GET, to see the saved draft)', () => {
  it('shows the saved draft after Edit -> change a step -> Save, never "something went wrong"', async () => {
    const initialReview = fakeReview();
    const updatedReview = fakeReview({
      steps: [{ ...initialReview.steps[0]!, title: 'First action, edited' }, initialReview.steps[1]!, initialReview.steps[2]!],
    });

    let getActivateCalls = 0;
    let postActivateCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.endsWith('/activate/modify') && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify(initialReview.plan), { status: 200 }));
      }
      if (url.endsWith('/activate') && method === 'POST') {
        postActivateCalls += 1;
        const body = postActivateCalls === 1 ? initialReview : updatedReview;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      if (url.endsWith('/activate') && method === 'GET') {
        getActivateCalls += 1;
        // Nothing pending yet on first mount, and — critically — still
        // nothing pending right after a modify resolves the interrupt.
        return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
      }
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanActivationPanel planId="plan-1" ideaTitle="Resell thrifted clothing" onActivated={() => undefined} />);

    // Bug fix (user-reported, live): the review now starts automatically
    // on mount (nothing pending yet) — no "Review plan" click needed first.
    await screen.findByText(/First action/);

    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }));
    const titleInput = await screen.findByDisplayValue('First action');
    fireEvent.change(titleInput, { target: { value: 'First action, edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText(/First action, edited/)).toBeInTheDocument());
    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
    // The follow-up fetch after modify must be the fixed `POST`, not `GET`.
    expect(getActivateCalls).toBe(1); // only the initial mount check
    expect(postActivateCalls).toBe(2); // the auto-started review + the post-modify re-request
  });
});

// Spec 2.12 AC4: the review renders inside a backdropped Dialog (never
// pushing anything else on the page down), and a step description that
// already carries its own leading bullet marker renders as exactly one
// bullet once placed in the list's own `<li>`, not two.
describe('PlanActivationPanel (Spec 2.12 AC4: review-needing phases render inside a Dialog)', () => {
  it('renders the review inside a role="dialog" element, stripping a doubled leading bullet marker', async () => {
    const review = fakeReview({
      steps: [
        { id: 'step-1', stepOrder: 0, title: 'First action', description: ['• Take one photo.'], dayOffset: 0, status: 'current', startedAt: null },
      ],
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/activate') && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify(review), { status: 200 }));
      }
      if (url.endsWith('/activate') && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
      }
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanActivationPanel planId="plan-1" ideaTitle="Resell thrifted clothing" onActivated={() => undefined} />);

    // Bug fix (user-reported, live): the review now starts automatically
    // on mount — no "Review plan" click needed first.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Take one photo.')).toBeInTheDocument();
    expect(within(dialog).queryByText('• Take one photo.')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm & activate' })).toBeInTheDocument();
  });
});

// Bug fix (user-reported, live): "we can remove that [intermediate 'Review
// & activate your plan' card] entirely" — a fresh draft's review now opens
// immediately, with no extra click to get there. The earlier user-reported
// follow-up that made the modal's own X/Escape/backdrop close actually work
// stays intact: closing it still has to land somewhere, so it shows the
// same card as a way back in rather than a dead end.
describe('PlanActivationPanel (bug fix, live: review starts automatically, no intermediate card)', () => {
  it('opens the review with no "Review plan" click, and closing it shows a reopen card instead of a dead end', async () => {
    const review = fakeReview();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/activate') && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify(review), { status: 200 }));
      }
      if (url.endsWith('/activate') && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
      }
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanActivationPanel planId="plan-1" ideaTitle="Resell thrifted clothing" onActivated={() => undefined} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review plan' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Review plan' })).toBeInTheDocument();
  });
});

/**
 * User-reported, live: a "Not quite — regenerate" feedback asking for a step
 * count outside the 3-12 bound used to reach the model anyway and come back
 * with a bogus placeholder step ("Step 3: x"). Caught client-side now, before
 * `/activate/reject` is ever called.
 */
describe('PlanActivationPanel (guard: regenerate feedback requesting a step count outside 3-12)', () => {
  async function openRejectDialog(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock);
    render(<PlanActivationPanel planId="plan-1" ideaTitle="Resell thrifted clothing" onActivated={() => undefined} />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Not quite — regenerate' }));
    await screen.findByLabelText('What should change?');
  }

  it.each([
    ['2 steps', 'fewer than 3'],
    ['1 step', 'fewer than 3'],
    ['13 steps', 'more than 12'],
    ['20 steps', 'more than 12'],
  ])('blocks "%s" (%s) with the min/max message and never calls /activate/reject', async (feedbackText) => {
    const review = fakeReview();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/activate') && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify(review), { status: 200 }));
      }
      if (url.endsWith('/activate') && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
      }
      throw new Error(`Unmocked fetch: ${method} ${url}`);
    });
    await openRejectDialog(fetchMock);

    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: `Make it ${feedbackText} please` } });
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback & regenerate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Min steps 3, max steps 12.');
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.endsWith('/activate/reject') && (init as RequestInit | undefined)?.method === 'POST';
    })).toBe(false);
  });

  it.each(['3 steps', '12 steps', 'more encouraging'])(
    'allows "%s" through to /activate/reject (in range, or no step count mentioned)',
    async (feedbackText) => {
      const review = fakeReview();
      let rejectCalls = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        if (url.endsWith('/activate/reject') && method === 'POST') {
          rejectCalls += 1;
          return Promise.resolve(new Response(JSON.stringify(review.plan), { status: 200 }));
        }
        if (url.endsWith('/activate') && method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify(review), { status: 200 }));
        }
        if (url.endsWith('/activate') && method === 'GET') {
          return Promise.resolve(new Response(JSON.stringify({ review: null }), { status: 200 }));
        }
        throw new Error(`Unmocked fetch: ${method} ${url}`);
      });
      await openRejectDialog(fetchMock);

      fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: `Make it ${feedbackText}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback & regenerate' }));

      await waitFor(() => expect(rejectCalls).toBe(1));
      expect(screen.queryByText('Min steps 3, max steps 12.')).not.toBeInTheDocument();
    },
  );
});
