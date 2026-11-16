import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressLabelScheduler, MIN_LABEL_MS } from './progressLabelScheduler';

interface Step {
  /** Advance the fake clock by this many ms before running the action. */
  advanceMs: number;
  action?: { type: 'push'; step: string } | { type: 'clear' };
  /** Cumulative `onChange` call count expected right after this step. */
  expectedCallCount: number;
  /** Most recent `onChange` argument expected right after this step. */
  expectedLast: string | null;
}

function runSteps(steps: Step[]): Array<string | null> {
  const calls: Array<string | null> = [];
  const onChange = vi.fn((step: string | null) => calls.push(step));
  const scheduler = createProgressLabelScheduler(onChange);

  for (const step of steps) {
    vi.advanceTimersByTime(step.advanceMs);
    if (step.action?.type === 'push') scheduler.push(step.action.step);
    if (step.action?.type === 'clear') scheduler.clear();

    expect(onChange).toHaveBeenCalledTimes(step.expectedCallCount);
    expect(calls.length > 0 ? calls[calls.length - 1] : null).toBe(step.expectedLast);
  }

  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const SCENARIOS: Array<[string, Step[]]> = [
  [
    `a fast A/B/C sequence inside ${MIN_LABEL_MS}ms shows only A, then C once the minimum elapses`,
    [
      { advanceMs: 0, action: { type: 'push', step: 'A' }, expectedCallCount: 1, expectedLast: 'A' },
      { advanceMs: 100, action: { type: 'push', step: 'B' }, expectedCallCount: 1, expectedLast: 'A' },
      { advanceMs: 200, action: { type: 'push', step: 'C' }, expectedCallCount: 1, expectedLast: 'A' }, // t=300, still within 300ms of A — B already skipped
      { advanceMs: 700, expectedCallCount: 2, expectedLast: 'C' }, // t=1000 — the minimum elapses, B never shown
    ],
  ],
  [
    'a single label is never replaced before the minimum, exactly at the boundary',
    [
      { advanceMs: 0, action: { type: 'push', step: 'A' }, expectedCallCount: 1, expectedLast: 'A' },
      { advanceMs: 500, action: { type: 'push', step: 'B' }, expectedCallCount: 1, expectedLast: 'A' },
      { advanceMs: 499, expectedCallCount: 1, expectedLast: 'A' }, // t=999 — still not yet
      { advanceMs: 1, expectedCallCount: 2, expectedLast: 'B' }, // t=1000 — minimum reached
    ],
  ],
  [
    'the final answer clears the label immediately, never delayed to satisfy the minimum',
    [
      { advanceMs: 0, action: { type: 'push', step: 'A' }, expectedCallCount: 1, expectedLast: 'A' },
      { advanceMs: 200, action: { type: 'clear' }, expectedCallCount: 2, expectedLast: null }, // well before 1000ms — clears anyway
      { advanceMs: 2_000, expectedCallCount: 2, expectedLast: null }, // nothing left pending to flush later
    ],
  ],
];

// AC (progress display) / AD-31: labels must stay readable — never
// replaced faster than MIN_LABEL_MS — but the final answer must never wait
// on a stale label's minimum.
describe('createProgressLabelScheduler (min display time, AD-31)', () => {
  it.each(SCENARIOS)('%s', (_label, steps) => {
    runSteps(steps);
  });
});
