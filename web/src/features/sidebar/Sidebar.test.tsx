import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { IdeaWithPlanResponse, PlanListEntry } from '@app/shared';
import { Sidebar, type SidebarProps } from './Sidebar';

function renderSidebar(props: SidebarProps) {
  return render(<Sidebar {...props} />);
}

function mockFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(responses).find((key) => url.includes(key));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const entry = responses[match]!;
    return Promise.resolve(typeof entry === 'function' ? entry() : entry.clone());
  });
}

/** Bug fix (user-reported, live): `useIsDesktop` decides the docked-column
 * vs. mobile-overlay split via `matchMedia`, not a CSS `sm:` toggle — this
 * overrides the test-setup default (`matches: true`, every other test's
 * "desktop" baseline) to exercise the narrow branch specifically. */
function mockNarrowViewport() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function plansResponse(plans: PlanListEntry[]) {
  return () => new Response(JSON.stringify({ plans }), { status: 200 });
}

function ideasResponse(ideas: IdeaWithPlanResponse[]) {
  return () => new Response(JSON.stringify({ ideas, currency: 'EUR' }), { status: 200 });
}

function fakeIdea(overrides: Partial<IdeaWithPlanResponse> = {}): IdeaWithPlanResponse {
  const now = new Date().toISOString();
  return {
    id: 'idea-1',
    status: 'bookmarked',
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
    hasPlan: false,
    ...overrides,
  };
}

function fakePlanEntry(overrides: Partial<PlanListEntry> = {}): PlanListEntry {
  const now = new Date().toISOString();
  return { id: 'plan-1', ideaId: 'idea-1', ideaTitle: 'Resell thrifted items', status: 'active', updatedAt: now, ...overrides };
}

function noopProps() {
  return {
    activeRoute: { kind: 'ideas' } as const,
    onNavigate: vi.fn(),
    onSignedOut: vi.fn(),
    onReviewIntake: vi.fn(),
    mobileOpen: false,
    onMobileOpenChange: vi.fn(),
    plansRefreshKey: 0,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// 2.9 AC1 / AC (global actions): product name, "New ideas" entry, the
// Review-intake action (moved here from the ideas view), and the profile
// entry (Settings + sign out). UX fix (user-reported): "Generate new
// ideas" moved back onto the ideas page itself (`IdeasPanel.test.tsx`),
// never in this sidebar.
describe('Sidebar (AC1: structure)', () => {
  it('renders the product name, New ideas/Review-intake entries, Settings entry, and sign-out button', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    renderSidebar(noopProps());

    expect(screen.getByText('Second Income Coach')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New ideas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review your intake answers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('clicking "Review your intake answers" calls onReviewIntake', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));
    const onReviewIntake = vi.fn();

    renderSidebar({ ...noopProps(), onReviewIntake });
    fireEvent.click(await screen.findByRole('button', { name: 'Review your intake answers' }));

    expect(onReviewIntake).toHaveBeenCalledOnce();
  });
});

// UX fix (user-reported): top-to-bottom order is "Review your intake
// answers", then "Bookmarked", then "New ideas".
describe('Sidebar (UX fix: top nav order)', () => {
  it('lists Review-intake, Bookmarked, then New ideas, in that order', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    renderSidebar(noopProps());

    const buttons = await screen.findAllByRole('button');
    const labels = buttons.map((button) => button.textContent);
    const reviewIndex = labels.findIndex((label) => label === 'Review your intake answers');
    const bookmarkedIndex = labels.findIndex((label) => label === 'Bookmarked');
    const newIdeasIndex = labels.findIndex((label) => label === 'New ideas');

    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeLessThan(bookmarkedIndex);
    expect(bookmarkedIndex).toBeLessThan(newIdeasIndex);
  });
});

// 2.9 AC: "the sidebar is a fixed, docked column that the user can collapse
// and expand with a toggle ... remembered across reloads." A remount (same
// as a reload, since this is backed by `localStorage`, not React state)
// must come back collapsed.
describe('Sidebar (2.9: desktop collapse state persists across a remount)', () => {
  it('stays collapsed after collapsing, unmounting, and remounting', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    const { unmount } = renderSidebar(noopProps());
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByText('Second Income Coach')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    unmount();

    renderSidebar(noopProps());

    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(screen.queryByText('Second Income Coach')).not.toBeInTheDocument();
  });
});

