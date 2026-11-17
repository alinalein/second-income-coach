import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { convertMoney, formatMoney, EUR_USD_RATE, type IdeaResponse, type IntakeResponse, type CountryCode } from '@app/shared';
import { IdeasPanel } from './IdeasPanel';

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  });
}

function fakeIdea(): IdeaResponse {
  const now = new Date().toISOString();
  return {
    id: 'idea-1',
    status: 'suggested',
    title: 'Freelance tutoring',
    rationale: 'Fits the time you have free each week.\nStart by listing one lesson type online.',
    citedIntakeFields: ['weeklyTimeAvailability', 'startingBudgetRange', 'riskTolerance'],
    ideaType: 'service',
    weeklyTimeCommitment: '5_to_10h',
    startupCost: { amountMinorUnits: 2500, currencyCode: 'EUR' },
    riskLevel: 'low',
    baselineRateLow: { amountMinorUnits: 3000, currencyCode: 'USD' },
    baselineRateHigh: { amountMinorUnits: 3000, currencyCode: 'USD' },
    isVendorSource: false,
    rateUnit: 'hour',
    baselineRateCitation: 'https://example.com/rates',
    baselineRateQuote: 'Workers in this field earn $30.00 an hour on average.',
    sourceTrustTier: 'tier_3',
    isRateUnverified: false,
    demandEvidenceNote: null,
    demandEvidenceCitation: null,
    demandEvidenceQuote: null,
    isDemandEvidenceUnverified: false,
    growthPath: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Story 2.5: `IdeaEvidence` (mounted inside `IdeaCard`) fetches `GET
 * /api/intake` itself for the viewer's country — every existing
 * `IdeasPanel` test must mock it too, or `mockFetch`'s own "Unmocked fetch"
 * guard throws. `{ intake: null }` is enough for these pre-existing tests,
 * none of which are about country/region labeling. */
const INTAKE_NULL_RESPONSE = { '/api/intake': () => new Response(JSON.stringify({ intake: null }), { status: 200 }) };

function fakeIntake(country: CountryCode): IntakeResponse {
  const now = new Date().toISOString();
  return {
    id: 'intake-1',
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
    country,
    failurePattern: 'overwhelm',
    createdAt: now,
    updatedAt: now,
  };
}

function intakeResponse(country: CountryCode) {
  return { '/api/intake': () => new Response(JSON.stringify({ intake: fakeIntake(country) }), { status: 200 }) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Every other IdeasPanel-touching test mocks /api/ideas with an empty ideas
// array — this is the only coverage of IdeaCard actually rendering a
// populated idea, so it catches a transposed startupCost/baselineRate
// mapping (distinct amounts AND currencies, so a swap can't coincidentally
// render identical text either way).
describe('IdeasPanel (regression: startupCost/baselineRate rendered under the correct label)', () => {
  it('renders each money field next to its own label, not transposed', async () => {
    const idea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);

    // Same locale/target-currency conversion `IdeaCard` itself applies.
    const startupCostText = formatMoney(convertMoney(idea.startupCost, 'EUR'), 'en-US');
    const baselineRateText = formatMoney(convertMoney(idea.baselineRateLow, 'EUR'), 'en-US');
    expect(startupCostText).not.toBe(baselineRateText);

    const startupCostRow = (await screen.findByText('Startup cost')).closest('div');
    const baselineRateRow = (await screen.findByText('Baseline rate')).closest('div');

    expect(startupCostRow).toHaveTextContent(startupCostText);
    expect(startupCostRow).not.toHaveTextContent(baselineRateText);
    expect(startupCostRow).not.toHaveTextContent('estimate'); // same-currency: never marked an estimate

    expect(baselineRateRow).toHaveTextContent(baselineRateText);
    expect(baselineRateRow).not.toHaveTextContent(startupCostText);
    expect(baselineRateRow).toHaveTextContent('estimate'); // USD -> EUR: a genuine conversion

    // Story 2.2 follow-up fix round 2, fix 2 (amended round 4, fix 4d):
    // "potential per month" = weeklyTimeCommitment bucket's own upper bound
    // (5_to_10h -> 10 hours, not the idea's own commitment) x baselineRateLow
    // x 4.3, integer minor units, converted the same way baselineRate
    // itself is — rendered only because this fixture's rateUnit is "hour".
    const expectedMonthlyPotentialMinorUnitsUsd = Math.round(10 * idea.baselineRateLow.amountMinorUnits * 4.3);
    const expectedMonthlyPotentialEur = Math.round(expectedMonthlyPotentialMinorUnitsUsd / EUR_USD_RATE);
    const monthlyPotentialText = formatMoney({ amountMinorUnits: expectedMonthlyPotentialEur, currencyCode: 'EUR' }, 'en-US');
    const monthlyPotentialRow = (await screen.findByText(/Max\. potential per month/)).closest('div');
    expect(monthlyPotentialRow).toHaveTextContent(monthlyPotentialText);
    expect(monthlyPotentialRow).toHaveTextContent('estimate');

    // Story 2.2 follow-up fix round 3, fix 2a: a URL citation renders as a
    // link — visible text is just the hostname, href/title carry the full
    // URL, and it opens safely in a new tab.
    const citationLink = await screen.findByRole('link', { name: 'example.com' });
    expect(citationLink).toHaveAttribute('href', idea.baselineRateCitation);
    expect(citationLink).toHaveAttribute('title', idea.baselineRateCitation);
    expect(citationLink).toHaveAttribute('target', '_blank');
    expect(citationLink).toHaveAttribute('rel', 'noopener noreferrer');

    // Story 2.2 follow-up fix round 6, fix 6: the source-trust tier label
    // renders directly on the card, next to the citation — never behind an
    // expansion. Round 11 (user-requested removal): the quoted evidence
    // sentence no longer renders on the card at all.
    expect(await screen.findByText('independent source')).toBeInTheDocument();
    expect(screen.queryByText(`“${idea.baselineRateQuote}”`)).not.toBeInTheDocument();
    expect(screen.queryByText('unverified')).not.toBeInTheDocument();

    // Story 2.2 follow-up fix round 4, fix 3: the rationale renders as a
    // real list, one <li> per newline-separated bullet line — never as one
    // run-on paragraph.
    const rationaleItems = idea.rationale.split('\n').map((line) => screen.getByText(line));
    for (const item of rationaleItems) {
      expect(item.tagName).toBe('LI');
    }

    // Story 2.5 (I/O matrix: "legacy idea row missing new fields" — this
    // fixture's demand-evidence/growth-path fields are all `null`): the new
    // `IdeaEvidence` block renders nothing extra rather than an empty
    // section or an error.
    expect(screen.queryByText('Current demand')).not.toBeInTheDocument();
    expect(screen.queryByText('How this can grow')).not.toBeInTheDocument();
  });
});

// Story 2.2 follow-up fix round 4, fix 4(c)/(d): a vendor-sourced rate
// renders as a low-high range plus the "source: tool vendor" label, and a
// non-hourly rate omits the monthly-potential row entirely.
describe('IdeasPanel (vendor-sourced range + non-hourly rate)', () => {
  it('renders a range with the vendor label and omits monthly potential for a per-project rate', async () => {
    const idea: IdeaResponse = {
      ...fakeIdea(),
      id: 'idea-2',
      baselineRateLow: { amountMinorUnits: 1500, currencyCode: 'EUR' },
      baselineRateHigh: { amountMinorUnits: 2500, currencyCode: 'EUR' },
      isVendorSource: true,
      rateUnit: 'project',
      sourceTrustTier: 'tier_1',
      isRateUnverified: true,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);

    const baselineRateRow = (await screen.findByText('Baseline rate')).closest('div');
    const lowText = formatMoney(idea.baselineRateLow, 'en-US');
    const highText = formatMoney(idea.baselineRateHigh, 'en-US');
    expect(baselineRateRow).toHaveTextContent(`${lowText}–${highText}`);
    expect(baselineRateRow).toHaveTextContent('source: tool vendor');

    expect(screen.queryByText(/Max\. potential per month/)).not.toBeInTheDocument();

    // Story 2.2 follow-up fix round 6, fix 6: tier 1 still renders its own
    // label, and a tier-3-without-corroboration idea's "unverified" badge
    // shows even when `isVendorSource` is also true — independent flags.
    expect(await screen.findByText('official statistics')).toBeInTheDocument();
    expect(screen.getByText('unverified')).toBeInTheDocument();
  });
});

// Story 2.2 round 13 (user-requested regression fix): the old single
// `'error'` phase picked its message from `ideas.length`, which was wrong
// whenever a *regenerate* failed with ideas already on screen — it showed
// "couldn't load your ideas" instead of a generation-failure message. Load
// succeeds (ideas already present), then the regenerate call itself fails.
describe('IdeasPanel (round 13: a failed regenerate shows the generate-failure message, not the load one)', () => {
  it('shows "generating failed" (not "couldn\'t load") when POST /api/ideas/generate fails with ideas already loaded', async () => {
    const idea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/generate': () => new Response(JSON.stringify({ error: 'Ideas could not be generated' }), { status: 502 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);

    const regenerateButton = await screen.findByRole('button', { name: 'Generate new ideas' });
    fireEvent.click(regenerateButton);

    // Round 14 (user-requested): the progress bar/status/hint render in
    // the same footer as the button that started them, for both the
    // first-generate and regenerate flows — previously this block only
    // rendered above the ideas grid, far from a "Generate new ideas"
    // click. Round 22: within that same footer, the progress block now
    // sits beside the button (same row) instead of underneath it. Round
    // 23: the block is now always mounted (fades via opacity instead of
    // mounting/unmounting) — `role="status"` is still only actually set
    // while `generating`, so `getByRole('status')` still only matches
    // here, not before the click.
    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveTextContent('Generating your ideas…');
    expect(statusRegion).toHaveTextContent('This can take up to a minute.');
    expect(within(statusRegion).getByRole('progressbar')).toBeInTheDocument();

    expect(await screen.findByRole('alert')).toHaveTextContent('Generating your ideas failed or timed out. Please try again.');
    expect(screen.queryByText("We couldn't load your ideas. Please reload the page.")).not.toBeInTheDocument();
    // The failed regenerate never replaced state — the original idea (and
    // the retry button) are still on screen, no reload needed to see them.
    expect(screen.getByText(idea.title)).toBeInTheDocument();
  });
});

// Story 2.5 (AC: demand/trend evidence note + source URL, translated growth
// path, shown directly on the card via the new `IdeaEvidence` component).
describe('IdeasPanel (Story 2.5: demand evidence + growth path)', () => {
  it('renders the demand evidence note, its citation link, and the growth path note', async () => {
    const idea: IdeaResponse = {
      ...fakeIdea(),
      demandEvidenceNote: 'Demand for this kind of tutoring has grown this year.',
      demandEvidenceCitation: 'https://trend.example.com/report',
      demandEvidenceQuote: 'Demand for this kind of tutoring has grown this year.',
      isDemandEvidenceUnverified: false,
      growthPath: 'Raise your rate once you have a few regular clients.',
    };
    vi.stubGlobal('fetch', mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }));

    render(<IdeasPanel />);

    expect(await screen.findByText(idea.demandEvidenceNote!)).toBeInTheDocument();
    const citationLink = await screen.findByRole('link', { name: 'trend.example.com' });
    expect(citationLink).toHaveAttribute('href', idea.demandEvidenceCitation);
    expect(screen.getByText(idea.growthPath!)).toBeInTheDocument();
  });
});

// Story 2.5 (AC: "a source for another region is labeled on the card").
// The reverse case (a matching country, or an unresolvable domain, never
// gets a label) is covered deterministically by `shared/region.test.ts`'s
// `classifyCitationRegion` table — this is the integration proof that a
// foreign, resolvable source actually renders the label end to end.
describe('IdeasPanel (Story 2.5: foreign-source region label)', () => {
  // Review fix (verification-gap #13): the baseline-rate region label
  // (`IdeaEvidence`'s own `baselineRegion`, rendered because the existing
  // citation row in `IdeaCard`'s footer can't be touched) previously had no
  // coverage at all — the prior single test only ever varied
  // `demandEvidenceCitation`, leaving `baselineRateCitation` at `fakeIdea()`'s
  // unmapped default, so the baseline-region branch was dead code as far as
  // verification went. Table-driven: one row per evidence type, each
  // isolating the other evidence type's citation at an unmapped domain so
  // only the row's own badge can appear.
  it.each<{ name: string; overrides: Partial<IdeaResponse>; expectLabel: string }>([
    {
      name: 'a US-domain demand-evidence source is labeled foreign for a German viewer',
      overrides: { demandEvidenceCitation: 'https://www.bls.gov/oes/current/report.htm' },
      expectLabel: 'US data',
    },
    {
      name: 'a US-domain baseline-rate source is labeled foreign for a German viewer',
      overrides: { baselineRateCitation: 'https://www.bls.gov/oes/current/report.htm' },
      expectLabel: 'US data',
    },
  ])('$name', async ({ overrides, expectLabel }) => {
    const idea: IdeaResponse = {
      ...fakeIdea(),
      demandEvidenceNote: 'Demand for this kind of tutoring has grown this year.',
      demandEvidenceCitation: 'https://example.com/rates',
      demandEvidenceQuote: 'Demand for this kind of tutoring has grown this year.',
      isDemandEvidenceUnverified: false,
      growthPath: null,
      ...overrides,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...intakeResponse('DE'), '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    // The demand-evidence label renders in its own standalone `Badge`; the
    // baseline-rate label renders inline as "Baseline rate: {label}" in one
    // paragraph (since the existing citation row can't be touched) — a
    // substring match (`exact: false`) covers both shapes.
    expect(await screen.findByText(expectLabel, { exact: false })).toBeInTheDocument();
  });
});
