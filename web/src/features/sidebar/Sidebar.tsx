import * as React from 'react';
import { ChevronLeft, ChevronRight, Menu, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { planListResponseSchema, type PlanListEntry } from '@app/shared';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';

/** A navigation target — `onNavigate`'s own shape always carries `ideaTitle`
 * for the `'plan'` case (the caller already has it, from either this list's
 * own fetch or a card the user just clicked), so nothing downstream has to
 * re-resolve a title from just an id. `'bookmarked'` (UX fix, user-reported,
 * live): a Bookmarked entry opens a view showing *only* that one idea's
 * card, never the full "New ideas" grid. */
export type SidebarTarget =
  | { kind: 'ideas' }
  | { kind: 'settings' }
  | { kind: 'plan'; ideaId: string; ideaTitle: string }
  | { kind: 'bookmarked'; ideaId: string }
  // UX fix (user-reported): "Bookmarked" is now one button (like "New
  // ideas"), showing every bookmarked idea's card together.
  | { kind: 'bookmarkedAll' };

/** The currently-shown view, for marking the matching nav entry
 * (`aria-current="page"`) — same kinds as `SidebarTarget`, but without a
 * title (the active-marking check only ever needs the id). */
export type SidebarActiveRoute =
  | { kind: 'ideas' }
  | { kind: 'settings' }
  | { kind: 'plan'; ideaId: string }
  | { kind: 'bookmarked'; ideaId: string }
  | { kind: 'bookmarkedAll' }
  // Bug fix (user-reported): "Review your intake answers" never marked
  // itself active — `showIntakeForm` lives outside the URL-driven `route`
  // in `App.tsx`, so it's passed here as its own distinct active kind.
  | { kind: 'intake' };

export interface SidebarProps {
  activeRoute: SidebarActiveRoute;
  onNavigate: (target: SidebarTarget) => void;
  onSignedOut: () => void;
  onReviewIntake: () => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  /** Bumped by the caller after anything that can change plan status
   * (switching plans resumes/pauses rows server-side) — refetches
   * `GET /api/plans` so "active"/"paused" stays correct without a reload. */
  plansRefreshKey: number;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'sidebar-collapsed';
/** Same cutoff as Tailwind's own default `sm:` breakpoint (40rem = 640px at
 * the standard 16px root font size) — kept as a literal pixel value here
 * rather than re-deriving it from Tailwind, since this is the one place the
 * desktop/narrow split is actually *decided* (see `useIsDesktop` below). */
export const DESKTOP_BREAKPOINT_PX = 640;

/**
 * Bug fix (user-reported, live, reproduced in two different browsers): the
 * desktop-docked-column vs. narrow-overlay choice was originally decided
 * purely by Tailwind's `sm:` media-query utilities (`hidden sm:block` /
 * `sm:hidden`) toggling `display` on both variants, with both always
 * mounted. That left no way to tell, from the rendered page alone, whether
 * the CSS was actually resolving as intended — and for this user, on a
 * window the user confirmed was normal desktop width, it wasn't: the
 * narrow-screen header/menu-button kept rendering instead of the docked
 * column, and the menu button's own overlay (itself `sm:hidden`, correctly
 * inert at a qualifying desktop width) then looked "broken" since nothing
 * was supposed to open there anyway. Deciding this explicitly in JS via
 * `matchMedia`, and conditionally *mounting* only the matching variant
 * (never both, with CSS just hiding one), removes any dependency on a CSS
 * cascade this session couldn't verify live — the decision is now a plain,
 * inspectable boolean.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(() => window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches);

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const handleChange = () => setIsDesktop(mql.matches);
    handleChange();
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return isDesktop;
}

/** 2.9 AC: "the sidebar is a fixed, docked column ... collapse and expand
 * with a toggle ... remembered across reloads." `localStorage` is a plain
 * per-browser preference (never shared state another viewer needs), so a
 * failed read/write (private mode, blocked storage) just falls back to
 * "expanded" rather than breaking navigation. */
function useDesktopCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = React.useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const setCollapsed = React.useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Private mode / blocked storage — the toggle still works for this
      // session, it just won't be remembered next time.
    }
  }, []);

  return [collapsed, setCollapsed];
}

function isActivePlanRoute(activeRoute: SidebarActiveRoute, ideaId: string): boolean {
  return activeRoute.kind === 'plan' && activeRoute.ideaId === ideaId;
}

/**
 * 2.9 AC: "each entry is one idea with a plan ... the active plan is
 * marked, paused plans are dimmed." Two independent markings on the same
 * row: `aria-current` (this is the view currently open) vs. the
 * status-derived style (this plan itself is `active`/`paused` server-side,
 * regardless of which view is open right now).
 */
