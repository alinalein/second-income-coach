import { describe, expect, it } from 'vitest';
import { stripLeadingBulletMarker } from './utils';

// Spec 2.12 AC4: a plan step description that already starts with its own
// bullet marker must render as exactly one bullet (the list's own CSS
// bullet), not two — `StatusPanel`/`PlanActivationPanel` both apply this
// before rendering each `<li>`.
describe('stripLeadingBulletMarker (AC4)', () => {
  it.each([
    ['leading bullet (•)', '• Take a photo.', 'Take a photo.'],
    ['leading dash (-)', '- Take a photo.', 'Take a photo.'],
    ['leading asterisk (*)', '* Take a photo.', 'Take a photo.'],
    ['leading middle dot (·)', '· Take a photo.', 'Take a photo.'],
    ['no marker at all, unchanged', 'Take a photo.', 'Take a photo.'],
    ['marker mid-sentence, unaffected', 'Take a photo - then write.', 'Take a photo - then write.'],
  ])('%s', (_name, input, expected) => {
    expect(stripLeadingBulletMarker(input)).toBe(expected);
  });
});
