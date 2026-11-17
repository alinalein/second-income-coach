import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { planResponseSchema, type PlanResponse } from '@app/shared';
import { Button } from '../../components/ui/button';
import { ChatThread } from '../../chat/ChatThread';
import { StatusPanel } from './StatusPanel';

export interface PlanWorkspaceProps {
  ideaId: string;
  /** UI fix (user-reported): shown in `StatusPanel`'s title ("Your plan for
   * <idea>") so the workspace is identifiable as belonging to this specific
   * idea, not a bare "Your plan". Passed down from the idea card that
   * navigated here — never re-fetched, since the idea's own title doesn't
   * change. */
  ideaTitle: string;
  onBack: () => void;
}

/**
 * Code Map/AC: "a single unified screen (option A) — a status sidebar/
 * header ... and a projection card alongside one chat thread ... never
 * split into separate 'Overview'/'Chat' tabs." This is the one file any
 * story may edit for this layout (Boundary) — later stories (4.x, 5.2,
 * 5.3) fill the extension points below without restructuring it.
 *
 * Lazily creates-or-fetches the plan via `POST /api/plans/select/:ideaId`
 * (AD-13: lazy, never eager) on mount, then renders the shell once it
 * resolves. Narrow-screen collapse (AC): `flex-col` by default (the
 * `StatusPanel` stacks above the chat column, reading as a compact header),
 * `sm:flex-row` restores the sidebar-beside-chat layout at the `sm`
 * breakpoint and up.
 */
export function PlanWorkspace({ ideaId, ideaTitle, onBack }: PlanWorkspaceProps) {
  const { t } = useTranslation('plan');
  const [plan, setPlan] = React.useState<PlanResponse | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setLoadFailed(false);

    fetch(`/api/plans/select/${ideaId}`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setLoadFailed(true);
          return;
        }
        const body: unknown = await res.json();
        const result = planResponseSchema.safeParse(body);
        if (result.success) setPlan(result.data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [ideaId]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {t('backToIdeas')}
        </Button>
      </div>

      {loadFailed ? (
        <p className="text-sm text-muted-foreground" role="alert">
          {t('loadFailed')}
        </p>
      ) : !plan ? (
        // Matches IdeasPanel's own "Generating…" loading pattern (status
        // line + "this can take a few seconds" hint) rather than a bare
        // one-liner, for the same wait (a lazy `create_plan` LLM call).
        <div className="flex flex-col gap-2" aria-live="polite" role="status">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
          <p className="text-xs text-muted-foreground">{t('loadingHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-4 sm:w-64 sm:shrink-0">
            <StatusPanel planId={plan.id} ideaTitle={ideaTitle} />
            {/* Code Map: "projection card extension point (a slot in the
             * sidebar/header) ... renders nothing until 4.4". */}
          </div>
          <div className="flex-1">
            <ChatThread endpoint={`/api/plans/${plan.id}/messages`} />
          </div>
        </div>
      )}
    </div>
  );
}