function MyPlansList({
  plans,
  activeRoute,
  onSelect,
  t,
}: {
  plans: readonly PlanListEntry[];
  activeRoute: SidebarActiveRoute;
  onSelect: (entry: PlanListEntry) => void;
  t: (key: string) => string;
}) {
  if (plans.length === 0) {
    return <p className="px-3 text-xs text-muted-foreground">{t('myPlans.empty')}</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {plans.map((entry) => (
        <li key={entry.id}>
          <Button
            type="button"
            variant={isActivePlanRoute(activeRoute, entry.ideaId) ? 'accent' : 'ghost'}
            size="sm"
            aria-current={isActivePlanRoute(activeRoute, entry.ideaId) ? 'page' : undefined}
            className={`w-full justify-start gap-2 ${entry.status === 'paused' ? 'opacity-60' : ''}`}
            onClick={() => onSelect(entry)}
          >
            <span className="truncate">{entry.ideaTitle}</span>
            {entry.status === 'active' ? <Badge variant="default">{t('myPlans.activeStatus')}</Badge> : null}
            {entry.status === 'paused' ? <Badge variant="muted">{t('myPlans.pausedStatus')}</Badge> : null}
          </Button>
        </li>
      ))}
    </ul>
  );
}


/**
 * Story 2.9: the app-wide left sidebar (product name, New ideas, Generate,
 * Review intake, My plans, Bookmarked, profile) — every navigation and
 * global action lives here, nowhere else in the page content (AC).
 *
 * UX fix (user-reported, live): a Bookmarked entry navigates to the ideas
 * view — never its own confirm dialog here. That idea's own card (with its
 * own "Select"/"Bookmark"/"Reject" actions, already rendered by
 * `IdeasPanel`) is what the user needs to actually see before deciding;
 * the Story 2.8 confirm dialog stays exactly where it already was, behind
 * that card's own "Select" button, never duplicated or short-circuited
 * here.
 *
 * Desktop: a fixed, docked flex column (never an overlay, so it can never
 * blur/dim/cover the content) that collapses to a slim rail — the toggle
 * state persists via `useDesktopCollapsed`. Mobile: a manually-built
 * overlay (not the UI kit's own `Sheet`) so the backdrop is guaranteed
 * plain, light, non-blurring, with an explicit close control (AC).
 */
