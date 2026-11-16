import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, listSelectableModels, resolveModelId } from './registry.js';
import { MODERATION_MODEL_NAME } from './moderation.js';

const CONFIGURED_ENV = { OPENROUTER_API_KEY: 'key', MISTRAL_API_KEY: 'key' };
const NO_OPENROUTER_ENV = { OPENROUTER_API_KEY: '', MISTRAL_API_KEY: 'key' };

const SELECTABLE_IDS = ['openai/gpt-6-luna', 'google/gemini-3.8-flash', 'anthropic/claude-haiku-4.5'];

// Removed from the registry (`anthropic/claude-sonnet-5`, and
// `mistralai/mistral-large-4-0` — consistently too slow in production,
// still in OpenRouter public preview) or never added — eval-only/judge
// models that must never be user-selectable (evals.md, Epic 6).
const EXCLUDED_IDS = [
  'anthropic/claude-sonnet-5',
  'mistralai/mistral-large-4-0',
  'anthropic/claude-sonnet-5.5',
  'deepseek/deepseek-v4.1-flash',
];

// AC: "the settings screen lists selectable models ... only providers with a
// configured server-side key appear, and the moderation/transcription
// models never appear as options."
describe('listSelectableModels (AC: selectable-model filtering)', () => {
  it.each([
    [
      'provider key configured -> exactly the three registered chat models appear, moderation and excluded/eval-only ids never do',
      CONFIGURED_ENV,
      (ids: string[]) => {
        expect(ids).toEqual(expect.arrayContaining(SELECTABLE_IDS));
        expect(ids).toHaveLength(SELECTABLE_IDS.length);
        expect(ids).not.toContain(MODERATION_MODEL_NAME);
        EXCLUDED_IDS.forEach((id) => expect(ids).not.toContain(id));
      },
    ],
    [
      "provider key missing -> that provider's chat models drop out entirely",
      NO_OPENROUTER_ENV,
      (ids: string[]) => {
        SELECTABLE_IDS.forEach((id) => expect(ids).not.toContain(id));
      },
    ],
  ] as const)('%s', (_label, env, assertOnIds) => {
    assertOnIds(listSelectableModels(env).map((entry) => entry.id));
  });
});

// AC: "the model column ... holds a model-registry id validated against the
// registry introduced here, and an unknown or no-longer-selectable id
// resolves to the default model rather than erroring."
describe('resolveModelId (AC: unknown/stale id resolution)', () => {
  it.each([
    ['the default chat id', 'openai/gpt-6-luna', 'openai/gpt-6-luna'],
    ['the second registered chat id', 'google/gemini-3.8-flash', 'google/gemini-3.8-flash'],
    ['the third registered chat id', 'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5'],
    ['an id not in the registry at all', 'not-a-real-model', DEFAULT_MODEL_ID],
    ['the moderation model id (wrong category)', MODERATION_MODEL_NAME, DEFAULT_MODEL_ID],
    ['a removed id (anthropic/claude-sonnet-5, no longer registered)', 'anthropic/claude-sonnet-5', DEFAULT_MODEL_ID],
    ['a removed id (mistralai/mistral-large-4-0, too slow in production)', 'mistralai/mistral-large-4-0', DEFAULT_MODEL_ID],
    ['an eval-only id that was never registered (anthropic/claude-sonnet-5.5)', 'anthropic/claude-sonnet-5.5', DEFAULT_MODEL_ID],
    ['null (legacy "use default" sentinel)', null, DEFAULT_MODEL_ID],
    ['undefined', undefined, DEFAULT_MODEL_ID],
  ] as const)('%s -> %s', (_label, input, expected) => {
    expect(resolveModelId(input)).toBe(expected);
  });
});
