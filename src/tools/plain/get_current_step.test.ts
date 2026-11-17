import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPlanThreadId } from '../../agent/index.js';
import { derivePlanIdFromThreadId, pickCurrentAndNext } from './get_current_step.js';

type PlanStepRow = {
  id: string;
  planId: string;
  stepOrder: number;
  title: string;
  description: string[];
  dayOffset: number;
  status: string;
};

function step(overrides: Partial<PlanStepRow> = {}): PlanStepRow {
  return {
    id: randomUUID(),
    planId: 'plan-1',
    stepOrder: 0,
    title: 'Step',
    description: ['Do the thing.'],
    dayOffset: 0,
    status: 'pending',
    ...overrides,
  };
}

// AD-18: "a thread id is always derived from the ... session" — same
// trust-boundary derivation pattern as `deriveUserIdFromThreadId`
// (`submit_intake.ts`/`generate_ideas.ts`). Deterministic unit test over the
// pure derivation function, no DB involved.
describe('derivePlanIdFromThreadId (AD-18: planId derivation)', () => {
  it.each([
    ['plan:plan-123', 'plan-123'],
    ['plan:', undefined],
    ['discovery:user-1', undefined],
    [undefined, undefined],
  ] as const)('derives %j -> %j', (threadId, expected) => {
    expect(derivePlanIdFromThreadId(threadId)).toBe(expected);
  });

  // Pins the round-trip with `buildPlanThreadId` (`src/agent/index.ts`) —
  // this is a hand-duplicated inverse of it (Code Map), same precedent as
  // `generate_ideas.ts`'s round-trip test with `buildDiscoveryThreadId`.
  it('round-trips with buildPlanThreadId', () => {
    const planId = randomUUID();
    expect(derivePlanIdFromThreadId(buildPlanThreadId(planId))).toBe(planId);
  });
});

// AC/AD-4: "only the current and immediate-next step are visible —
// `get_current_step` is the sole path enforcing this." Table-driven over
// the pure selection logic (no DB), covering the 3 distinct shapes a plan's
// step rows can take.
describe('pickCurrentAndNext (AC/AD-4: capped to current+next)', () => {
  it('returns the current step and the immediate next step', () => {
    const rows = [
      step({ stepOrder: 0, status: 'completed', title: 'Done' }),
      step({ stepOrder: 1, status: 'current', title: 'Now' }),
      step({ stepOrder: 2, status: 'pending', title: 'Next' }),
      step({ stepOrder: 3, status: 'pending', title: 'Later' }),
    ];

    const result = pickCurrentAndNext(rows);

    expect(result.current?.title).toBe('Now');
    expect(result.next?.title).toBe('Next');
  });

  it('returns a null next when the current step is the last one', () => {
    const rows = [step({ stepOrder: 0, status: 'completed' }), step({ stepOrder: 1, status: 'current', title: 'Last' })];

    const result = pickCurrentAndNext(rows);

    expect(result.current?.title).toBe('Last');
    expect(result.next).toBeNull();
  });

  it('returns null for both when no step is current', () => {
    const rows = [step({ stepOrder: 0, status: 'pending' }), step({ stepOrder: 1, status: 'pending' })];

    const result = pickCurrentAndNext(rows);

    expect(result.current).toBeNull();
    expect(result.next).toBeNull();
  });
});