export function Sidebar({
  activeRoute,
  onNavigate,
  onSignedOut,
  onReviewIntake,
  mobileOpen,
  onMobileOpenChange,
  plansRefreshKey,
}: SidebarProps) {
  const { t } = useTranslation('sidebar');
  const { t: tCommon } = useTranslation('common');
  const { t: tIntake } = useTranslation('intake');
  const isDesktop = useIsDesktop();
  const [collapsed, setCollapsed] = useDesktopCollapsed();
  const [plansList, setPlansList] = React.useState<readonly PlanListEntry[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/plans', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = planListResponseSchema.safeParse(body);
        if (result.success) setPlansList(result.data.plans);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [plansRefreshKey]);

  const handleSelectPlan = React.useCallback(
    (entry: PlanListEntry) => {
      onNavigate({ kind: 'plan', ideaId: entry.ideaId, ideaTitle: entry.ideaTitle });
      onMobileOpenChange(false);
    },
    [onNavigate, onMobileOpenChange],
  );

  const handleNavigate = React.useCallback(
    (target: SidebarTarget) => {
      onNavigate(target);
      onMobileOpenChange(false);
    },
    [onNavigate, onMobileOpenChange],
  );

  const handleReviewIntakeClick = React.useCallback(() => {
    onReviewIntake();
    onMobileOpenChange(false);
  }, [onReviewIntake, onMobileOpenChange]);

  const navContent = (
    // UX fix (user-reported): "a bit more space" between the top nav group
    // and "My plans" below it — `gap-8` (up from `gap-6`) throughout.
    <nav aria-label={t('navLabel')} className="flex h-full w-64 flex-col gap-8 p-4">
      <div className="flex items-center justify-between px-2">
        <span className="text-sm font-semibold tracking-tight">{tCommon('app.title')}</span>
        {/* The collapse toggle only makes sense for the docked desktop
         * column — `navContent` is reused as-is inside the mobile overlay
         * too, where this button would have nothing meaningful to do.
         * Gated on the same `isDesktop` JS decision as everything else
         * here (never a `sm:` CSS toggle — see `useIsDesktop`'s own doc
         * comment). */}
        {isDesktop ? (
          <Button type="button" variant="ghost" size="sm" aria-label={t('collapseLabel')} onClick={() => setCollapsed(true)}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {/* UX fix (user-reported): reordered — "Review your intake answers"
       * first, then "Bookmarked", then "New ideas". The "Generate new
       * ideas" button that used to sit here moved onto the ideas page
       * itself, below the idea cards (`IdeasPanel.tsx`). A heading (same
       * style as "My plans" below) names the group, same as every other
       * section in this nav. */}
      <div className="flex flex-col gap-2">
        <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('topNav.heading')}</h4>
        {/* Bug fix (user-reported): this never marked itself active before
         * — `showIntakeForm` lives in `App.tsx`, outside the URL-driven
         * `route`, so it's passed in here as its own `activeRoute` kind. */}
        <Button
          type="button"
          variant={activeRoute.kind === 'intake' ? 'accent' : 'ghost'}
          size="sm"
          aria-current={activeRoute.kind === 'intake' ? 'page' : undefined}
          className="w-full justify-start"
          onClick={handleReviewIntakeClick}
        >
          {tIntake('revisitLink')}
        </Button>

        {/* UX fix (user-reported): "Bookmarked" is one button (like "New
         * ideas"), not a per-idea list further down; it opens a view
         * showing every bookmarked idea's card together (IdeasPanel's own
         * grid, filtered), never a dialog or status write here. */}
        <Button
          type="button"
          variant={activeRoute.kind === 'bookmarkedAll' ? 'accent' : 'ghost'}
          size="sm"
          aria-current={activeRoute.kind === 'bookmarkedAll' ? 'page' : undefined}
          className="w-full justify-start"
          onClick={() => handleNavigate({ kind: 'bookmarkedAll' })}
        >
          {t('bookmarked.heading')}
        </Button>

        <Button
          type="button"
          variant={activeRoute.kind === 'ideas' ? 'accent' : 'ghost'}
          size="sm"
          aria-current={activeRoute.kind === 'ideas' ? 'page' : undefined}
          className="w-full justify-start"
          onClick={() => handleNavigate({ kind: 'ideas' })}
        >
          {t('newIdeasLabel')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('myPlans.heading')}</h4>
        <MyPlansList plans={plansList} activeRoute={activeRoute} onSelect={handleSelectPlan} t={t} />
      </div>

      {/* UX fix (user-reported): the dark/light toggle moved into the
       * Settings screen itself — this "Settings" entry now sits exactly
       * where that toggle used to be, next to sign-out. */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant={activeRoute.kind === 'settings' ? 'accent' : 'ghost'}
          size="sm"
          aria-current={activeRoute.kind === 'settings' ? 'page' : undefined}
          onClick={() => handleNavigate({ kind: 'settings' })}
        >
          {t('profile.settingsLabel')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onSignedOut}>
          {tCommon('auth.signOutButton')}
        </Button>
      </div>
    </nav>
  );

  return (
    <>
      {/* 2.9 AC: "a fixed, docked column ... never blurs, dims or covers the
       * page content" — a plain flex sibling (never `position: fixed`
       * layered over anything, never an overlay), so the content column
       * next to it simply reflows; there is nothing here that could dim or
       * blur it. Collapsed = a slim rail with just the expand toggle.
       * `isDesktop` (JS `matchMedia`, not a CSS `sm:` toggle — see that
       * hook's own doc comment) decides which of the two variants below
       * even mounts; only one of docked-column/mobile-overlay is ever in
       * the DOM at a time. */}
      {isDesktop ? (
        collapsed ? (
          <div className="glass-chrome flex shrink-0 flex-col items-center gap-4 border-r p-2">
            <Button type="button" variant="ghost" size="sm" aria-label={t('expandLabel')} onClick={() => setCollapsed(false)}>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          // UX fix (user-reported): "a bit transparent" — `glass-chrome`,
          // the same translucent/blurred chrome tier the header already
          // uses, instead of an opaque panel. `overflow-y-auto`: a long
          // "My plans" list scrolls inside the sidebar itself rather than
          // growing the column past the viewport.
          <div className="glass-chrome h-full shrink-0 overflow-y-auto border-r">{navContent}</div>
        )
      ) : null}

      {/* Mobile overlay — hand-rolled (not the UI kit's `Sheet`) so the
       * backdrop is guaranteed plain and light, never `backdrop-blur` or a
       * dark scrim (AC), with its own explicit close control. */}
      {!isDesktop && mobileOpen ? (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t('navLabel')}>
          <div className="absolute inset-0 bg-background/40" onClick={() => onMobileOpenChange(false)} />
          <div className="glass-chrome relative flex h-full w-64 flex-col overflow-y-auto border-r shadow-[var(--shadow)]">
            <div className="flex justify-end p-2">
              <Button type="button" variant="ghost" size="sm" aria-label={t('closeMenuLabel')} onClick={() => onMobileOpenChange(false)}>
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">{navContent}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function SidebarMobileMenuButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('sidebar');
  return (
    <Button type="button" variant="ghost" size="sm" aria-label={t('openMenuLabel')} onClick={onClick}>
      <Menu className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}
