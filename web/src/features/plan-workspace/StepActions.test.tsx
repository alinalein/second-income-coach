import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PlanStepResponse } from '@app/shared';
import { StepActions } from './StepActions';

function fakeStep(overrides: Partial<PlanStepResponse> = {}): PlanStepResponse {
  return {
    id: 'step-1',
    stepOrder: 0,
    title: 'Current title',
    description: ['Current description'],
    dayOffset: 0,
    status: 'current',
    startedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Bug fix (user-reported, follow-up): pressing "Start this step" must never
// change this block's rendered height — the status card jumping pushed the
// projection card below it. The Start button is now a reserved slot (always
// one `Button`, same size) that gets disabled and relabeled "In progress"
// in place once `step.startedAt` is set, instead of being removed/animated
// out of flow. jsdom can't measure pixels, so this asserts the structural
// invariant that actually guarantees the fix: the same two buttons, in the
// same slot (the identical DOM node, never unmounted), with the same
// classes, before and after.
describe('StepActions (bug fix: reserved action slot, no height jump on Start)', () => {
  it('keeps the same two buttons in the same slots, with the same classes, before and after the step starts', () => {
    const onStepChanged = vi.fn();
    const { container, rerender } = render(
      <StepActions planId="plan-1" step={fakeStep({ startedAt: null })} onStepChanged={onStepChanged} />,
    );

    expect(container.querySelectorAll('button')).toHaveLength(2);
    const startSlotBefore = screen.getByRole('button', { name: 'Start this step' });
    expect(startSlotBefore).not.toBeDisabled();
    const classesBefore = startSlotBefore.className;

    rerender(<StepActions planId="plan-1" step={fakeStep({ startedAt: new Date().toISOString() })} onStepChanged={onStepChanged} />);

    expect(container.querySelectorAll('button')).toHaveLength(2);
    const startSlotAfter = screen.getByRole('button', { name: 'In progress' });
    // Same DOM node — proves the slot was never removed/remounted, only
    // relabeled and disabled in place.
    expect(startSlotAfter).toBe(startSlotBefore);
    expect(startSlotAfter).toBeDisabled();
    expect(startSlotAfter.className).toBe(classesBefore);
    expect(screen.getByRole('button', { name: 'Mark as done' })).not.toBeDisabled();
  });
});
