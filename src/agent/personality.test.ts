import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONALITY, resolvePersonality } from './personality.js';

// AC: "the user picks a personality (formal/friendly/terse) -> set_personality
// persists the choice" (the resolution side of that: whatever is actually
// stored must come back as one of these three, defaulting rather than
// erroring on anything else — same resolution principle Story 5.1 applies
// to the model id, `src/agent/registry.ts`'s `resolveModelId`).
describe('resolvePersonality', () => {
  it.each([
    ['formal', 'formal'],
    ['friendly', 'friendly'],
    ['terse', 'terse'],
    ['not-a-real-personality', DEFAULT_PERSONALITY],
    [null, DEFAULT_PERSONALITY],
    [undefined, DEFAULT_PERSONALITY],
  ] as const)('%s -> %s', (input, expected) => {
    expect(resolvePersonality(input)).toBe(expected);
  });
});
