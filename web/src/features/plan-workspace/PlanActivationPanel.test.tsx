import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

    render(<PlanActivationPanel planId="plan-1" onActivated={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review plan' }));
    await screen.findByText(/First action/);

    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }));
    const titleInput = await screen.findByDisplayValue('First action');
    fireEvent.change(titleInput, { target: { value: 'First action, edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText(/First action, edited/)).toBeInTheDocument());
    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
    // The follow-up fetch after modify must be the fixed `POST`, not `GET`.
    expect(getActivateCalls).toBe(1); // only the initial mount check
    expect(postActivateCalls).toBe(2); // "Review plan" click + the post-modify re-request
  });
});
