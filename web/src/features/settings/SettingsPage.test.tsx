import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';

function mockFetch(responses: Record<string, Response | (() => Response)>, onPost?: (url: string, body: unknown) => void) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && onPost) onPost(url, JSON.parse(String(init.body)));
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// AC: "settings persist per user in the user_settings table ... surfaced
// through an actual settings screen" — this is that screen, not a backend
// default: it loads the current personality/model and the registry-sourced
// option list, then POSTs a change back.
describe('SettingsPage (AC: real settings screen)', () => {
  it('renders the fetched personality and the registry-sourced model options', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/settings': new Response(
          JSON.stringify({
            personality: 'terse',
            model: 'openai/gpt-6-luna',
            selectableModels: [
              { id: 'openai/gpt-6-luna', displayName: 'GPT-6 Luna', pricePerMillionInputTokens: 2.5, pricePerMillionOutputTokens: 10, priceAsOf: '2026-11-01' },
            ],
          }),
          { status: 200 },
        ),
      }),
    );

    render(<SettingsPage />);

    const personalitySelect = (await screen.findByLabelText(/personality/i)) as HTMLSelectElement;
    await waitFor(() => expect(personalitySelect.value).toBe('terse'));
    expect(screen.getByText(/GPT-6 Luna/)).toBeInTheDocument();
  });

  it('POSTs the newly picked personality to /api/settings/personality', async () => {
    let posted: { url: string; body: unknown } | undefined;

    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          '/api/settings': new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [] }),
            { status: 200 },
          ),
          '/api/settings/personality': new Response(null, { status: 204 }),
        },
        (url, body) => {
          posted = { url, body };
        },
      ),
    );

    render(<SettingsPage />);

    const personalitySelect = (await screen.findByLabelText(/personality/i)) as HTMLSelectElement;
    await waitFor(() => expect(personalitySelect.value).toBe('friendly'));

    fireEvent.change(personalitySelect, { target: { value: 'formal' } });

    await waitFor(() => expect(posted?.url).toContain('/api/settings/personality'));
    expect(posted?.body).toEqual({ personality: 'formal' });
  });
});
