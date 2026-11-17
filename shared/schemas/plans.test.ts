import { describe, expect, it } from 'vitest';
import { createPlanDraftSchema } from './plans.js';

function draftStep(overrides: Partial<{ title: string; description: string[]; dayOffset: number }> = {}) {
  return { title: 'List your first item', description: ['Take one photo.', 'Write a short description.'], dayOffset: 0, ...overrides };
}

// AC/AD-4/AD-16: "the LLM's plan output ... is validated against the shared
// Zod schema before the write." One valid-shape test plus one table-driven
// test covering every distinct invalid-shape branch this schema itself
// enforces (step count bounds, non-decreasing dayOffset) — each a case
// `create_plan.ts`'s own write must never reach with a malformed batch.
describe('createPlanDraftSchema (AC/AD-4/AD-16: LLM output validated before write)', () => {
  // Story 2.6 AC4: 12 -> 8 plan steps.
  it('accepts 3-8 ordered steps with non-decreasing dayOffset', () => {
    const result = createPlanDraftSchema.safeParse({
      steps: [draftStep({ dayOffset: 0 }), draftStep({ dayOffset: 2 }), draftStep({ dayOffset: 2 }), draftStep({ dayOffset: 5 })],
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ['fewer than 3 steps', [draftStep(), draftStep()]],
    ['more than 8 steps', Array.from({ length: 9 }, () => draftStep())],
    ['a decreasing dayOffset', [draftStep({ dayOffset: 5 }), draftStep({ dayOffset: 1 }), draftStep({ dayOffset: 2 })]],
    // UI fix (user-reported): a step's description must be a non-empty,
    // bounded list of bullet actions, not a prose string — `draftStep`'s
    // own override still lets a test force an invalid shape past it.
    ['an empty description', [draftStep({ description: [] }), draftStep(), draftStep()]],
    // Story 2.6 AC4: 5 -> 3 description actions.
    ['more than 3 description actions', [draftStep({ description: Array.from({ length: 4 }, (_, i) => `Action ${i}`) }), draftStep(), draftStep()]],
  ] as const)('rejects %s', (_name, steps) => {
    const result = createPlanDraftSchema.safeParse({ steps });
    expect(result.success).toBe(false);
  });
});
