import { z } from 'zod';

/**
 * Story 2.5 (narrowed post-handoff, user-directed): the intake form's
 * `country` field. Limited to `DE`/`AT`/`US`/`other` — `CH` and `GB` were
 * dropped because FR16/AD-27 limit supported currencies to EUR/USD only,
 * and Switzerland/the UK use CHF/GBP, neither of which this codebase can
 * represent or convert (`shared/money.ts`'s `currencyCodeSchema`). A CH/GB
 * user picks `'other'` — the same "no regional preference" outcome a
 * genuinely-unmapped country already gets. `'other'` itself means no
 * regional preference/label; every remaining value corresponds to a domain
 * in `REGION_DOMAINS` below.
 */
export const countryCodeSchema = z.enum(['DE', 'AT', 'US', 'other']);

export type CountryCode = z.infer<typeof countryCodeSchema>;

/**
 * Domains a citation's hostname can be deterministically attributed to one
 * region for — intentionally conservative: a domain is listed here only
 * when it is clearly and exclusively tied to one country (official
 * statistics agencies, or a pay-data site whose own data is predominantly
 * US-sourced). Ambiguous/global domains (e.g. `indeed.com`, `kununu.com`)
 * are deliberately left unmapped — `classifyCitationRegion` returns
 * `undefined` for them, so the UI shows no region claim rather than a
 * guessed one. `bfs.admin.ch`/`ons.gov.uk` are deliberately *not* listed
 * here any more (narrowed alongside `countryCodeSchema` above) — they can
 * still be genuinely trustworthy baseline-rate *sources* (unchanged in
 * `generate_ideas.ts`'s own tier-1 trust list, a separate concern from
 * regional preference), they just no longer resolve to a region label
 * since there is no longer a `CH`/`GB` country value to compare against.
 */
const REGION_DOMAINS: Record<Exclude<CountryCode, 'other'>, readonly string[]> = {
  DE: ['destatis.de', 'bundesagentur.de', 'arbeitsagentur.de', 'stepstone.de'],
  AT: ['statistik.at'],
  US: ['bls.gov', 'dol.gov', 'payscale.com', 'salary.com', 'levels.fyi', 'ziprecruiter.com'],
};

/** Same hostname normalization as `generate_ideas.ts`'s own
 * `extractCitationDomain` (not imported from there — this is a plain-code
 * module shared by both the backend prompt-builder and the frontend card,
 * which `src/tools/llm/generate_ideas.ts` is not). */
function extractHostname(citation: string): string {
  try {
    return new URL(citation).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return citation.trim().toLowerCase();
  }
}

/**
 * Deterministic, citation-only region classification (AC: "a source for
 * another region is labeled on the card"). Never persisted — derived fresh
 * from the already-stored citation URL wherever it's needed (the nested
 * agent's prompt-building, and `IdeaEvidence.tsx`'s region badge), so there
 * is exactly one source of truth for the domain->region mapping.
 */
export function classifyCitationRegion(citation: string): CountryCode | undefined {
  const hostname = extractHostname(citation);
  for (const [region, domains] of Object.entries(REGION_DOMAINS) as [Exclude<CountryCode, 'other'>, readonly string[]][]) {
    if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return region;
    }
  }
  return undefined;
}