// 2.9 AC2: My plans — active marked, paused dimmed, empty state.
describe('Sidebar (AC2: My plans list)', () => {
  it.each([
    ['active', fakePlanEntry({ status: 'active' }), 'Active'],
    ['paused', fakePlanEntry({ status: 'paused' }), 'Paused'],
  ])('shows a %s plan with its status badge', async (_case, entry, expectedBadge) => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([entry]), '/api/ideas': ideasResponse([]) }));

    renderSidebar(noopProps());

    const planButton = await screen.findByRole('button', { name: new RegExp(entry.ideaTitle) });
    expect(planButton).toHaveTextContent(expectedBadge);
  });

  it('shows a localized empty note when there are no plans', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    renderSidebar(noopProps());

    expect(await screen.findByText('No plans yet — select an idea to start one.')).toBeInTheDocument();
  });

  it('selecting a My-plans entry navigates directly, with no confirm dialog', async () => {
    const entry = fakePlanEntry();
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([entry]), '/api/ideas': ideasResponse([]) }));
    const onNavigate = vi.fn();

    renderSidebar({ ...noopProps(), onNavigate });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(entry.ideaTitle) }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: 'plan', ideaId: entry.ideaId, ideaTitle: entry.ideaTitle });
    expect(screen.queryByText('Make this your plan?')).not.toBeInTheDocument();
  });
});

// UX fix (user-reported): "Bookmarked" is now one button, below "Generate
// new ideas" — like "New ideas" — rather than a per-idea list; clicking it
// navigates to a view showing every bookmarked idea's card together
// (`IdeasPanel`'s own grid, filtered), never a dialog or status write here.
describe('Sidebar (UX fix: Bookmarked is one button)', () => {
  it('renders a single "Bookmarked" button, not a per-idea list', async () => {
    const idea = fakeIdea({ title: 'Bookmarked idea', status: 'bookmarked', hasPlan: false });
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([idea]) }));

    renderSidebar(noopProps());

    expect(await screen.findByRole('button', { name: 'Bookmarked' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bookmarked idea' })).not.toBeInTheDocument();
  });

  it('clicking "Bookmarked" navigates to the all-bookmarked view, with no dialog and no status write', async () => {
    const idea = fakeIdea();
    const fetchMock = mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([idea]) });
    vi.stubGlobal('fetch', fetchMock);
    const onNavigate = vi.fn();

    renderSidebar({ ...noopProps(), onNavigate });
    fireEvent.click(await screen.findByRole('button', { name: 'Bookmarked' }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: 'bookmarkedAll' });
    expect(screen.queryByText('Make this your plan?')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/status'), expect.anything());
  });
});

// Bug fix (user-reported, live): the docked-column/mobile-overlay split is
// decided by `useIsDesktop` (JS `matchMedia`), not a CSS `sm:` toggle. At a
// narrow viewport, the docked column must not render at all, and the
// overlay (only this component's own concern — the menu button that opens
// it lives in `App.tsx`) must show its nav content and close via its own
// control.
// Bug fix (user-reported): "Review your intake answers" never showed as
// the active entry — `showIntakeForm` (App.tsx) is outside the URL-driven
// `route`, so it's passed in as its own `activeRoute` kind.
describe('Sidebar (bug fix: "Review your intake answers" marks itself active)', () => {
  it('marks "Review your intake answers" as the active page when activeRoute is "intake"', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    renderSidebar({ ...noopProps(), activeRoute: { kind: 'intake' } });

    const reviewButton = await screen.findByRole('button', { name: 'Review your intake answers' });
    expect(reviewButton).toHaveAttribute('aria-current', 'page');
    const newIdeasButton = screen.getByRole('button', { name: 'New ideas' });
    expect(newIdeasButton).not.toHaveAttribute('aria-current');
  });
});

describe('Sidebar (bug fix: narrow viewport renders the overlay, not the docked column)', () => {
  it('does not render the docked column at a narrow viewport', async () => {
    mockNarrowViewport();
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));

    renderSidebar(noopProps());

    await waitFor(() => expect(screen.queryByText('Second Income Coach')).not.toBeInTheDocument());
  });

  it('shows the nav content in the overlay when mobileOpen is true, and the close button calls onMobileOpenChange(false)', async () => {
    mockNarrowViewport();
    vi.stubGlobal('fetch', mockFetch({ '/api/plans': plansResponse([]), '/api/ideas': ideasResponse([]) }));
    const onMobileOpenChange = vi.fn();

    renderSidebar({ ...noopProps(), mobileOpen: true, onMobileOpenChange });

    expect(await screen.findByText('Second Income Coach')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    expect(onMobileOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
