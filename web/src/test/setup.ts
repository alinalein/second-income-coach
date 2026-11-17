import '@testing-library/jest-dom/vitest';
import '../i18n';

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
