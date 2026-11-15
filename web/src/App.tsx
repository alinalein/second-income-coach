import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { GlassCard } from 'shadcn-glass-ui';
import { healthStatusSchema, type HealthStatus } from '@app/shared';
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

export function App() {
  const { theme } = useTheme();
  const apiStatus = useApiHealth();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">Second Income Coach</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Project scaffolding is live</CardTitle>
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
              shadcn/ui + shadcn-glass-ui shell — wired end to end, no feature logic yet.
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
