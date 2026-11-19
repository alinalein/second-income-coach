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
// UX fix (user-reported): the "Generate new ideas" button moved back onto
// this page (bottom of the card, below the cards) — these tests trigger a
// generation by clicking it directly again.
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
    await screen.findByText(idea.title);
    fireEvent.click(screen.getByRole('button', { name: 'Generate new ideas' }));

    // Round 14/22/23: the progress bar/status/hint block is always mounted
    // and fades via opacity — `role="status"` is still only actually set
    // while `generating`, so `getByRole('status')` still only matches here,
    // not before the click.
    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveTextContent('Generating your ideas…');
    expect(statusRegion).toHaveTextContent('This can take up to a minute.');
    expect(within(statusRegion).getByRole('progressbar')).toBeInTheDocument();

    expect(await screen.findByRole('alert')).toHaveTextContent('Generating your ideas failed or timed out. Please try again.');
    expect(screen.queryByText("We couldn't load your ideas. Please reload the page.")).not.toBeInTheDocument();
    // The failed regenerate never replaced state — the original idea is
    // still on screen, no reload needed to see it.
    expect(screen.getByText(idea.title)).toBeInTheDocument();
  });
});

// Story 2.6 (bug fix): the bar used to jump to 100% and get replaced by the
// new ideas in the same render, so it never visibly finished. Now the bar
// reaches 100% first, and only after a short reveal delay do the new ideas
// replace the view.
describe('IdeasPanel (Story 2.6: progress bar reaches 100% before the new ideas replace the view)', () => {
  it('shows the bar at 100% before the newly generated idea appears', async () => {
    const newIdea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        // `mockFetch` matches by `url.includes(key)`, so the more specific
        // `/api/ideas/generate` key must come before the plain `/api/ideas`
        // one — otherwise the POST to `/generate` would match the GET
        // handler first, since `/api/ideas/generate` also contains
        // `/api/ideas` as a substring.
        '/api/ideas/generate': () =>
          new Response(
            JSON.stringify({ ideas: [newIdea], currency: 'EUR', generateLimit: { blocked: false, reason: null, limit: null, resetsAt: null } }),
            { status: 200 },
          ),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);

    const generateButton = await screen.findByRole('button', { name: 'Generate my ideas' });
    fireEvent.click(generateButton);

    const progressBar = within(screen.getByRole('status')).getByRole('progressbar');
    await waitFor(() => expect(progressBar).toHaveAttribute('aria-valuenow', '100'));
    // The bar is at 100%, but the reveal delay hasn't elapsed yet — the new
    // idea must not be on screen.
    expect(screen.queryByText(newIdea.title)).not.toBeInTheDocument();

    expect(await screen.findByText(newIdea.title)).toBeInTheDocument();
  });
});

