import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { EnergyCheckInPopup } from './EnergyCheckInPopup';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// AC (4.1, follow-up): "dismissing it counts as answered for that day: no
// energy stored, no re-ask the same day" — the close X is the same
// `shadcn-glass-ui` `DialogContent`'s built-in close button Story 2.8's
// confirm dialog already relies on.
describe('EnergyCheckInPopup (AC: dismiss counts as answered for the day)', () => {
  it('dismissing via the close X records no check-in and never re-asks on a later mount the same day', async () => {
    const fetchMock = mockFetch({
      '/api/plans/check-in-status': () => new Response(JSON.stringify({ answeredToday: false }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<EnergyCheckInPopup planId="plan-1" />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/check-in'), expect.objectContaining({ method: 'POST' }));

    unmount();
    // A later mount (e.g. switching plans) the same day must not even ask
    // the server again — `wasDismissedToday()` short-circuits the effect.
    const secondFetchMock = vi.fn(() => {
      throw new Error('check-in-status must not be fetched again the same day once dismissed');
    });
    vi.stubGlobal('fetch', secondFetchMock);

    render(<EnergyCheckInPopup planId="plan-2" />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(secondFetchMock).not.toHaveBeenCalled();
  });
});

// AC (4.1, follow-up): "the answer is stored against the plan open at that
// moment" + item 2: "a check-in answer [triggers] the projection card
// [to] refetch" via `onCheckInRecorded`, fired immediately (not after the
// multi-second "thanks" animation).
describe('EnergyCheckInPopup (AC: answer stored against the open plan, fires onCheckInRecorded)', () => {
  it('posts the chosen energy to this exact plan\'s check-in route and calls onCheckInRecorded', async () => {
    const fetchMock = mockFetch({
      '/api/plans/check-in-status': () => new Response(JSON.stringify({ answeredToday: false }), { status: 200 }),
      '/api/plans/plan-42/check-in': () =>
        new Response(
          JSON.stringify({ id: 'checkin-1', planId: 'plan-42', energy: 'low', note: null, createdAt: new Date().toISOString() }),
          { status: 200 },
        ),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCheckInRecorded = vi.fn();

    render(<EnergyCheckInPopup planId="plan-42" onCheckInRecorded={onCheckInRecorded} />);
    await screen.findByRole('dialog');

    fireEvent.click(await screen.findByRole('button', { name: 'Low' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plans/plan-42/check-in',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ energy: 'low' }) }),
      );
    });
    await waitFor(() => expect(onCheckInRecorded).toHaveBeenCalledTimes(1));
  });
});
