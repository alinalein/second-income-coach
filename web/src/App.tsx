import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { authSessionSchema, getIntakeResponseSchema, type AuthUser } from '@app/shared';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { ThemeToggle } from './theme/theme-toggle';
import { ChatThread } from './chat/ChatThread';
import { IntakeForm } from './features/intake/IntakeForm';

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

  if (authStatus.state !== 'authenticated') {
    return (
      <div className="min-h-screen bg-background text-foreground">
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
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton onSignedOut={refreshAuthStatus} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        {hasIntake === null ? (
          <p className="text-sm text-muted-foreground">{tIntake('loading')}</p>
        ) : showIntakeForm ? (
          <IntakeForm
            onSaved={() => {
              setHasIntake(true);
              setShowIntakeForm(false);
            }}
          />
        ) : (
          <>
            <ChatThread />
            <div>
              <RevisitIntakeLink onClick={() => setShowIntakeForm(true)} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
