import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import {
  convertMoney,
  formatMoney,
  EUR_USD_RATE,
  type IdeaResponse,
  type IdeaWithPlanResponse,
  type IntakeResponse,
  type CountryCode,
} from '@app/shared';
import { IdeasPanel } from './IdeasPanel';
import i18n from '../../i18n';

// Story 2.7: widened to also accept a function returning a `Promise<Response>`
// (not just a synchronous one) — `IdeasPanel.test.tsx`'s own translate tests
// need an entry that's a `vi.fn()` mock returning a still-pending/deferred
// promise, which `Promise.resolve(...)` below already handles correctly at
// runtime either way.
function mockFetch(responses: Record<string, Response | (() => Response | Promise<Response>)>) {
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
    language: 'en',
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
  void i18n.changeLanguage('en');
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
      mockFetch({ ...INTAKE_NULL_RESPONSE,
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
    expect(startupCostRow).not.toHaveTextContent('est.'); // same-currency: never marked an estimate

    expect(baselineRateRow).toHaveTextContent(baselineRateText);
    expect(baselineRateRow).not.toHaveTextContent(startupCostText);
    expect(baselineRateRow).toHaveTextContent('est.'); // USD -> EUR: a genuine conversion
    // Story 2.3 Fix2: the amount and the compact rate-unit suffix are glued
    // together with no space (English's hourly suffix is "/h") — the same
    // compact shape Fix2's own German test exercises, pinned here for
    // English too.
    expect(baselineRateRow).toHaveTextContent(`${baselineRateText}/h`);

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
    expect(monthlyPotentialRow).toHaveTextContent('est.');
    // Bug fix (user-reported): English's intentionally-empty sub-label must
    // never render as the literal, untranslated key path.
    expect(monthlyPotentialRow).not.toHaveTextContent('card.monthlyPotentialSubLabel');

    // User-requested follow-up: the cited-fields summary moved from the
    // always-visible row into the collapsed panel itself (above the
    // chips), alongside the citation/source-trust tier — closed by default.
    // It's present in the DOM (`hidden`, not unmounted — `getByText` alone
    // doesn't respect that attribute, `toBeVisible()` does) but not visible
    // until the toggle opens.
    expect(await screen.findByText('Based on 3 of your inputs')).not.toBeVisible();
    expect(screen.queryByRole('link', { name: 'example.com' })).not.toBeInTheDocument();
    // Review fix: the toggle's accessible name carries the idea's own title
    // (`aria-label`, not just the visible "Details" text) so every card's
    // toggle isn't indistinguishable from its siblings — assert the exact
    // name, not a loose match that the old shared name would also satisfy.
    fireEvent.click(await screen.findByRole('button', { name: `Details – ${idea.title}` }));
    expect(screen.getByText('Based on 3 of your inputs')).toBeVisible();

    // Story 2.2 follow-up fix round 3, fix 2a: a URL citation renders as a
    // link — visible text is just the hostname, href/title carry the full
    // URL, and it opens safely in a new tab.
    const citationLink = await screen.findByRole('link', { name: 'example.com' });
    expect(citationLink).toHaveAttribute('href', idea.baselineRateCitation);
    expect(citationLink).toHaveAttribute('title', idea.baselineRateCitation);
    expect(citationLink).toHaveAttribute('target', '_blank');
    expect(citationLink).toHaveAttribute('rel', 'noopener noreferrer');

    // Round 11 (user-requested removal): the quoted evidence sentence no
    // longer renders on the card at all. User-requested follow-up (compact
    // citation line): the source-trust tier *phrase* ("independent
    // source"/"pay-data provider") no longer renders either — only the
    // citation, an optional region label, and "unverified" share that one
    // line now (the tier mechanism itself is unaffected server-side).
    expect(screen.queryByText(`“${idea.baselineRateQuote}”`)).not.toBeInTheDocument();
    expect(screen.queryByText('independent source')).not.toBeInTheDocument();
    expect(screen.queryByText('unverified')).not.toBeInTheDocument();

    // Review fix: the cited-intake chips (now behind the same toggle) still
    // render their translated labels, not just the citation/trust tier —
    // `fakeIdea()`'s own 3 fields, asserted by their known English text.
    expect(screen.getByText('Your weekly time')).toBeInTheDocument();
    expect(screen.getByText('Your starting budget')).toBeInTheDocument();
    expect(screen.getByText('Your risk comfort')).toBeInTheDocument();

    // Story 2.2 follow-up fix round 4, fix 3: the rationale renders as a
    // real list, one <li> per newline-separated bullet line — never as one
    // run-on paragraph.
    const rationaleItems = idea.rationale.split('\n').map((line) => screen.getByText(line));
    for (const item of rationaleItems) {
      expect(item.tagName).toBe('LI');
    }
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
      mockFetch({ ...INTAKE_NULL_RESPONSE,
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

    // Layout fix (progressive disclosure): the trust tier and "unverified"
    // text are collapsed under the "Details" toggle, closed by default —
    // not reachable via role until opened.
    expect(screen.queryByRole('link', { name: 'example.com' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: `Details – ${idea.title}` }));

    // Story 2.2 follow-up fix round 6, fix 6: an unverified idea's
    // "unverified" text shows even when `isVendorSource` is also true —
    // independent flags. Layout fix: "unverified" is plain muted text next
    // to its source, sharing a text node with a "," separator — hence the
    // regex. User-requested follow-up (compact citation line): the
    // source-trust tier *phrase* ("official statistics") no longer renders
    // on this line at all (the tier mechanism itself is unaffected
    // server-side).
    expect(await screen.findByText(/unverified/)).toBeInTheDocument();
    expect(screen.queryByText('official statistics')).not.toBeInTheDocument();
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
      mockFetch({ ...INTAKE_NULL_RESPONSE,
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

// Story 2.11 AC5/AC6: a 429 from POST /generate is a plain limit notice —
// never worded like an error, button disabled afterwards, existing ideas
// stay fully usable.
describe('IdeasPanel (Story 2.11: generate limit reached)', () => {
  it.each([
    {
      reason: 'user_limit' as const,
      body: { error: 'limit_reached', reason: 'user_limit', limit: 5, resetsAt: '2099-01-02T00:00:00.000Z' },
      expectedText: /reached today's limit of 5 idea generations/i,
    },
    {
      reason: 'shared_budget' as const,
      body: { error: 'limit_reached', reason: 'shared_budget', limit: null, resetsAt: '2099-01-02T00:00:00.000Z' },
      expectedText: "Today's shared search budget of the app is used up. New ideas are available again tomorrow.",
    },
  ])('shows the $reason message (never role="alert") and disables the button after a 429', async ({ body, expectedText }) => {
    const idea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/generate': () => new Response(JSON.stringify(body), { status: 429 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);

    const regenerateButton = await screen.findByRole('button', { name: 'Generate new ideas' });
    fireEvent.click(regenerateButton);

    // Wait for the request to settle (past the "generating" progress state,
    // which also briefly renders its own `role="status"`) before asserting
    // on the limit notice itself.
    await waitFor(() => expect(regenerateButton).toBeDisabled());

    const notice = await screen.findByText(expectedText);
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Existing ideas stay fully usable — never replaced by the 429.
    expect(screen.getByText(idea.title)).toBeInTheDocument();
  });

  // AC5: disabled *before* the user ever clicks, straight from GET /'s own
  // `generateLimit` — the server enforces this, the UI is only a
  // convenience that reflects it.
  it('disables the generate button on initial load when GET / already reports generateLimit.blocked', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () =>
          new Response(
            JSON.stringify({ ideas: [], currency: 'EUR', generateLimit: { blocked: true, reason: 'shared_budget', limit: null, resetsAt: '2099-01-02T00:00:00.000Z' } }),
            { status: 200 },
          ),
      }),
    );

    render(<IdeasPanel />);

    const generateButton = await screen.findByRole('button', { name: 'Generate my ideas' });
    expect(generateButton).toBeDisabled();
    expect(screen.getByText("Today's shared search budget of the app is used up. New ideas are available again tomorrow.")).toBeInTheDocument();
  });
});

// Story 2.3 AC2: Select/Bookmark/Reject render directly on every card (never
// behind a menu), with a status badge once the idea has left `suggested`,
// and the action matching the card's current status renders as primary.
describe('IdeasPanel (AC2: status badge + action buttons on the card)', () => {
  it.each([
    { status: 'suggested' as const, primaryName: null as string | null },
    { status: 'selected' as const, primaryName: 'Select' },
    { status: 'bookmarked' as const, primaryName: 'Bookmark' },
  ])('status "$status": all 3 actions render, with $primaryName as the primary one', async ({ status, primaryName }) => {
    const idea: IdeaResponse = { ...fakeIdea(), status };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    const buttons: Record<string, HTMLElement> = {
      Select: await screen.findByRole('button', { name: 'Select' }),
      Bookmark: screen.getByRole('button', { name: 'Bookmark' }),
      Reject: screen.getByRole('button', { name: 'Reject' }),
    };
    for (const [name, button] of Object.entries(buttons)) {
      expect(button.className.includes('bg-primary')).toBe(name === primaryName);
    }

    if (status === 'suggested') {
      expect(screen.queryByText('selected')).not.toBeInTheDocument();
      expect(screen.queryByText('bookmarked')).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText(status)).toBeInTheDocument();
    }
  });
});

// Story 2.8 AC5 (supersedes Story 3.1's `selected`/`bookmarked` rule): "View
// plan" shows only for the `selected` idea's card, and only once it
// actually has a plan (`hasPlan`) — never for `bookmarked`/`suggested`/
// `rejected`, and never for a `selected` idea with no plan yet (I/O matrix:
// "Card hasPlan rendering").
describe('IdeasPanel (Story 2.8 AC5: hasPlan-gated View plan action)', () => {
  it.each<{ label: string; status: IdeaResponse['status']; hasPlan: boolean; shows: boolean }>([
    { label: 'selected with a plan', status: 'selected', hasPlan: true, shows: true },
    { label: 'selected with no plan yet', status: 'selected', hasPlan: false, shows: false },
    { label: 'bookmarked', status: 'bookmarked', hasPlan: true, shows: false },
    { label: 'still suggested', status: 'suggested', hasPlan: false, shows: false },
  ])('$label: View plan shows=$shows', async ({ status, hasPlan, shows }) => {
    const idea: IdeaWithPlanResponse = { ...fakeIdea(), status, hasPlan };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );
    const onViewPlan = vi.fn();

    render(<IdeasPanel onViewPlan={onViewPlan} />);
    await screen.findByText(idea.title);

    const viewPlanButton = screen.queryByRole('button', { name: 'View plan' });
    if (shows) {
      expect(viewPlanButton).toBeInTheDocument();
      fireEvent.click(viewPlanButton!);
      expect(onViewPlan).toHaveBeenCalledExactlyOnceWith(idea.id, idea.title);
    } else {
      expect(viewPlanButton).not.toBeInTheDocument();
    }
  });
});

// Story 2.8 AC2/AC6: a short instruction line under the heading once ideas
// exist; no blank band is left when there's nothing to act on yet.
describe('IdeasPanel (Story 2.8 AC2/AC6: explanation line)', () => {
  it('shows the explanation once ideas are loaded', async () => {
    const idea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    expect(
      await screen.findByText("Choose one idea to turn into a plan, reject the ones that aren't for you, or generate a new batch."),
    ).toBeInTheDocument();
  });

  it('renders no explanation text while idle with no ideas yet', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    await screen.findByText("You don't have any ideas yet — let's generate your first batch.");
    expect(screen.queryByText(/Choose one idea/)).not.toBeInTheDocument();
  });
});

