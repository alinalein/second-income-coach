import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { authSessionSchema, getIntakeResponseSchema, ideasWithPlanResponseSchema, planListResponseSchema, type AuthUser } from '@app/shared';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { ThemeToggle } from './theme/theme-toggle';
import { IntakeForm } from './features/intake/IntakeForm';
import { IdeasPanel } from './features/ideas/IdeasPanel';
import { PlanWorkspace } from './features/plan-workspace/PlanWorkspace';
import { SettingsPage } from './features/settings/SettingsPage';
import { Sidebar, SidebarMobileMenuButton, useIsDesktop } from './features/sidebar/Sidebar';
import { useAppliedUiLanguage } from './features/settings/useAppliedUiLanguage';

type AuthStatus =
  | { state: 'checking' }
  | { state: 'authenticated'; user: AuthUser }
  | { state: 'unauthenticated' };

/**
 * Calls the gated `GET /api/auth/session` (AC: "authenticated view renders")
 * and treats a 401 as "signed out" rather than an error — that's the
 * expected shape of the auth gate (I/O matrix: "Unauthenticated API call").
 */
function useAuthStatus(): [AuthStatus, () => void] {
  const [status, setStatus] = React.useState<AuthStatus>({ state: 'checking' });
  const [refreshToken, setRefreshToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/session', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setStatus({ state: 'unauthenticated' });
          return;
        }
        const body: unknown = await res.json();
        const result = authSessionSchema.safeParse(body);
        setStatus(result.success ? { state: 'authenticated', user: result.data.user } : { state: 'unauthenticated' });
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: 'unauthenticated' });
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);
  return [status, refresh];
}

/**
 * Design Notes: "Callback failure" — on an OAuth error/denial the backend
 * redirects to `/?auth_error=1` instead of throwing. This reads that flag
 * once, shows a neutral message (no stack trace or detail — I/O matrix:
 * "Google OAuth failure/denial"), then strips it from the URL.
 */
function useAuthError(): boolean {
  const [hasError, setHasError] = React.useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('auth_error')) return;

    setHasError(true);
    params.delete('auth_error');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  return hasError;
}

/**
 * User-requested, live: "on the start page [sign-in], I want to be able to
 * pick EN/DE too, next to the dark/light toggle — only on the start page."
 * Scoped to this file's own unauthenticated branch only — the signed-in
 * app already has a real language setting (`SettingsPage.tsx`'s own
 * `uiLanguage`, persisted server-side via `user_settings`); this is a
 * separate, local-only, pre-login convenience, same binary
 * click-to-flip shape as `ThemeToggle` right next to it. Nothing here
 * persists anywhere — there's no signed-in user yet to persist it for; a
 * returning signed-in user's own saved language still applies as soon as
 * `useAppliedUiLanguage` resolves it, same as before.
 */
function SignInLanguageToggle() {
  const { t, i18n } = useTranslation('common');
  const isGerman = i18n.language === 'de';

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={isGerman ? t('language.switchToEnglishLabel') : t('language.switchToGermanLabel')}
      onClick={() => void i18n.changeLanguage(isGerman ? 'en' : 'de')}
    >
      {isGerman ? t('language.english') : t('language.german')}
    </Button>
  );
}

