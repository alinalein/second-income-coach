import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import i18n from '../../i18n';

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
  void i18n.changeLanguage('en');
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
            uiLanguage: 'English',
            currency: 'EUR',
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
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English', currency: 'EUR' }),
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

  // AC1: "the user picks German or English -> set_ui_language persists the
  // choice ... and the whole UI switches immediately" — both the immediate
  // `i18n` switch and the POST happen off one select change.
  it('switches the active i18n language immediately and POSTs the choice to /api/settings/ui-language', async () => {
    let posted: { url: string; body: unknown } | undefined;

    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          '/api/settings': new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English', currency: 'EUR' }),
            { status: 200 },
          ),
          '/api/settings/ui-language': new Response(null, { status: 204 }),
        },
        (url, body) => {
          posted = { url, body };
        },
      ),
    );

    render(<SettingsPage />);

    const uiLanguageSelect = (await screen.findByLabelText(/language/i)) as HTMLSelectElement;
    await waitFor(() => expect(uiLanguageSelect.value).toBe('English'));

    fireEvent.change(uiLanguageSelect, { target: { value: 'German' } });

    expect(i18n.language).toBe('de');
    await waitFor(() => expect(posted?.url).toContain('/api/settings/ui-language'));
    expect(posted?.body).toEqual({ uiLanguage: 'German' });
  });

  // AC1: "the user picks EUR or USD -> set_currency persists the choice ...
  // and every displayed amount re-renders in the newly chosen currency
  // immediately" — the POST fires, and `onCurrencyChange` (the signal
  // `App.tsx` uses to remount `IdeasPanel`) only fires on a successful save.
  it('POSTs the newly picked currency to /api/settings/currency and calls onCurrencyChange on success', async () => {
    let posted: { url: string; body: unknown } | undefined;
    const onCurrencyChange = vi.fn();

    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          // The more specific path must be listed first — `mockFetch`
          // matches by `url.includes(key)`, and '/api/settings' is itself a
          // substring of '/api/settings/currency'.
          '/api/settings/currency': new Response(null, { status: 204 }),
          '/api/settings': new Response(
            JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English', currency: 'EUR' }),
            { status: 200 },
          ),
        },
        (url, body) => {
          posted = { url, body };
        },
      ),
    );

    render(<SettingsPage onCurrencyChange={onCurrencyChange} />);

    const currencySelect = (await screen.findByLabelText(/currency/i)) as HTMLSelectElement;
    await waitFor(() => expect(currencySelect.value).toBe('EUR'));

    fireEvent.change(currencySelect, { target: { value: 'USD' } });

    await waitFor(() => expect(posted?.url).toContain('/api/settings/currency'));
    expect(posted?.body).toEqual({ currency: 'USD' });
    await waitFor(() => expect(onCurrencyChange).toHaveBeenCalledTimes(1));
  });

  // Validation boundary: `onCurrencyChange` must never fire on a failed save.
  it('does not call onCurrencyChange when the currency save fails', async () => {
    const onCurrencyChange = vi.fn();

    vi.stubGlobal(
      'fetch',
      mockFetch({
        // See the previous test's comment: the more specific path must be
        // listed first for `mockFetch`'s `url.includes(key)` matching.
        '/api/settings/currency': new Response(null, { status: 500 }),
        '/api/settings': new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'English', currency: 'EUR' }),
          { status: 200 },
        ),
      }),
    );

    render(<SettingsPage onCurrencyChange={onCurrencyChange} />);

    const currencySelect = (await screen.findByLabelText(/currency/i)) as HTMLSelectElement;
    await waitFor(() => expect(currencySelect.value).toBe('EUR'));

    fireEvent.change(currencySelect, { target: { value: 'USD' } });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onCurrencyChange).not.toHaveBeenCalled();
  });
});
