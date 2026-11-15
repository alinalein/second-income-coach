import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { GlassCard } from 'shadcn-glass-ui';
import { authSessionSchema, healthStatusSchema, type AuthUser, type HealthStatus } from '@app/shared';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { ThemeToggle } from './theme/theme-toggle';
import { useTheme } from './theme/theme-provider';

type ApiStatus = 'checking' | HealthStatus['status'];

function useApiHealth(): ApiStatus {
  const [status, setStatus] = React.useState<ApiStatus>('checking');

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        const result = healthStatusSchema.safeParse(body);
        setStatus(result.success ? result.data.status : 'error');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

type AuthStatus =
  | { state: 'checking' }
  | { state: 'authenticated'; user: AuthUser }
  | { state: 'unauthenticated' };

/**
 * Mirrors `useApiHealth()` above: calls the gated `GET /api/auth/session`
 * (AC: "authenticated view renders") and treats a 401 as "signed out" rather
 * than an error — that's the expected shape of the auth gate (I/O matrix:
 * "Unauthenticated API call").
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to Second Income Coach</CardTitle>
        <CardDescription>Sign in with your Google account to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        {showError ? (
          <Badge variant="muted" role="alert">
            Sign-in didn&apos;t go through. Please try again.
          </Badge>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button type="button" onClick={() => window.location.assign('/api/auth/google')}>
          Sign in with Google
        </Button>
      </CardFooter>
    </Card>
  );
}

function SignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
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
      Sign out
    </Button>
  );
}

export function App() {
  const { theme } = useTheme();
  const apiStatus = useApiHealth();
  const [authStatus, refreshAuthStatus] = useAuthStatus();
  const hasAuthError = useAuthError();

  if (authStatus.state !== 'authenticated') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
            <span className="text-sm font-semibold tracking-tight">Second Income Coach</span>
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
          <span className="text-sm font-semibold tracking-tight">Second Income Coach</span>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton onSignedOut={refreshAuthStatus} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Signed in as {authStatus.user.name}</CardTitle>
              {/* Decorative only — shadcn-glass-ui wired alongside shadcn/ui,
                  per spec-1-1. No contrast-bearing text lives inside it. */}
              <div data-theme={theme === 'dark' ? 'glass' : 'light'}>
                <GlassCard intensity="subtle" padding="compact" hover={false} aria-hidden="true">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                </GlassCard>
              </div>
            </div>
            <CardDescription>
              TypeScript, Express, React, shared Zod schemas, Drizzle/Postgres, and the themed
              shadcn/ui + shadcn-glass-ui shell — wired end to end, with Google sign-in live.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Badge>Teal accent</Badge>
            <Badge variant="muted">Light default</Badge>
            <Badge variant="muted">
              API: {apiStatus === 'checking' ? 'checking…' : apiStatus === 'ok' ? 'ok' : 'unreachable'}
            </Badge>
          </CardContent>
          <CardFooter>
            <Button>Primary action</Button>
            <Button variant="outline">Secondary</Button>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
