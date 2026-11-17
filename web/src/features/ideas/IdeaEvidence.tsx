import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { getIntakeResponseSchema, classifyCitationRegion, type IdeaResponse, type CountryCode } from '@app/shared';

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
 * never a guessed label. Exported — `IdeasPanel.tsx`'s own compact citation
 * line (user-requested, Story 2.5 follow-up) needs this too, since that
 * line can't be fully owned by this file (see `IdeaEvidence`'s own doc
 * comment below).
 */
export function foreignSourceRegion(citation: string, viewerCountry: CountryCode | undefined): CountryCode | undefined {
  if (!viewerCountry || viewerCountry === 'other') return undefined;
  const sourceRegion = classifyCitationRegion(citation);
  return sourceRegion && sourceRegion !== viewerCountry ? sourceRegion : undefined;
}

/**
 * User-requested follow-up (compact citation line): lifted out of
 * `IdeaEvidence` so `IdeasPanel.tsx`'s `IdeaCard` can fetch the viewer's
 * country exactly once per card and share it with both its own compact
 * baseline-rate citation line and this component's demand-evidence line —
 * previously each `IdeaEvidence` instance fetched independently (5 calls
 * per panel); this is the same data, now fetched once per card either way.
 */
export function useViewerCountry(): CountryCode | undefined {
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

  return viewerCountry;
}

/** User-requested follow-up: plain comma-separated text, matching
 * `IdeasPanel.tsx`'s own baseline-rate citation line exactly (not a
 * bordered pill) — both citation lines now share one visual style. */
function ForeignSourceLabel({ citation, viewerCountry }: { citation: string; viewerCountry: CountryCode | undefined }) {
  const { t } = useTranslation('ideas');
  const region = foreignSourceRegion(citation, viewerCountry);
  if (!region) return null;
  return <span>, {t('card.foreignSourceLabel', { region: t(`card.region.${region}`) })}</span>;
}

/** Exported so `IdeasPanel.tsx`'s always-visible toggle-row teaser
 * (user-requested follow-up: "Aktuelle Nachfrage" replaces the old cited-
 * fields-count text there) can check this without duplicating the
 * condition. */
export function hasDemandEvidence(idea: IdeaResponse): boolean {
  return idea.demandEvidenceNote !== null && idea.demandEvidenceCitation !== null && idea.demandEvidenceQuote !== null;
}

/**
 * AC: discovery-sourced demand/trend evidence (note + citation) and a
 * translated growth-path note. The baseline-rate region label used to live
 * here too (the baseline citation itself renders in `IdeasPanel.tsx`), but
 * a user-requested follow-up merged it into that same citation line for a
 * single compact line instead of two — see `IdeasPanel.tsx`'s `IdeaCard`.
 *
 * `viewerCountry` is now a prop (user-requested follow-up) — fetched once
 * per card by the caller (`useViewerCountry`) and shared with its own
 * compact citation line, instead of this component fetching independently
 * a second time for the same data.
 */
export function IdeaEvidence({ idea, viewerCountry }: { idea: IdeaResponse; viewerCountry: CountryCode | undefined }) {
  const { t } = useTranslation('ideas');

  if (!hasDemandEvidence(idea) && !idea.growthPath) return null;

  return (
    // User-requested follow-up: this block now renders first in the
    // Details panel (ahead of the cited-fields chips and citation line in
    // `IdeasPanel.tsx`), so the divider moved from its own top edge to its
    // own bottom edge — it still separates demand/growth content from what
    // follows, just on the other side now that the order flipped.
    // User-requested follow-up: a little more breathing room between the
    // demand and growth-path blocks — matches the panel's own `gap-3`
    // (`IdeasPanel.tsx`).
    <div className="flex flex-col gap-3 border-b pb-3 text-sm">
      {hasDemandEvidence(idea) ? (
        // User-requested follow-up: no repeated "Current demand" heading
        // here — the always-visible toggle-row teaser in `IdeasPanel.tsx`
        // already announces it once, right before this panel opens.
        <div className="flex flex-col gap-1">
          <p>{idea.demandEvidenceNote}</p>
          {/* User-requested follow-up: same plain, comma-separated style as
           * `IdeasPanel.tsx`'s baseline-rate citation line (citation,
           * region if foreign, "unverified" if applicable) — no bordered
           * pill for either the region label or "unverified" here. */}
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <EvidenceCitation citation={idea.demandEvidenceCitation!} />
            <ForeignSourceLabel citation={idea.demandEvidenceCitation!} viewerCountry={viewerCountry} />
            {idea.isDemandEvidenceUnverified ? <span>, {t('card.unverifiedLabel')}</span> : null}
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
