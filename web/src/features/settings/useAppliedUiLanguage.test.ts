import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useAppliedUiLanguage } from './useAppliedUiLanguage';
import i18n from '../../i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  void i18n.changeLanguage('en');
});

// AC: "a stored UI language preference ... persists across sessions" / "it
// is applied when the app loads for a signed-in user."
describe('useAppliedUiLanguage (AC: stored language applied on load)', () => {
  it('switches i18n to the stored German preference when enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'German', currency: 'EUR' }),
          { status: 200 },
        ),
      ),
    );

    renderHook(() => useAppliedUiLanguage(true));

    await waitFor(() => expect(i18n.language).toBe('de'));
  });

  it('does not fetch or change the language when disabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderHook(() => useAppliedUiLanguage(false));

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(i18n.language).toBe('en');
  });

  // Live fix (post-handoff, user-reported): the race this closes — a
  // UI-language-dependent action (e.g. "Generate new ideas") firing while
  // `ready` is still false would read the wrong, not-yet-applied `i18n`
  // default. `App.tsx` gates its loading placeholder on this value.
  it('is not ready until the settings fetch resolves and the language is applied', async () => {
    let resolveFetch!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => pendingFetch));

    const { result } = renderHook(() => useAppliedUiLanguage(true));
    expect(result.current).toBe(false);

    resolveFetch(
      new Response(
        JSON.stringify({ personality: 'friendly', model: 'openai/gpt-6-luna', selectableModels: [], uiLanguage: 'German', currency: 'EUR' }),
        { status: 200 },
      ),
    );

    await waitFor(() => expect(result.current).toBe(true));
    expect(i18n.language).toBe('de');
  });

  it('is immediately ready when disabled', () => {
    const { result } = renderHook(() => useAppliedUiLanguage(false));
    expect(result.current).toBe(true);
  });
});
