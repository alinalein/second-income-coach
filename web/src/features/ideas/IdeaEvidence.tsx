import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { getIntakeResponseSchema, classifyCitationRegion, type IdeaResponse, type CountryCode } from '@app/shared';
import { Badge } from '../../components/ui/badge';

/**
 * Story 2.5. Mirrors `IdeasPanel.tsx`'s own (unexported, not reusable here)
 * `Citation` component exactly — a real URL renders as a hostname-only link,
 * anything else as plain truncated text.
 */
function EvidenceCitation({ citation }: { citation: string }) {
  let url: URL | undefined;
  try {
    url = new URL(citation);
  } catch {
    url = undefined;
  }

  if (url) {
    return (
      <a
        href={citation}
        target="_blank"
        rel="noopener noreferrer"
        title={citation}
        className="block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {url.hostname.replace(/^www\./, '')}
      </a>
    );
  }

  return (
    <span title={citation} className="block truncate text-xs text-muted-foreground">
      {citation}
    </span>
  );
}

/**
 * AC: "a source for another region is labeled on the card (e.g. 'US
 * data')." `undefined` whenever there is nothing to claim either way — no
 * viewer country yet, the viewer chose "other" (no preference), or the
 * citation's domain isn't in `classifyCitationRegion`'s conservative map —
 * never a guessed label.
 */
function foreignSourceRegion(citation: string, viewerCountry: CountryCode | undefined): CountryCode | undefined {
  if (!viewerCountry || viewerCountry === 'other') return undefined;
  const sourceRegion = classifyCitationRegion(citation);
  return sourceRegion && sourceRegion !== viewerCountry ? sourceRegion : undefined;
}

function ForeignSourceBadge({ citation, viewerCountry }: { citation: string; viewerCountry: CountryCode | undefined }) {
  const { t } = useTranslation('ideas');
  const region = foreignSourceRegion(citation, viewerCountry);
  if (!region) return null;
  return <Badge variant="outline">{t('card.foreignSourceLabel', { region: t(`card.region.${region}`) })}</Badge>;
}

/**
 * AC: discovery-sourced demand/trend evidence (note + citation), a
 * translated growth-path note, and a source-region label for both this
 * idea's demand evidence *and* its baseline rate — the baseline-rate
 * citation itself already renders in `IdeasPanel.tsx`'s existing `IdeaCard`
 * footer (off-limits to this story beyond the one line mounting this
 * component), so its region label has to live here instead, clearly
 * attributed to "baseline rate" by its own caption.
 *
 * Fetches `GET /api/intake` itself for the viewer's `country` — the only
 * way to get it to this component without threading a new prop through the
 * frozen `IdeasPanel.tsx`/`src/api/routes/ideas.ts` response shape. Renders
 * nothing extra for an idea predating this story (its new fields are all
 * `null`) rather than treating that as an error.
 */
export function IdeaEvidence({ idea }: { idea: IdeaResponse }) {
  const { t } = useTranslation('ideas');
  const [viewerCountry, setViewerCountry] = React.useState<CountryCode | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/intake', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = getIntakeResponseSchema.safeParse(body);
        if (result.success && result.data.intake) {
          setViewerCountry(result.data.intake.country);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const baselineRegion = foreignSourceRegion(idea.baselineRateCitation, viewerCountry);
  const hasDemandEvidence = idea.demandEvidenceNote !== null && idea.demandEvidenceCitation !== null && idea.demandEvidenceQuote !== null;

  if (!hasDemandEvidence && !idea.growthPath && !baselineRegion) return null;

  return (
    <div className="flex flex-col gap-2 border-t pt-2 text-sm">
      {baselineRegion ? (
        <p className="text-xs text-muted-foreground">
          {t('card.baselineRateLabel')}: {t('card.foreignSourceLabel', { region: t(`card.region.${baselineRegion}`) })}
        </p>
      ) : null}

      {hasDemandEvidence ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('card.demandEvidenceLabel')}</span>
          <p>{idea.demandEvidenceNote}</p>
          <div className="flex flex-wrap items-center gap-2">
            <EvidenceCitation citation={idea.demandEvidenceCitation!} />
            <ForeignSourceBadge citation={idea.demandEvidenceCitation!} viewerCountry={viewerCountry} />
            {idea.isDemandEvidenceUnverified ? <Badge variant="muted">{t('card.unverifiedLabel')}</Badge> : null}
          </div>
        </div>
      ) : null}

      {idea.growthPath ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('card.growthPathLabel')}</span>
          <p>{idea.growthPath}</p>
        </div>
      ) : null}
    </div>
  );
}
