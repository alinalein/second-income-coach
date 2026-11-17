import { describe, expect, it } from 'vitest';
import { classifyCitationRegion } from './region.js';

// Story 2.5 (AC: "a source for another region is labeled on the card" /
// "a figure in another currency region is never presented as a local
// rate"). Pure-function test (CLAUDE.md: deterministic unit test for a
// plain-code tool) — one row per configured region, plus the "no claim"
// fallback for a domain not in the map at all.
describe('classifyCitationRegion', () => {
  it.each([
    { name: 'a German official-statistics domain resolves to DE', citation: 'https://www.destatis.de/report.htm', expected: 'DE' },
    { name: 'an Austrian official-statistics domain resolves to AT', citation: 'https://www.statistik.at/report.htm', expected: 'AT' },
    { name: 'a US official-statistics domain resolves to US', citation: 'https://www.bls.gov/oes/current/report.htm', expected: 'US' },
    { name: 'a subdomain of a mapped domain still resolves (endsWith match)', citation: 'https://data.bls.gov/report.htm', expected: 'US' },
    { name: 'a domain not in the map resolves to undefined (no claim either way)', citation: 'https://www.example.com/report.htm', expected: undefined },
    { name: 'text that does not parse as a URL falls back to its own trimmed text, which also resolves to undefined', citation: 'Some Publication', expected: undefined },
    {
      // Story 2.5 (narrowed post-handoff, user-directed): CH/GB dropped from
      // `countryCodeSchema` (FR16/AD-27: only EUR/USD supported) — these
      // domains are still genuinely Swiss/UK official statistics, they just
      // no longer have a country value to resolve to, so this is the exact
      // same "no claim" outcome as any other unmapped domain, not a removal
      // of trustworthiness (unchanged in generate_ideas.ts's own tier list).
      name: 'a Swiss official-statistics domain (no longer mapped) resolves to undefined',
      citation: 'https://www.bfs.admin.ch/report.htm',
      expected: undefined,
    },
    {
      name: 'a UK official-statistics domain (no longer mapped) resolves to undefined',
      citation: 'https://www.ons.gov.uk/report.htm',
      expected: undefined,
    },
  ])('$name', ({ citation, expected }) => {
    expect(classifyCitationRegion(citation)).toBe(expected);
  });
});
