import { describe, expect, it, vi } from 'vitest';
import { setModel, UnselectableModelError } from './set_model.js';
import { MODERATION_MODEL_NAME } from '../../agent/moderation.js';
import { DEFAULT_MODEL_ID } from '../../agent/registry.js';

const CONFIGURED_ENV = { OPENROUTER_API_KEY: 'key', MISTRAL_API_KEY: 'key' };

// AC: "set_model ... is a plain deterministic Postgres write (AD-4/AD-20) -
// not an LLM decision" (row 1) / "only providers with a configured
// server-side key appear, and the moderation/transcription models never
// appear as options" enforced at the write boundary too, not just the UI
// list (row 2 — a distinct failure branch, the db write must never happen).
describe('setModel', () => {
  it.each([
    ['a currently selectable chat model', DEFAULT_MODEL_ID, { shouldWrite: true }],
    ['the second registered chat model', 'google/gemini-3.8-flash', { shouldWrite: true }],
    ['the third registered chat model', 'anthropic/claude-haiku-4.5', { shouldWrite: true }],
    ['the moderation model id (never selectable)', MODERATION_MODEL_NAME, { shouldWrite: false }],
    // Removed from the registry — must be rejected the same way as any
    // other unregistered id, not silently accepted as a stale-but-valid one.
    ['a removed id (no longer registered)', 'anthropic/claude-sonnet-5', { shouldWrite: false }],
    ['a removed id (too slow in production)', 'mistralai/mistral-large-4-0', { shouldWrite: false }],
    // Eval-only/judge models (evals.md, Epic 6) were never registered at
    // all, so they're rejected the same way as any other unregistered id.
    ['an eval-only id that was never registered', 'anthropic/claude-sonnet-5.5', { shouldWrite: false }],
  ] as const)('%s', async (_label, requestedModel, { shouldWrite }) => {
    const updateModel = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;

    if (shouldWrite) {
      await setModel(db, CONFIGURED_ENV, 'user-1', requestedModel, { updateModel });
      expect(updateModel).toHaveBeenCalledWith(db, 'user-1', requestedModel);
    } else {
      await expect(setModel(db, CONFIGURED_ENV, 'user-1', requestedModel, { updateModel })).rejects.toBeInstanceOf(
        UnselectableModelError,
      );
      expect(updateModel).not.toHaveBeenCalled();
    }
  });
});