// Story 2.8 AC3/AC4: "Select" opens a confirm dialog instead of writing the
// status directly — confirm runs the same status write and navigates;
// cancel changes nothing; a failed write never navigates.
describe('IdeasPanel (Story 2.8 AC3/AC4: select confirm dialog)', () => {
  it('confirm: sets the idea selected, then navigates via onViewPlan', async () => {
    const idea: IdeaWithPlanResponse = { ...fakeIdea(), status: 'suggested', hasPlan: false };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/idea-1/status': () => new Response(null, { status: 204 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );
    const onViewPlan = vi.fn();

    render(<IdeasPanel onViewPlan={onViewPlan} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));

    expect(await screen.findByText('Make this your plan?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, select this idea' }));

    expect(await screen.findByText('selected')).toBeInTheDocument();
    await waitFor(() => expect(onViewPlan).toHaveBeenCalledExactlyOnceWith(idea.id, idea.title));
  });

  it('cancel: closes the dialog with no status call and no navigation', async () => {
    const idea: IdeaWithPlanResponse = { ...fakeIdea(), status: 'suggested', hasPlan: false };
    const fetchMock = mockFetch({
      ...INTAKE_NULL_RESPONSE,
      '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onViewPlan = vi.fn();

    render(<IdeasPanel onViewPlan={onViewPlan} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Make this your plan?')).not.toBeInTheDocument();
    expect(screen.queryByText('selected')).not.toBeInTheDocument();
    expect(onViewPlan).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ideas/idea-1/status', expect.anything());
  });

  it('confirm, status write fails: no navigation, idea reverts, and Select stays available to retry', async () => {
    const idea: IdeaWithPlanResponse = { ...fakeIdea(), status: 'suggested', hasPlan: false };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/idea-1/status': () => new Response(JSON.stringify({ error: 'Idea not found' }), { status: 404 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );
    const onViewPlan = vi.fn();

    render(<IdeasPanel onViewPlan={onViewPlan} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, select this idea' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't save. Please try again.");
    expect(onViewPlan).not.toHaveBeenCalled();
    expect(screen.queryByText('selected')).not.toBeInTheDocument();

    // "Select" is still there (never swapped for a different control) — the
    // one documented way to retry a plan-creation failure from the card.
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    expect(await screen.findByText('Make this your plan?')).toBeInTheDocument();
  });
});

// Story 2.3 AC1/AC2: clicking an action updates the card's own status
// immediately (optimistic — never waits on the response) and sends the new
// status to the server.
describe('IdeasPanel (AC1/AC2: optimistic status update)', () => {
  // Story 2.8 AC3: "Select" itself only opens the confirm dialog — the
  // optimistic update/POST this test covers now happens on the dialog's
  // own confirm click, not on the initial "Select" click.
  it('shows the new status badge immediately and POSTs the new status, once the select dialog is confirmed', async () => {
    const idea: IdeaResponse = { ...fakeIdea(), status: 'suggested' };
    const fetchMock = mockFetch({ ...INTAKE_NULL_RESPONSE,
      '/api/ideas/idea-1/status': () => new Response(null, { status: 204 }),
      '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdeasPanel />);
    const selectButton = await screen.findByRole('button', { name: 'Select' });
    fireEvent.click(selectButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, select this idea' }));

    expect(await screen.findByText('selected')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ideas/idea-1/status',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'selected' }) }),
    );
  });
});

// Story 2.3 AC2: clicking Bookmark directly on a `suggested` idea — not as a
// side effect of selecting a *different* idea (already covered by the
// optimistic-update test above) — marks that one idea `bookmarked` with no
// demote sweep involved.
describe('IdeasPanel (AC2: direct Bookmark on a suggested idea)', () => {
  it('marks the idea bookmarked and makes Bookmark the primary action', async () => {
    const idea: IdeaResponse = { ...fakeIdea(), status: 'suggested' };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE,
        '/api/ideas/idea-1/status': () => new Response(null, { status: 204 }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);
    const bookmarkButton = await screen.findByRole('button', { name: 'Bookmark' });
    fireEvent.click(bookmarkButton);

    expect(await screen.findByText('bookmarked')).toBeInTheDocument();
    expect(bookmarkButton.className).toContain('bg-primary');
  });
});

// Story 2.3 AC3/AC5 (client side): a failed status-change request reverts
// the optimistic change via the pre-change snapshot and surfaces
// `error.statusUpdateFailed` — the card's prior state (and the rejected
// idea's own continued visibility) is never left looking "persisted" when
// it wasn't. Covers both ways the request can fail: a non-ok response, and
// `fetch` itself throwing (e.g. a network failure).
describe('IdeasPanel (revert-on-failure)', () => {
  it.each([
    {
      label: 'a non-ok response',
      // Real `fetch` behavior: a non-ok HTTP response still *resolves*
      // the promise — `handleSetIdeaStatus`'s own `!res.ok` branch.
      statusCall: () => Promise.resolve(new Response(JSON.stringify({ error: 'Idea not found' }), { status: 404 })),
    },
    {
      label: 'fetch itself throwing (network failure)',
      // Real `fetch` behavior: a network failure *rejects* the promise
      // (it never throws synchronously) — the `.catch` branch.
      statusCall: () => Promise.reject(new Error('network error')),
    },
  ])('reverts a rejected idea back into view and shows the status-update error for $label', async ({ statusCall }) => {
    const idea: IdeaResponse = { ...fakeIdea(), status: 'bookmarked' };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/status')) return statusCall();
        if (url.includes('/api/intake')) return Promise.resolve(new Response(JSON.stringify({ intake: null }), { status: 200 }));
        if (url.includes('/api/ideas')) {
          return Promise.resolve(new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }));
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    render(<IdeasPanel />);
    const rejectButton = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(rejectButton);

    // Optimistic: the card disappears the instant Reject is clicked, before
    // the (failing) response has resolved.
    expect(screen.queryByText(idea.title)).not.toBeInTheDocument();

    // Reverted once the request fails — the card is back, and the failure
    // is surfaced.
    expect(await screen.findByText(idea.title)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't save. Please try again.");
  });
});

// Reviewer fix: every card's 3 actions must disable while *any* status
// request is in flight, not just the clicked card's own — otherwise a
// second concurrent request could race the first's transaction (lock-order-
// inversion deadlock risk) and its failure-revert could stomp a change the
// first request already applied.
describe('IdeasPanel (status actions disable panel-wide while a request is in flight)', () => {
  it("disables a different card's own buttons while the first card's request is pending", async () => {
    const ideaA: IdeaResponse = { ...fakeIdea(), id: 'idea-1', status: 'suggested' };
    const ideaB: IdeaResponse = { ...fakeIdea(), id: 'idea-2', status: 'suggested' };

    let resolveStatusFetch!: (value: Response) => void;
    const pendingStatusResponse = new Promise<Response>((resolve) => {
      resolveStatusFetch = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (init?.method === 'POST' && url.includes('/status')) return pendingStatusResponse;
        if (url.includes('/api/intake')) return Promise.resolve(new Response(JSON.stringify({ intake: null }), { status: 200 }));
        if (url.includes('/api/ideas')) {
          return Promise.resolve(new Response(JSON.stringify({ ideas: [ideaA, ideaB], currency: 'EUR' }), { status: 200 }));
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    render(<IdeasPanel />);
    const selectButtons = await screen.findAllByRole('button', { name: 'Select' });
    expect(selectButtons).toHaveLength(2);

    fireEvent.click(selectButtons[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, select this idea' }));

    // Both cards' buttons are disabled, not just the clicked (ideaA) card's
    // own — ideaB's are a different card entirely.
    expect(selectButtons[0]).toBeDisabled();
    expect(selectButtons[1]).toBeDisabled();

    resolveStatusFetch(new Response(null, { status: 204 }));
    await waitFor(() => expect(selectButtons[1]).not.toBeDisabled());
  });

  // User-reported bug fix: selecting an idea must not disable (and so must
  // not visibly flicker) a sibling that's already `bookmarked` — it has
  // nothing to change, so it was never genuinely part of this request.
  it('never disables an already-bookmarked sibling while selecting a different idea', async () => {
    const ideaA: IdeaResponse = { ...fakeIdea(), id: 'idea-1', status: 'suggested' };
    const ideaB: IdeaResponse = { ...fakeIdea(), id: 'idea-2', status: 'bookmarked' };

    let resolveStatusFetch!: (value: Response) => void;
    const pendingStatusResponse = new Promise<Response>((resolve) => {
      resolveStatusFetch = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (init?.method === 'POST' && url.includes('/status')) return pendingStatusResponse;
        if (url.includes('/api/intake')) return Promise.resolve(new Response(JSON.stringify({ intake: null }), { status: 200 }));
        if (url.includes('/api/ideas')) {
          return Promise.resolve(new Response(JSON.stringify({ ideas: [ideaA, ideaB], currency: 'EUR' }), { status: 200 }));
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    render(<IdeasPanel />);
    // Every card renders all 3 actions, so both cards have their own
    // "Select"/"Bookmark" button — index by render order (ideaA, then
    // ideaB) to target each card's own.
    const selectButtonA = (await screen.findAllByRole('button', { name: 'Select' }))[0]!;
    const bookmarkButtonB = (await screen.findAllByRole('button', { name: 'Bookmark' }))[1]!;

    fireEvent.click(selectButtonA);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, select this idea' }));

    expect(selectButtonA).toBeDisabled(); // the target of this action
    expect(bookmarkButtonB).not.toBeDisabled(); // already bookmarked — nothing to change, never pending

    resolveStatusFetch(new Response(null, { status: 204 }));
    await waitFor(() => expect(selectButtonA).not.toBeDisabled());
  });
});

// Story 2.3 Fix1: a fixed-height neutral skeleton while the first GET
// /api/ideas is pending — never the "no ideas yet" empty-state text, which
// only belongs to the genuinely-idle-and-empty case.
describe('IdeasPanel (Fix1: loading skeleton, never the empty state)', () => {
  it('announces loading via role="status" and shows a skeleton, not the empty-state text', async () => {
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    // Story 2.6 AC5: `useViewerCountry()` is now called once at the panel
    // level (lifted out of `IdeaCard`), so it fires its own `/api/intake`
    // fetch even while `/api/ideas` is still pending with zero cards —
    // needs its own mocked response, same `INTAKE_NULL_RESPONSE` pattern
    // every other test in this file already uses.
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () => pending,
      }),
    );

    render(<IdeasPanel />);

    expect(screen.queryByText("You don't have any ideas yet — let's generate your first batch.")).not.toBeInTheDocument();
    // Reviewer fix: the wrapper is `role="status"` with a visually-hidden
    // `t('loading')` text, so a screen reader still gets the same
    // announcement the old plain-text line gave it — the pulsing boxes
    // themselves stay decorative/`aria-hidden`.
    const statusRegion = screen.getByRole('status');
    expect(within(statusRegion).getByText('Loading…')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).not.toBeNull();

    resolveFetch(new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }));
    expect(await screen.findByText("You don't have any ideas yet — let's generate your first batch.")).toBeInTheDocument();
  });
});

// Story 2.3 Fix2: the compact "<amount> <suffix>" rate line (no space), and
// the shortened German weekly-time/monthly-potential labels with the budget
// caveat as separate small text. Fixed-width label columns stay the same
// class in both languages. Layout fix: the estimate badge is inline beside
// the value (not under the label); also covers German progressive-
// disclosure copy (`citedFieldsSummary`/`detailsToggle`) and the Details
// panel's content, since the other German test (Fix2) is this file's only
// German-locale coverage.
describe('IdeasPanel (Fix2: German compact rate + shortened labels)', () => {
  it('renders "<amount> €/Std." and the shortened labels with the caveat as separate text', async () => {
    void i18n.changeLanguage('de');
    const idea: IdeaResponse = {
      ...fakeIdea(),
      baselineRateLow: { amountMinorUnits: 2334, currencyCode: 'EUR' },
      baselineRateHigh: { amountMinorUnits: 2334, currencyCode: 'EUR' },
      rateUnit: 'hour',
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    const baselineRateLabel = await screen.findByText('Referenzsatz');
    const baselineRateRow = baselineRateLabel.closest('div');
    expect(baselineRateRow).toHaveTextContent('23,34 €/Std.');
    // Same-currency (EUR -> EUR): never marked an estimate.
    expect(baselineRateRow).not.toHaveTextContent('ca.');
    // The fixed-width class lives on the label cell (the text's own parent
    // span), same as every other row's label — not on the bare text node.
    expect(baselineRateLabel.parentElement?.className).toContain('w-36');

    expect(screen.getByText('Zeit pro Woche')).toBeInTheDocument();
    const monthlyPotentialLabel = await screen.findByText('Max. pro Monat');
    const monthlyPotentialRow = monthlyPotentialLabel.closest('div');
    expect(screen.getByText('(bei vollem Zeitbudget)')).toBeInTheDocument();
    expect(monthlyPotentialRow).toHaveTextContent('ca.');

    // Layout fix (progressive disclosure), German: the always-visible
    // summary renders translated and the Details toggle (its accessible
    // name carries the idea's own title) opens the panel — covers the one
    // new-copy path this file's only other German test doesn't touch.
    // ("Closed by default" itself is already covered, locale-independently,
    // by the two English tests above.)
    expect(await screen.findByText('Basierend auf 3 deiner Angaben')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: `Details – ${idea.title}` }));
    // User-requested follow-up (compact citation line): the source-trust
    // tier phrase no longer renders here — the citation link does.
    expect(await screen.findByRole('link', { name: 'example.com' })).toBeInTheDocument();
    expect(screen.getByText('Deine wöchentliche Zeit')).toBeInTheDocument();
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

    // User-requested follow-up: the always-visible toggle-row teaser says
    // "Current demand" (not the old cited-fields count) whenever this idea
    // actually has demand evidence.
    expect(await screen.findByText('Current demand')).toBeVisible();

    // Evidence lives in the card's collapsed "Details" panel (card layout).
    fireEvent.click(await screen.findByRole('button', { name: /details/i }));
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
    fireEvent.click(await screen.findByRole('button', { name: `Details – ${idea.title}` }));

    // The demand-evidence label renders in its own standalone `Badge`; the
    // baseline-rate label (user-requested follow-up) renders inline in the
    // compact citation line instead — a substring match (`exact: false`)
    // covers both shapes.
    expect(await screen.findByText(expectLabel, { exact: false })).toBeInTheDocument();
  });
});

// Story 2.7 (AC1/AC2): a stored-language card translates once on a UI
// language switch (loading state, no mixed-language flash, atomic swap),
// and a later switch back to an already-cached language never re-calls the
// model (I/O matrix: "Toggle back and forth" -> "2nd+ switch instant").
describe('IdeasPanel (Story 2.7: translate idea cards on language change)', () => {
  it('translates once with a loading state and no stale/mixed text, then serves a repeat switch from cache', async () => {
    const idea = fakeIdea(); // language: 'en'
    let resolveTranslate!: (value: Response) => void;
    const pendingTranslate = new Promise<Response>((resolve) => {
      resolveTranslate = resolve;
    });
    const translateFetch = vi.fn(() => pendingTranslate);

    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/translate': translateFetch,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);
    expect(await screen.findByText(idea.title)).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('de');
    });

    // Still the stored-language title — no flash, no blank card — plus the
    // localized loading notice, while the request is still in flight.
    expect(screen.getByText('Deine Ideen werden übersetzt…')).toBeInTheDocument();
    expect(screen.getByText(idea.title)).toBeInTheDocument();

    resolveTranslate(
      new Response(
        JSON.stringify({
          translations: [{ ideaId: idea.id, language: 'de', title: 'DE Titel', rationale: 'Zeile 1.\nZeile 2.', demandEvidenceNote: null, growthPath: null }],
        }),
        { status: 200 },
      ),
    );

    expect(await screen.findByText('DE Titel')).toBeInTheDocument();
    expect(screen.queryByText(idea.title)).not.toBeInTheDocument();
    expect(translateFetch).toHaveBeenCalledTimes(1);

    // Switching back needs no call — the original idea already has this
    // language's text (its own stored language).
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(await screen.findByText(idea.title)).toBeInTheDocument();
    expect(translateFetch).toHaveBeenCalledTimes(1);

    // Switching to German a second time reads the client-side cache —
    // never a second model call.
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(await screen.findByText('DE Titel')).toBeInTheDocument();
    expect(translateFetch).toHaveBeenCalledTimes(1);
  });

  // I/O matrix: "Timeout/abort/moderation-reject -> stays stored-language,
  // notice + retry" — never blank. Story 2.6 AC5: the background
  // other-language prefetch effect this test used to also exercise was
  // removed (Code Map) — there is now no call at all until the UI language
  // actually mismatches a card's stored language.
  it('shows a neutral notice with a working retry on translate failure, keeping the stored-language text', async () => {
    const idea = fakeIdea();
    const translateFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Translation failed' }), { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            translations: [{ ideaId: idea.id, language: 'de', title: 'DE Titel', rationale: 'Zeile 1.\nZeile 2.', demandEvidenceNote: null, growthPath: null }],
          }),
          { status: 200 },
        ),
      );

    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/translate': translateFetch,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);
    expect(await screen.findByText(idea.title)).toBeInTheDocument();

    // Story 2.6 AC5/I-O matrix row 3: the UI language still matches the
    // card's own stored language — no translate call at all, no prefetch
    // for the untouched other language either.
    expect(translateFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('de');
    });

    // Switching to German is the first real attempt — fails here, and the
    // user sees the notice immediately (no earlier silent prefetch attempt
    // to have already failed first).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Deine Ideen konnten nicht übersetzt werden. Sie werden weiterhin in der ursprünglichen Sprache angezeigt.",
    );
    expect(screen.getByText(idea.title)).toBeInTheDocument(); // never blank
    expect(translateFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Übersetzung erneut versuchen' }));

    expect(await screen.findByText('DE Titel')).toBeInTheDocument();
    expect(translateFetch).toHaveBeenCalledTimes(2);
  });
});
