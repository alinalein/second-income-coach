import { describe, expect, it, vi } from 'vitest';
import { setUiLanguage } from './set_ui_language.js';
import { detectReplyLanguage } from '../../agent/language.js';

// AC1: "the user picks German or English -> set_ui_language persists the
// choice in the ui_language column" / AD-4/AD-20: "a plain deterministic
// Postgres write - not an LLM decision".
describe('setUiLanguage (AC1: plain deterministic Postgres write)', () => {
  it('writes the validated UI language for the given user', async () => {
    const updateUiLanguage = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;

    await setUiLanguage(db, 'user-1', 'German', { updateUiLanguage });

    expect(updateUiLanguage).toHaveBeenCalledWith(db, 'user-1', 'German');
  });
});

// AC4/AD-25: "the UI language has no effect on which language the agent
// replies in - the two are independent". `detectReplyLanguage` (untouched by
// this story) derives the reply language from the message text alone; this
// proves a `set_ui_language` write has no bearing on its result.
describe('setUiLanguage independence from reply-language detection (AC4/AD-25)', () => {
  it('leaves detectReplyLanguage unaffected by a UI language write', async () => {
    const updateUiLanguage = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;

    await setUiLanguage(db, 'user-1', 'German', { updateUiLanguage });

    expect(detectReplyLanguage('Hello, can you help me?')).toBe('en');
    expect(detectReplyLanguage('Können Sie mir helfen?')).toBe('de');
  });
});
