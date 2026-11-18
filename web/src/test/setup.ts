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
