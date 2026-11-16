import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { authSessionSchema, type AuthUser } from '@app/shared';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { ThemeToggle } from './theme/theme-toggle';
import { ChatThread } from './chat/ChatThread';
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
  const [authStatus, refreshAuthStatus] = useAuthStatus();
  const hasAuthError = useAuthError();
  // AC: "it is applied when the app loads for a signed-in user" — only once
  // a session is confirmed, never speculatively while still signed out.
  useAppliedUiLanguage(authStatus.state === 'authenticated');

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

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <ChatThread />
        <SettingsPage />
      </main>
    </div>
  );
}