function SignInCard({ showError }: { showError: boolean }) {
  const { t } = useTranslation('common');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.signInTitle')}</CardTitle>
        <CardDescription>{t('auth.signInDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {showError ? (
          <Badge variant="muted" role="alert">
            {t('auth.signInError')}
          </Badge>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => window.location.assign('/api/auth/google')}>
          {t('auth.signInButton')}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * AC1/AC5: whether the signed-in user has an `intake` row yet, read once via
 * the plain `GET /api/intake` (Boundary: no `get_intake` agent tool). `null`
 * means "still checking" (or signed out); resets to `null` when `enabled`
 * goes false so a later sign-in re-checks instead of reusing a stale value.
 */
function useHasIntake(enabled: boolean): [boolean | null, (value: boolean) => void] {
  const [hasIntake, setHasIntake] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      setHasIntake(null);
      return;
    }

    let cancelled = false;

    fetch('/api/intake', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Same safe default as "no intake yet" — without this, a failed
          // response leaves `hasIntake` null forever and the authenticated
          // view is stuck on the loading placeholder with no retry.
          setHasIntake(false);
          return;
        }
        const body: unknown = await res.json();
        const result = getIntakeResponseSchema.safeParse(body);
        if (result.success) setHasIntake(result.data.intake !== null);
      })
      .catch(() => {
        if (!cancelled) setHasIntake(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return [hasIntake, setHasIntake];
}

/**
 * UX fix (user-reported: "the transition from user input to generating
 * ideas window is not smooth"): the intake form, ideas panel, and plan
 * workspace are mutually-exclusive branches of one ternary below, so React
 * swaps one subtree for a completely different one in a single commit —
 * nothing animates between them on its own. Remounting this wrapper (via a
 * `key` tied to which branch is active) restarts a simple fade-in on every
 * such swap — no new animation library, same lightweight
 * `transition-opacity` pattern `IdeasPanel`'s own generating-progress block
 * already uses. The `requestAnimationFrame` defer is required: flipping
 * `opacity-0` -> `opacity-100` in the same paint as mount never transitions,
 * it just snaps straight to the end state.
 *
 * Spec 2.12 AC6 (bug fix): this wrapper used to be a plain auto-height
 * `div`, which collapsed to its content's own height — `PlanWorkspace`'s
 * `h-full`/`min-h-0` chain had nothing real to resolve against, since a
 * `height: 100%` ancestor must itself have a definite height, not just
 * "whatever its content needs." `flex min-h-0 flex-1 flex-col` makes this
 * div take `<main>`'s own real, viewport-bounded height instead, the same
 * way every other link in that chain already does. Harmless for every
 * non-workspace view — `<main>` already scrolls its content either way.
 */
function FadeIn({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={`flex min-h-0 flex-1 flex-col transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}>
      {children}
    </div>
  );
}

function signOut(onSignedOut: () => void) {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    .catch(() => undefined)
    .finally(onSignedOut);
}

/** Story 2.9 (AC: "the active view/plan survives a reload — use the URL").
 * A tiny path-based router — no new dependency, the same `window.history`
 * primitive `useAuthError` above already uses. `ideaTitle` starts `null` on
 * a direct load/reload of `/plan/:ideaId` (the URL carries no title);
 * `useResolvedPlanTitle` below fills it in once. Every in-app navigation
 * (a card, a sidebar entry) already has the title in hand and passes it
 * straight through. */
export type Route =
  | { kind: 'ideas' }
  | { kind: 'settings' }
  | { kind: 'plan'; ideaId: string; ideaTitle: string | null }
  | { kind: 'bookmarked'; ideaId: string }
  // UX fix (user-reported): the sidebar's "Bookmarked" entry is now one
  // button (like "New ideas"), showing every bookmarked idea's card
  // together — `{ kind: 'bookmarked'; ideaId }` (a single idea) stays only
  // for an existing stale/hand-typed `/bookmarked/:ideaId` URL.
  | { kind: 'bookmarkedAll' };

function parsePath(pathname: string): Route {
  if (pathname === '/settings') return { kind: 'settings' };
  if (pathname === '/bookmarked') return { kind: 'bookmarkedAll' };
  const planMatch = /^\/plan\/([^/]+)$/.exec(pathname);
  if (planMatch) return { kind: 'plan', ideaId: planMatch[1]!, ideaTitle: null };
  const bookmarkedMatch = /^\/bookmarked\/([^/]+)$/.exec(pathname);
  if (bookmarkedMatch) return { kind: 'bookmarked', ideaId: bookmarkedMatch[1]! };
  return { kind: 'ideas' };
}

function pathForRoute(route: Route): string {
  if (route.kind === 'settings') return '/settings';
  if (route.kind === 'plan') return `/plan/${route.ideaId}`;
  if (route.kind === 'bookmarked') return `/bookmarked/${route.ideaId}`;
  if (route.kind === 'bookmarkedAll') return '/bookmarked';
  return '/';
}

/**
 * The returned setter is a plain state setter — it never touches
 * `window.history` on its own. User-initiated navigation (a sidebar click,
 * a card's "Select") must go through `App`'s own `navigate` wrapper below,
 * which pushes a new history entry; a corrective/informational update (like
 * `useResolvedPlanTitle` filling in a title the URL never carried) uses this
 * setter directly so it never pushes a second, redundant entry for the
 * page the user is already on.
 */
function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = React.useState<Route>(() => parsePath(window.location.pathname));

  React.useEffect(() => {
    const onPopState = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return [route, setRoute];
}

/**
 * Resolves `route.ideaTitle` for a `'plan'` route loaded directly from the
 * URL with no title yet — looks it up in the sidebar's own "My plans" data
 * first (the common case: the plan already exists by definition of being
 * on this route), falling back to `GET /api/ideas` for the one edge case of
 * a bookmarked idea with no plan yet reached by a stale/hand-typed URL.
 * Replaces the URL with `/` (never a loud error) if the idea genuinely
 * isn't found for this user.
 */
function useResolvedPlanTitle(route: Route, setRoute: (route: Route) => void): void {
  React.useEffect(() => {
    if (route.kind !== 'plan' || route.ideaTitle !== null) return;
    let cancelled = false;

    fetch('/api/plans', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return undefined;
        const body: unknown = res.ok ? await res.json() : undefined;
        const result = res.ok ? planListResponseSchema.safeParse(body) : undefined;
        return result?.success ? result.data.plans.find((entry) => entry.ideaId === route.ideaId)?.ideaTitle : undefined;
      })
      .then(async (titleFromPlans) => {
        if (cancelled) return;
        if (titleFromPlans) {
          setRoute({ ...route, ideaTitle: titleFromPlans });
          return;
        }
        const res = await fetch('/api/ideas', { credentials: 'include' });
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = ideasWithPlanResponseSchema.safeParse(body);
        const idea = result.success ? result.data.ideas.find((candidate) => candidate.id === route.ideaId) : undefined;
        if (cancelled) return;
        if (idea) {
          setRoute({ ...route, ideaTitle: idea.title });
        } else {
          // Invalid/stale URL for this user — replace (never push) so the
          // broken `/plan/:ideaId` entry doesn't linger in history either.
          window.history.replaceState({}, '', '/');
          setRoute({ kind: 'ideas' });
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.kind, route.kind === 'plan' ? route.ideaId : undefined, route.kind === 'plan' ? route.ideaTitle : undefined]);
}

/**
 * Which of the mutually-exclusive branches below is active — used only as
 * `FadeIn`'s `key` so a real transition (not a same-branch re-render, e.g. a
 * card's status changing) is what restarts the fade. Exported as a pure
 * function (not inlined in `App()`) so the bug below is unit-testable
 * without rendering the whole app and racing `requestAnimationFrame`.
 *
 * Bug fix (user-reported, live): "transition between Review intake,
 * Bookmarked and New ideas is smooth, but clicking on one of the ideas or
 * switching between ideas the whole screen jumps" — `route.kind` alone
 * stays `'plan'` (or `'bookmarked'`) across a switch to a *different*
 * idea/plan, so `FadeIn` never remounted/re-faded for that case at all; the
 * content just swapped in the same commit, and a height difference between
 * the two plans read as a jump. Folding the specific `ideaId` into the key
 * makes every distinct plan/idea its own transition too.
 */
export function computeViewKey(hasIntake: boolean | null, showIntakeForm: boolean, route: Route): string {
  if (hasIntake === null) return 'loading';
  if (showIntakeForm) return 'intake';
  if (route.kind === 'plan' || route.kind === 'bookmarked') return `${route.kind}:${route.ideaId}`;
  return route.kind;
}

export function App() {
  const { t } = useTranslation('common');
  const { t: tIntake } = useTranslation('intake');
  const [authStatus, refreshAuthStatus] = useAuthStatus();
  const hasAuthError = useAuthError();
  const [hasIntake, setHasIntake] = useHasIntake(authStatus.state === 'authenticated');
  // AC1/AC5: defaults to showing the intake form until a row is known to
  // exist; a revisit link lets an already-intake'd user come back to it.
  const [showIntakeForm, setShowIntakeForm] = React.useState(true);

  React.useEffect(() => {
    if (hasIntake !== null) setShowIntakeForm(!hasIntake);
  }, [hasIntake]);
  // AC: "it is applied when the app loads for a signed-in user" — only once
  // a session is confirmed, never speculatively while still signed out.
  // Live fix (post-handoff): `uiLanguageReady` gates rendering below, same
  // pattern as `hasIntake === null` — nothing that depends on the real UI
  // language (e.g. "Generate new ideas") can fire before it's actually
  // applied.
  const uiLanguageReady = useAppliedUiLanguage(authStatus.state === 'authenticated');
  // Story 5.5: bumping this key remounts `IdeasPanel` on a successful
  // currency save, so its existing mount-time fetch re-reads the
  // now-updated currency from `GET /api/ideas` — no change needed inside
  // `IdeasPanel.tsx` itself.
  const [ideasCurrencyKey, setIdeasCurrencyKey] = React.useState(0);
  // Story 2.8 AC1: set only on a true first-ever intake submit (`hasIntake`
  // was `false` right before this session's save) — never on a returning
  // user whose intake already existed before this session.
  // Bug fix (user-reported, live): must be a true one-shot — the flag used
  // to stay `true` for the rest of the session (the old comment here even
  // said so), and `IdeasPanel`'s own auto-generate effect reads it live,
  // not just at mount (`autoGenerate` is one of that effect's own
  // dependencies, gated separately on `initialLoadSettled`) — so clicking
  // "Bookmarked" or "New ideas" in the sidebar *after* already working on a
  // plan remounted `IdeasPanel` fresh with that stale `true` still in
  // place, re-firing the whole intake-review + generate sequence on a view
  // that should have just shown the existing bookmarked/suggested ideas.
  // Reset it inside `navigate()` below instead of a separate effect: an
  // effect-based reset raced the child's own async effect (it could flip
  // the prop back to `false` before `initialLoadSettled` even became
  // true, silently skipping the *intended* auto-generate on the very save
  // that's supposed to trigger it) — `navigate()` only ever fires for a
  // later, *different* user action, batched atomically with the route
  // change that would unmount/remount `IdeasPanel` anyway, so there's
  // nothing left in flight to race.
  const [autoGenerateIdeas, setAutoGenerateIdeas] = React.useState(false);
  // Story 2.9: the active view/plan, driven by the URL (survives a reload).
  const [route, setRoute] = useRoute();
  useResolvedPlanTitle(route, setRoute);
  // Story 3.3: bumped on every navigation into a plan — switching plans can
  // resume/pause rows server-side, so the sidebar's "My plans" list
  // (`GET /api/plans`) needs a fresh read right after.
  const [plansRefreshKey, setPlansRefreshKey] = React.useState(0);
  const navigate = React.useCallback(
    (next: Route) => {
      const nextPath = pathForRoute(next);
      // Never push a duplicate entry for the page the user is already on
      // (e.g. clicking a sidebar entry for the view already open).
      if (nextPath !== window.location.pathname) window.history.pushState({}, '', nextPath);
      if (next.kind === 'plan') setPlansRefreshKey((k) => k + 1);
      // Bug fix (user-reported, live): "Review your intake answers" set
      // `showIntakeForm`, which renders *above* the `route` switch below —
      // nothing reset it on a later sidebar click, so every other sidebar
      // button looked unresponsive once the intake form was open. Every
      // call here is itself a sidebar/card navigation choosing somewhere
      // else to go, so it always leaves intake-review mode too.
      setShowIntakeForm(false);
      // Bug fix (user-reported, live): see `autoGenerateIdeas`'s own doc
      // comment above — every real navigation consumes this one-shot flag,
      // so a *later* visit to 'ideas'/'bookmarkedAll' never re-reads a
      // stale `true`.
      setAutoGenerateIdeas(false);
      setRoute(next);
    },
    [setRoute],
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);
  // Bug fix (user-reported, live, confirmed at a genuine desktop width in
  // two different browsers): deciding the mobile-header-vs-docked-sidebar
  // split via `useIsDesktop` (JS `matchMedia`), not a `sm:hidden` CSS
  // toggle — see that hook's own doc comment for why.
  const isDesktop = useIsDesktop();
  const viewKey = computeViewKey(hasIntake, showIntakeForm, route);

  if (authStatus.state !== 'authenticated') {
    return (
      <div className="min-h-screen text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
            <div className="flex items-center gap-2">
              <SignInLanguageToggle />
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          <SignInCard showError={hasAuthError} />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden text-foreground">
      {/* 2.9 AC: the sidebar shows once this signed-in user has an intake —
       * not before (the no-intake-yet screen has nothing to navigate to). */}
      {hasIntake ? (
        <Sidebar
          // Bug fix (user-reported): "Review your intake answers" never
          // showed as the active entry — `showIntakeForm` renders above the
          // `route` switch below and isn't itself part of `route`, so it's
          // its own `activeRoute` kind here, checked first.
          activeRoute={showIntakeForm ? { kind: 'intake' } : route}
          onNavigate={navigate}
          onSignedOut={() => signOut(refreshAuthStatus)}
          onReviewIntake={() => setShowIntakeForm(true)}
          mobileOpen={mobileSidebarOpen}
          onMobileOpenChange={setMobileSidebarOpen}
          plansRefreshKey={plansRefreshKey}
        />
      ) : null}

      {/* Bug fix (user-reported, live): the page itself used to grow to fit
       * however tall the generated ideas grid or an open plan's chat got —
       * `min-h-screen` only ever set a *floor*, nothing capped the content
       * column to the viewport, so long content pushed the whole page (and
       * the sidebar with it) into one giant scroll. `h-screen overflow-
       * hidden` on this row + `min-h-0` down the flex chain (the classic
       * fix for "a flex child won't shrink below its content") makes
       * `<main>` below the one thing that scrolls; the sidebar stays put. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {hasIntake && !isDesktop ? (
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <SidebarMobileMenuButton onClick={() => setMobileSidebarOpen(true)} />
            <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
          </header>
        ) : null}

        {/* Story 2.2 follow-up fix 4: `<main>` itself is wide enough for
         * `IdeasPanel`'s 3-column card grid; the intake form (which should
         * stay the original narrow reading width) gets its own `max-w-3xl`
         * wrapper instead of inheriting one from `<main>`. */}
        <main className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 flex-col gap-6 overflow-y-auto px-6 py-10">
          <FadeIn key={viewKey}>
          {hasIntake === null || !uiLanguageReady ? (
            <p className="mx-auto w-full max-w-3xl text-sm text-muted-foreground">{tIntake('loading')}</p>
          ) : showIntakeForm ? (
            <div className="mx-auto w-full max-w-3xl">
              <IntakeForm
                onSaved={() => {
                  // Story 2.8 AC1 / Spec 2.12 AC1 (amended): `hasIntake` here
                  // is the closure's pre-update value, detected from the
                  // stored intake `App` already fetched (never a localStorage
                  // flag) — `false` means this save is the user's first-ever
                  // intake submit (no intake stored yet), which auto-
                  // generates ideas and redirects straight into that view.
                  // An edit of an *already-existing* intake via "Review your
                  // intake answers" only saves — no redirect, no generation —
                  // `IntakeForm` shows its own short confirmation instead,
                  // and "Review your intake answers" stays the active
                  // sidebar entry since `showIntakeForm` is left untouched.
                  if (hasIntake === false) {
                    setAutoGenerateIdeas(true);
                    setHasIntake(true);
                    setShowIntakeForm(false);
                  }
                }}
              />
            </div>
          ) : route.kind === 'settings' ? (
            <div className="mx-auto w-full max-w-3xl">
              <SettingsPage
                onCurrencyChange={() => {
                  setIdeasCurrencyKey((k) => k + 1);
                  setAutoGenerateIdeas(false);
                }}
              />
            </div>
          ) : route.kind === 'plan' ? (
            <PlanWorkspace
              ideaId={route.ideaId}
              ideaTitle={route.ideaTitle ?? ''}
              // Bug fix (user-reported, live): the early bump in `navigate`
              // above races ahead of this workspace's own lazy plan
              // creation — this re-triggers the sidebar's "My plans" refetch
              // once the plan actually exists.
              onPlanLoaded={() => setPlansRefreshKey((k) => k + 1)}
            />
          ) : (
            <IdeasPanel
              key={ideasCurrencyKey}
              autoGenerate={autoGenerateIdeas}
              onViewPlan={(id, title) => navigate({ kind: 'plan', ideaId: id, ideaTitle: title })}
              onlyIdeaId={route.kind === 'bookmarked' ? route.ideaId : undefined}
              onlyBookmarked={route.kind === 'bookmarkedAll'}
            />
          )}
          </FadeIn>
        </main>
      </div>
    </div>
  );
}
