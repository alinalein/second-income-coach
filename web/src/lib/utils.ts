import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Spec 2.12 AC4: a plan step `description` entry occasionally already
 * starts with its own bullet marker (model output inconsistency) — rendered
 * inside a `<li>` as-is, that marker doubles up with the list's own CSS
 * bullet. Strips exactly one leading `•`/`-`/`*`/`·` marker (and any
 * whitespace right after it); text with no such marker, or a marker
 * anywhere but the very start, is returned unchanged.
 */
export function stripLeadingBulletMarker(text: string): string {
  return text.replace(/^[•\-*·]\s*/, '');
}

/**
 * Story 2.13 AC: "reduced-motion settings ... instant instead of
 * animated." `matchMedia` is read fresh at call time (not memoized) — this
 * never changes mid-session in practice, but there's no reason to cache a
 * system setting read this cheaply. Review fix (Spec 2.12): shared here
 * instead of each of `ChatThread.tsx`/`IdeaEvidence.tsx` reimplementing the
 * same `window.matchMedia` check independently.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}
