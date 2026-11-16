import { describe, expect, it, vi } from 'vitest';
import { setPersonality } from './set_personality.js';

// AC: "the user picks a personality -> set_personality persists the choice"
// / AD-4/AD-20: "a plain deterministic Postgres write - not an LLM decision".
describe('setPersonality', () => {
  it('writes the validated personality for the given user', async () => {
    const updatePersonality = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;

    await setPersonality(db, 'user-1', 'terse', { updatePersonality });

    expect(updatePersonality).toHaveBeenCalledWith(db, 'user-1', 'terse');
  });
});
