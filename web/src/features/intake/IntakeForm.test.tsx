import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { IntakeForm } from './IntakeForm';
import intakeEn from '../../locales/en/intake.json';

function mockFetchGetOnly() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/intake')) {
      return Promise.resolve(new Response(JSON.stringify({ intake: null }), { status: 200 }));
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

function fakeIntakeRecord() {
  const now = new Date().toISOString();
  return {
    id: 'intake-1',
    skillsInterests: 'Woodworking',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'Got overwhelmed.',
    country: 'other',
    failurePattern: 'overwhelm',
    createdAt: now,
    updatedAt: now,
  };
}

/** An existing intake (so the GET-on-mount prefill shows it, same as
 * "Review your intake answers") — `postOutcome` controls what the re-save
 * itself does. */
function mockFetchWithExistingIntake(postOutcome: 'success' | 'failure') {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (!url.includes('/api/intake')) throw new Error(`Unmocked fetch: ${url}`);
    if (method === 'GET') return Promise.resolve(new Response(JSON.stringify({ intake: fakeIntakeRecord() }), { status: 200 }));
    if (postOutcome === 'failure') return Promise.resolve(new Response(null, { status: 502 }));
    return Promise.resolve(new Response(JSON.stringify({ intake: fakeIntakeRecord() }), { status: 200 }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// AC6: "client-side submitIntakeRequestSchema.safeParse before POST" — a
// blank required free-text field must never reach the network.
describe('IntakeForm (AC6: client-side validation gate)', () => {
  it('blocks submission and shows a field error when a required field is empty, never calling POST', async () => {
    const fetchMock = mockFetchGetOnly();
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(<IntakeForm onSaved={onSaved} />);

    await screen.findByText(intakeEn.title);
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));

    expect(await screen.findAllByText(intakeEn.error.required)).not.toHaveLength(0);
    // Only the initial GET-on-mount fetch ever happened — the invalid
    // submission never reached the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// Bug fix (user-reported, live): re-saving an existing intake left the Save
// button stuck on "Saving…" forever — the success branch never transitioned
// `phase` back out of `'submitting'` at all (only the failure branch did),
// invisible on a first-ever save (which navigates this component away
// before the stuck state is ever seen) but very visible on a re-save. The
// button itself goes straight back to its resting label on success; a
// separate small "Changes saved" note next to it (never inside the button)
// is the only confirmation, for 2 seconds or until the next edit.
describe('IntakeForm (bug fix, live: re-save Save-button state sequence)', () => {
  it.each([
    ['succeeds', 'success'] as const,
    ['fails', 'failure'] as const,
  ])('re-save that %s: leaves "Saving…" correctly, never stays stuck', async (_label, outcome) => {
    vi.stubGlobal('fetch', mockFetchWithExistingIntake(outcome));
    render(<IntakeForm onSaved={vi.fn()} />);

    await screen.findByDisplayValue('Woodworking');
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));

    expect(await screen.findByRole('button', { name: intakeEn.savingButton })).toBeInTheDocument();

    if (outcome === 'success') {
      // The bug: this button used to stay on "Saving…" forever here.
      expect(await screen.findByRole('button', { name: intakeEn.submitButton })).toBeInTheDocument();
      expect(screen.getByText(intakeEn.savedConfirmation)).toBeInTheDocument();
      // The 2-second note auto-dismisses — real timers (not faked), so this
      // also proves it isn't stuck past it.
      await waitFor(() => expect(screen.queryByText(intakeEn.savedConfirmation)).not.toBeInTheDocument(), { timeout: 3000 });
    } else {
      expect(await screen.findByRole('button', { name: intakeEn.submitButton })).toBeInTheDocument();
      expect(screen.getByText(intakeEn.error.submitFailed)).toBeInTheDocument();
      expect(screen.queryByText(intakeEn.savedConfirmation)).not.toBeInTheDocument();
    }
  }, 10_000);

  // Bug fix (user-reported, live): "back to 'Save' ... also immediately
  // when the user edits a field again" — edits right after a successful
  // save must not wait out the 2-second auto-dismiss.
  it('dismisses the "Changes saved" note immediately when the user edits a field again', async () => {
    vi.stubGlobal('fetch', mockFetchWithExistingIntake('success'));
    render(<IntakeForm onSaved={vi.fn()} />);

    await screen.findByDisplayValue('Woodworking');
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));
    expect(await screen.findByText(intakeEn.savedConfirmation)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(intakeEn.skillsInterests.label), { target: { value: 'Pottery' } });

    expect(screen.queryByText(intakeEn.savedConfirmation)).not.toBeInTheDocument();
  });

  // Bug fix (user-reported, live): "the form kind of jumps or flickers —
  // this should not happen, only the button changes." Every field used to
  // get `disabled` too (dimming the whole form via `disabled:opacity-50`
  // the instant a save started) — now only the submit button does.
  it('never disables the other fields while saving — only the button changes', async () => {
    vi.stubGlobal('fetch', mockFetchWithExistingIntake('success'));
    render(<IntakeForm onSaved={vi.fn()} />);

    await screen.findByDisplayValue('Woodworking');
    fireEvent.click(screen.getByRole('button', { name: intakeEn.submitButton }));

    expect(await screen.findByRole('button', { name: intakeEn.savingButton })).toBeInTheDocument();
    expect(screen.getByLabelText(intakeEn.skillsInterests.label)).not.toBeDisabled();
    expect(screen.getByLabelText(intakeEn.stoppedBeforeText.label)).not.toBeDisabled();
    expect(screen.getByLabelText(intakeEn.weeklyTimeAvailability.label)).not.toBeDisabled();
  });
});
