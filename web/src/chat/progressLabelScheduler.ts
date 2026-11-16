/**
 * Review follow-up (AC: progress display, AD-31): without this, a fast
 * sequence of real progress-step transitions (e.g. `checking_message` ->
 * `generating_response` arriving within a few hundred ms of each other --
 * normal, since every step besides the actual model call is near-instant)
 * flickers a label on screen for a fraction of a second before the next one
 * replaces it, too fast to read.
 *
 * Decouples the raw step sequence a turn emits (`push`) from what's actually
 * displayed (`onChange`): each displayed label stays up for at least
 * `MIN_LABEL_MS`. If more steps arrive during that window, only the most
 * recent one is shown next once the minimum has elapsed -- intermediate ones
 * are skipped, so the display never lags the real progress by more than one
 * label. `clear()` (the turn's final answer arriving) always takes effect
 * immediately, bypassing the minimum -- the answer is never delayed to keep
 * a stale status visible. The very first label (nothing displayed yet)
 * always shows immediately too.
 *
 * Client-side display timing only -- never changes which real step events
 * `src/agent/progress.ts` emits or how `web/src/chat/sse.ts` parses them.
 */
export const MIN_LABEL_MS = 1000;

export interface ProgressLabelScheduler {
  /** Call for every real progress step as it arrives (already-validated —
   * `ChatThread` still parses each frame through `progressEventSchema`
   * before calling this). */
  push(step: string): void;
  /** Call when the turn's final answer arrives -- clears the displayed
   * label immediately, bypassing the minimum, and drops any pending step. */
  clear(): void;
}

export function createProgressLabelScheduler(
  onChange: (step: string | null) => void,
  minDisplayMs: number = MIN_LABEL_MS,
): ProgressLabelScheduler {
  let shownAt: number | null = null;
  let pendingStep: string | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function show(step: string): void {
    shownAt = Date.now();
    pendingStep = null;
    onChange(step);
  }

  // Always targets the fixed point `shownAt + minDisplayMs`, however many
  // times a newer pending step overwrites an older one in the meantime.
  function scheduleFlush(): void {
    cancelTimer();
    const elapsed = Date.now() - (shownAt ?? Date.now());
    const remaining = Math.max(0, minDisplayMs - elapsed);
    timerId = setTimeout(() => {
      timerId = null;
      if (pendingStep !== null) show(pendingStep);
    }, remaining);
  }

  return {
    push(step) {
      if (shownAt === null) {
        show(step); // nothing displayed yet -- the first label may appear immediately
        return;
      }
      if (Date.now() - shownAt >= minDisplayMs) {
        show(step);
      } else {
        pendingStep = step;
        scheduleFlush();
      }
    },
    clear() {
      cancelTimer();
      shownAt = null;
      pendingStep = null;
      onChange(null);
    },
  };
}
