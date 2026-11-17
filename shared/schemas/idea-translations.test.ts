import { describe, expect, it } from 'vitest';
import { ideaTranslationSchema, translateIdeasRequestSchema } from './idea-translations.js';

const VALID_TRANSLATION = {
  ideaId: 'idea-1',
  language: 'de' as const,
  title: 'Nachhilfe auf freiberuflicher Basis',
  rationale: 'Passt zu deiner freien Zeit.\nStarte mit einer Unterrichtsart online.',
  demandEvidenceNote: 'Die Nachfrage ist zuletzt gestiegen.',
  growthPath: 'Erhöhe deinen Satz, sobald du feste Kunden hast.',
};

// AC2/Boundary: "reuses rationaleSchema ... for the translated fields" — a
// translation's rationale is held to the exact same 2-3-line shape as a
// stored idea's own rationale, not a looser one; proven here by a value
// that satisfies that shared constraint passing and one that violates it
// (a single line, no newline) failing.
describe('ideaTranslationSchema (reuses rationaleSchema — same shape as a stored idea)', () => {
  it.each([
    { name: 'a 2-3 line rationale matching the stored shape', rationale: VALID_TRANSLATION.rationale, valid: true },
    { name: 'a single-line rationale (violates the shared 2-3-line rule)', rationale: 'Nur eine Zeile.', valid: false },
  ])('$name', ({ rationale, valid }) => {
    const result = ideaTranslationSchema.safeParse({ ...VALID_TRANSLATION, rationale });
    expect(result.success).toBe(valid);
  });
});

// AC2: "one batched model call translates all visible cards together" — a
// request naming zero ideas has nothing to batch, so it's rejected at the
// schema boundary rather than reaching the route/model at all.
describe('translateIdeasRequestSchema (AC2: a request always names at least one idea)', () => {
  it('rejects an empty ideaIds array', () => {
    const result = translateIdeasRequestSchema.safeParse({ ideaIds: [], language: 'de' });
    expect(result.success).toBe(false);
  });
});
