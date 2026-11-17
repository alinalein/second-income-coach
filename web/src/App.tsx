import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { authSessionSchema, getIntakeResponseSchema, type AuthUser } from '@app/shared';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { ThemeToggle } from './theme/theme-toggle';
import { IntakeForm } from './features/intake/IntakeForm';
import { IdeasPanel } from './features/ideas/IdeasPanel';
import { PlanWorkspace } from './features/plan-workspace/PlanWorkspace';
import { SettingsPage } from './features/settings/SettingsPage';
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
 */
function FadeIn({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return <div className={`transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}>{children}</div>;
}

/** Code Map: "small revisit link once one [an intake row] does [exist]". */
function RevisitIntakeLink({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('intake');
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick}>
      {t('revisitLink')}
    </Button>
  );
}

function SignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation('common');
  const [pending, setPending] = React.useState(false);

  const handleClick = React.useCallback(() => {
    setPending(true);
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .catch(() => undefined)
      .finally(() => {
        setPending(false);
        onSignedOut();
      });
  }, [onSignedOut]);

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={pending}>
      {t('auth.signOutButton')}
    </Button>
  );
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
  // Story 3.1: which idea's `PlanWorkspace` (if any) replaces the ideas/chat
  // view below — a local-only toggle, never persisted; "Back to ideas"
  // clears it. The idea's own title rides along (UI fix, user-reported) so
  // the workspace can label itself "Your plan for <idea>".
  const [viewPlanIdea, setViewPlanIdea] = React.useState<{ id: string; title: string } | null>(null);
  // Story 2.8 AC1: set only on a true first-ever intake submit (`hasIntake`
  // was `false` right before this session's save) — never on a returning
  // user whose intake already existed before this session, and never again
  // once set (there is no later path back to `false`).
  const [autoGenerateIdeas, setAutoGenerateIdeas] = React.useState(false);
  // UX fix: which of the 4 mutually-exclusive branches below is active —
  // used only as `FadeIn`'s `key` so a real transition (not a same-branch
  // re-render, e.g. a card's status changing) is what restarts the fade.
  const viewKey = hasIntake === null ? 'loading' : showIntakeForm ? 'intake' : viewPlanIdea ? 'plan' : 'ideas';

  if (authStatus.state !== 'authenticated') {
    return (
      <div className="min-h-screen text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
          <SignInCard showError={hasAuthError} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton onSignedOut={refreshAuthStatus} />
          </div>
        </div>
      </header>

      {/* Story 2.2 follow-up fix 4: `<main>` itself is wide enough for
       * `IdeasPanel`'s 3-column card grid; the intake form (which should
       * stay the original narrow reading width) gets its own `max-w-3xl`
       * wrapper instead of inheriting one from `<main>`. */}
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <FadeIn key={viewKey}>
        {hasIntake === null || !uiLanguageReady ? (
          <p className="mx-auto w-full max-w-3xl text-sm text-muted-foreground">{tIntake('loading')}</p>
        ) : showIntakeForm ? (
          <div className="mx-auto w-full max-w-3xl">
            <IntakeForm
              onSaved={() => {
                // Story 2.8 AC1: `hasIntake` here is the closure's pre-update
                // value — `false` means this save is the first-ever intake
                // submit, so ideas should auto-generate with no extra click.
                if (hasIntake === false) setAutoGenerateIdeas(true);
                setHasIntake(true);
                setShowIntakeForm(false);
              }}
            />
          </div>
        ) : viewPlanIdea ? (
          <PlanWorkspace ideaId={viewPlanIdea.id} ideaTitle={viewPlanIdea.title} onBack={() => setViewPlanIdea(null)} />
        ) : (
          <>
            <IdeasPanel
              key={ideasCurrencyKey}
              autoGenerate={autoGenerateIdeas}
              onViewPlan={(id, title) => setViewPlanIdea({ id, title })}
            />
            {/* Guided-flow fix (user-reported): the discovery chat belongs
             * once the user starts working on a chosen idea (`PlanWorkspace`
             * already has its own plan-thread `ChatThread`) — not while
             * ideas are still generating or being picked from, which is the
             * one thing this screen should show (Story 2.8's own "never see
             * actions that don't apply yet"). */}
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
              <div>
                <RevisitIntakeLink onClick={() => setShowIntakeForm(true)} />
              </div>
              <SettingsPage
                onCurrencyChange={() => {
                  setIdeasCurrencyKey((k) => k + 1);
                  setAutoGenerateIdeas(false);
                }}
              />
            </div>
          </>
        )}
        </FadeIn>
      </main>
    </div>
  );
}
