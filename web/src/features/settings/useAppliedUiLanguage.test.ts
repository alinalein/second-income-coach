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
});