// Spec 2.12 AC1: on the auto-generate path (fired right after a user's
// first-ever intake save), the very first paint must already show the
// disabled "Generating…" button and a visible, 0%-started progress bar with
// the classify stage text — never a frame with an idle, enabled "Generate"
// button first (the bug this story fixes).
describe('IdeasPanel (Spec 2.12 AC1: auto-generate mount has no idle frame)', () => {
  it('shows the disabled button and the classify stage text from first paint, with no idle frame', async () => {
    const newIdea = fakeIdea();
    const fetchMock = mockFetch({
      ...INTAKE_NULL_RESPONSE,
      '/api/ideas/generate': () =>
        new Response(
          JSON.stringify({ ideas: [newIdea], currency: 'EUR', generateLimit: { blocked: false, reason: null, limit: null, resetsAt: null } }),
          { status: 200 },
        ),
      '/api/ideas': () => new Response(JSON.stringify({ ideas: [], currency: 'EUR' }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdeasPanel autoGenerate />);

    // Synchronous, first-paint assertions — no idle/enabled frame ever
    // exists for React to flush before this. Bug fix (user-reported, live):
    // the generating state is now a blocking modal (same pattern as
    // `PlanWorkspace.tsx`'s own plan-creation dialog) — Radix marks the
    // page content behind it `aria-hidden`, including this button, so it's
    // queried with `{ hidden: true }` (include elements outside the
    // accessibility tree) rather than asserting it's accessible right now;
    // it genuinely isn't, by design, while the modal is open.
    const generateButton = screen.getByRole('button', { name: 'Generating…', hidden: true });
    expect(generateButton).toBeDisabled();
    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveTextContent('Reviewing your answers…');
    expect(within(statusRegion).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    // The one unbroken timer carries the request through to completion —
    // the newly generated idea replaces the view once it settles.
    expect(await screen.findByText(newIdea.title)).toBeInTheDocument();
  });
});

// Story 2.11 regression (review fix): this story's own mount-only-effect
// simplification for AC1 must not drop the pre-existing "never auto-fire
// into a known-blocked limit" rule (e.g. the shared search budget other
// users already exhausted) — it still shows the generating UI from first
// paint (no idle frame), but never actually calls generate once the known-
// blocked limit comes back from `GET /api/ideas`.
describe('IdeasPanel (Story 2.11 regression: auto-generate still respects a known-blocked limit)', () => {
  it('never calls POST /api/ideas/generate when GET /api/ideas reports the limit already blocked', async () => {
    const generateFetch = vi.fn();
    const fetchMock = mockFetch({
      ...INTAKE_NULL_RESPONSE,
      '/api/ideas/generate': generateFetch,
      '/api/ideas': () =>
        new Response(
          JSON.stringify({ ideas: [], currency: 'EUR', generateLimit: { blocked: true, reason: 'shared_budget', limit: null, resetsAt: null } }),
          { status: 200 },
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdeasPanel autoGenerate />);

    expect(
      await screen.findByText("Today's shared search budget of the app is used up. New ideas are available again tomorrow."),
    ).toBeInTheDocument();
    expect(generateFetch).not.toHaveBeenCalled();
  });
});

// Story 2.11 AC5/AC6: existing ideas stay fully usable after a 429 — never
// replaced/cleared. UX fix (user-reported): the limit notice text and the
// button's disabled state moved back here with the button itself.
describe('IdeasPanel (Story 2.11: generate limit reached)', () => {
  it('leaves existing ideas on screen, shows the limit notice, and disables the button, after a 429 from POST /api/ideas/generate', async () => {
    const idea = fakeIdea();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas/generate': () =>
          new Response(JSON.stringify({ error: 'limit_reached', reason: 'shared_budget', limit: null, resetsAt: '2099-01-02T00:00:00.000Z' }), {
            status: 429,
          }),
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel />);
    await screen.findByText(idea.title);
    fireEvent.click(screen.getByRole('button', { name: 'Generate new ideas' }));

    expect(await screen.findByText(/shared search budget/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate new ideas' })).toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(idea.title)).toBeInTheDocument();
  });
});

// Story 2.3 AC2: Select/Bookmark/Reject render directly on every card (never
// behind a menu), with a status badge once the idea has left `suggested`,
// and the action matching the card's current status renders as primary.
describe('IdeasPanel (AC2: status badge + action buttons on the card)', () => {
  // UX fix (user-reported, live) supersedes this test's own `selected`/
  // `bookmarked` cases: a `selected` idea has its own plan/chat in the
  // sidebar now, and a `bookmarked` one has its own "Bookmarked" entry —
  // neither's card renders in this "New ideas" grid at all anymore, so
  // `suggested` (no status badge, no primary action yet) is the only case
  // this grid can still show.
  it('a suggested idea renders all 3 actions, none primary, with no status badge', async () => {
    const idea: IdeaResponse = { ...fakeIdea(), status: 'suggested' };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [idea], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    const buttons = {
      Select: await screen.findByRole('button', { name: 'Select' }),
      Bookmark: screen.getByRole('button', { name: 'Bookmark' }),
      Reject: screen.getByRole('button', { name: 'Reject' }),
    };
    for (const button of Object.values(buttons)) {
      expect(button.className.includes('bg-primary')).toBe(false);
    }
    expect(screen.queryByText('selected')).not.toBeInTheDocument();
    expect(screen.queryByText('bookmarked')).not.toBeInTheDocument();
  });
});

// Story 2.8 AC5 is superseded (UX fix, user-reported, live): a `selected`
// idea's card — the only one this "View plan" action ever applied to — no
// longer renders in this grid at all; its plan has its own entry in the
// sidebar's "My plans" list and its own chat instead. The feature (and
// `IdeaCard`'s own now-unreachable `onViewPlan` button) was removed rather
// than left as dead code nothing can trigger.

// UX fix (user-reported, live): "New ideas" (no `onlyIdeaId`) shows only
// still-undecided `suggested` ideas — never one already bookmarked or
// selected (a rejected one is never even returned by the server, AD-13).
describe('IdeasPanel (UX fix: "New ideas" grid excludes bookmarked ideas)', () => {
  it('shows a suggested idea but not a bookmarked one in the default ("New ideas") view', async () => {
    const suggested: IdeaResponse = { ...fakeIdea(), id: 'idea-1', title: 'Suggested idea', status: 'suggested' };
    const bookmarked: IdeaResponse = { ...fakeIdea(), id: 'idea-2', title: 'Bookmarked idea', status: 'bookmarked' };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [suggested, bookmarked], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel />);

    expect(await screen.findByText('Suggested idea')).toBeInTheDocument();
    expect(screen.queryByText('Bookmarked idea')).not.toBeInTheDocument();
  });
});

// UX fix (user-reported, live): a sidebar "Bookmarked" entry opens this
// same grid with `onlyIdeaId` set — showing *only* that one idea's card,
// regardless of how many other ideas (any status) exist.
describe('IdeasPanel (UX fix: onlyIdeaId shows just that one idea)', () => {
  it('shows only the idea matching onlyIdeaId, not the others', async () => {
    const target: IdeaResponse = { ...fakeIdea(), id: 'idea-1', title: 'The bookmarked idea', status: 'bookmarked' };
    const other: IdeaResponse = { ...fakeIdea(), id: 'idea-2', title: 'A different suggested idea', status: 'suggested' };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [target, other], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel onlyIdeaId="idea-1" />);

    expect(await screen.findByText('The bookmarked idea')).toBeInTheDocument();
    expect(screen.queryByText('A different suggested idea')).not.toBeInTheDocument();
  });
});

// UX fix (user-reported): the sidebar's "Bookmarked" entry is now one
// button (like "New ideas") that opens this same grid with `onlyBookmarked`
// set — showing every `bookmarked` idea's card together, never a suggested
// or selected one.
describe('IdeasPanel (UX fix: onlyBookmarked shows every bookmarked idea)', () => {
  it('shows all bookmarked ideas, not a suggested or selected one', async () => {
    const bookmarkedOne: IdeaResponse = { ...fakeIdea(), id: 'idea-1', title: 'First bookmarked idea', status: 'bookmarked' };
    const bookmarkedTwo: IdeaResponse = { ...fakeIdea(), id: 'idea-2', title: 'Second bookmarked idea', status: 'bookmarked' };
    const suggested: IdeaResponse = { ...fakeIdea(), id: 'idea-3', title: 'A suggested idea', status: 'suggested' };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [bookmarkedOne, bookmarkedTwo, suggested], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel onlyBookmarked />);

    expect(await screen.findByText('First bookmarked idea')).toBeInTheDocument();
    expect(screen.getByText('Second bookmarked idea')).toBeInTheDocument();
    expect(screen.queryByText('A suggested idea')).not.toBeInTheDocument();
  });

  // User-reported follow-up: Story 2.9's own "Bookmarked" list AC is
  // explicit — "the user has bookmarked ideas *without* a plan". A
  // bookmarked idea that already has its own plan (demoted back from
  // `selected` once a different idea was selected later, Code Map) belongs
  // in "My plans" only, not duplicated here too.
  it('excludes a bookmarked idea that already has its own plan', async () => {
    const stillBookmarked: IdeaWithPlanResponse = { ...fakeIdea(), id: 'idea-1', title: 'Still just bookmarked', status: 'bookmarked', hasPlan: false };
    const bookmarkedWithPlan: IdeaWithPlanResponse = {
      ...fakeIdea(),
      id: 'idea-2',
      title: 'Bookmarked but already has a plan',
      status: 'bookmarked',
      hasPlan: true,
    };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...INTAKE_NULL_RESPONSE,
        '/api/ideas': () => new Response(JSON.stringify({ ideas: [stillBookmarked, bookmarkedWithPlan], currency: 'EUR' }), { status: 200 }),
      }),
    );

    render(<IdeasPanel onlyBookmarked />);

    expect(await screen.findByText('Still just bookmarked')).toBeInTheDocument();
    expect(screen.queryByText('Bookmarked but already has a plan')).not.toBeInTheDocument();
  });
});

// UX fix (user-reported): "Generate new ideas" replaces the `suggested`
// batch — it's a "New ideas"-view-only action, never shown on either
// bookmarked view.
describe('IdeasPanel (UX fix: no "Generate new ideas" button in a bookmarked view)', () => {
  it.each([
    ['onlyBookmarked', { onlyBookmarked: true }],
    ['onlyIdeaId', { onlyIdeaId: 'idea-1' }],
  ] as const)('%s view shows no generate button', async (_name, props) => {
    const bookmarked: IdeaResponse = { ...fakeIdea(), id: 'idea-1', title: 'A bookmarked idea', status: 'bookmarked' };
    vi.stubGlobal(
      'fetch',
      mockFetch({ ...INTAKE_NULL_RESPONSE, '/api/ideas': () => new Response(JSON.stringify({ ideas: [bookmarked], currency: 'EUR' }), { status: 200 }) }),
    );

    render(<IdeasPanel {...props} />);

    expect(await screen.findByText('A bookmarked idea')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
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
      await screen.findByText(
        "Choose one idea to turn into a plan, bookmark one to save it for later, reject the ones that aren't for you, or generate a new batch.",
      ),
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

    // UX fix (user-reported, live): a `selected` idea now has its own plan
    // and chat (the sidebar's "My plans" list) — its card leaves this grid
    // entirely rather than staying with a "selected" badge.
    await waitFor(() => expect(screen.queryByText(idea.title)).not.toBeInTheDocument());
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

    // UX fix (user-reported, live): optimistic removal, same as a rejected
    // idea — a `selected` idea belongs in the sidebar's "My plans" list
    // now, not this grid.
    await waitFor(() => expect(screen.queryByText(idea.title)).not.toBeInTheDocument());
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

    // UX fix (user-reported, live): "New ideas" now shows only still-
    // undecided `suggested` ideas — a newly-bookmarked one leaves this grid
    // immediately (it has its own entry under "Bookmarked" instead).
    await waitFor(() => expect(screen.queryByText(idea.title)).not.toBeInTheDocument());
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
    const idea: IdeaResponse = { ...fakeIdea(), status: 'suggested' };
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
// request affecting it is in flight, not just via its own click — this
// matters for `select`, the one action whose own optimistic update also
// touches *other* ideas (every other `suggested` sibling is swept to
// `bookmarked`). The multi-card version of this test was removed (UX fix,
// user-reported, live): a swept sibling now also leaves this "New ideas"
// grid the instant it's demoted, the same as the clicked idea itself — so
// there is no longer a visible, still-rendered "disabled but not gone" state
// to assert on for either card. `reject`/`bookmark` only ever affect their
// own single target id (`affectedIdeaIds`), which the remaining test below
// still covers.
describe('IdeasPanel (status actions disable panel-wide while a request is in flight)', () => {
  // User-reported bug fix: selecting an idea must not disable (and so must
  // not visibly flicker) a sibling that isn't genuinely part of this
  // request — it has nothing to change here.
  it('never disables an unrelated sibling while rejecting a different idea', async () => {
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
    // Every card renders all 3 actions, so both cards have their own
    // "Reject"/"Bookmark" button — index by render order (ideaA, then
    // ideaB) to target each card's own.
    const rejectButtonA = (await screen.findAllByRole('button', { name: 'Reject' }))[0]!;
    const bookmarkButtonB = (await screen.findAllByRole('button', { name: 'Bookmark' }))[1]!;

    fireEvent.click(rejectButtonA);

    // ideaA's own card leaves the grid the instant Reject is clicked
    // (optimistic removal) — nothing left to assert "disabled" on. ideaB,
    // unrelated to this request, is never disabled by it.
    expect(screen.queryAllByRole('button', { name: 'Reject' })).toHaveLength(1);
    expect(bookmarkButtonB).not.toBeDisabled();

    resolveStatusFetch(new Response(null, { status: 204 }));
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

    // Spec 2.12 AC3: the old page-level "is being translated" banner is
    // gone — the title field itself shimmers in place instead
    // (`aria-busy`), with the stored-language text kept only for a screen
    // reader (`sr-only`) while the request is still in flight.
    expect(screen.queryByText('Deine Ideen werden übersetzt…')).not.toBeInTheDocument();
    const titleDuringTranslation = screen.getByText(idea.title, { selector: '.sr-only' });
    expect(titleDuringTranslation.closest('[aria-busy="true"]')).toBeInTheDocument();

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
