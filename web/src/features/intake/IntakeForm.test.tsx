import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
