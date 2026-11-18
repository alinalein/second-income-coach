import '@testing-library/jest-dom/vitest';
import '../i18n';

/**
 * jsdom has no real layout engine, so `window.matchMedia` doesn't exist
 * (older jsdom) or always reports `matches: false` (newer jsdom) regardless
 * of the query — neither reflects a real viewport. `Sidebar.tsx`'s
 * `useIsDesktop` reads this directly (a deliberate JS decision, not a CSS
 * `sm:` toggle — see its own doc comment), so every test needs a usable
 * default. Defaults to "desktop" (`matches: true`) since that's what every
 * existing `Sidebar`/`App` test already renders against; a test that needs
 * the narrow/mobile branch overrides `window.matchMedia` itself (same
 * per-test-override pattern `vi.stubGlobal('fetch', ...)` already uses).
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom doesn't implement `Element.prototype.scrollIntoView` (ChatThread's
// own scroll-pinning behavior calls it) — a no-op stub, same precedent as
// any other jsdom API gap, so app code can call the real DOM method
// directly without a defensive guard that would only ever exist for tests.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Story 2.13: same jsdom gap, for `Element.prototype.scrollTo` (`ChatThread`
// calls it directly, with a `behavior` option, so it can scroll *this*
// scroll region only — never any ancestor, unlike `scrollIntoView`).
if (!Element.prototype.scrollTo) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollTo = () => {};
}
