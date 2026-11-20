import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CalendarDays, CircleDollarSign, Flag, ShieldCheck } from 'lucide-react';
import { CircularProgressGlass, MetricCardGlass } from 'shadcn-glass-ui';
import { evaluationResponseSchema, type EvaluationResponse } from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ChatTurnDiagram } from './ChatTurnDiagram';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Story 7.5 (AD-28: behind the same auth as every other route, no
 * exception; AD-29: every section below is generated from `GET
 * /api/evaluation`'s own sources, never hand-typed here).
 */
function useEvaluationData(): [EvaluationResponse | undefined, LoadStatus] {
  const [data, setData] = React.useState<EvaluationResponse | undefined>();
  const [status, setStatus] = React.useState<LoadStatus>('loading');

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/evaluation', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const body: unknown = await res.json();
        const result = evaluationResponseSchema.safeParse(body);
        if (result.success) {
          setData(result.data);
          setStatus('loaded');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return [data, status];
}

/** UX fix (user-requested): "the page looks ugly, make it more visually
 * appealing, use some graphs and tables" — shared table chrome (rounded
 * container, a muted header row, zebra-striped body rows) used by every
 * table on this page instead of each one hand-rolling its own borders. */
const TABLE_WRAPPER = 'overflow-hidden rounded-lg border border-border';
const TABLE_HEAD_ROW = 'bg-muted/50 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground';
const TABLE_CELL = 'px-3 py-2';
const TABLE_ROW = 'even:bg-muted/20';

/** User-requested (2026-11-20, amended): `build-report.ts`'s own 3
 * cost-related limitation ids (`unpriced-eval-only-model`,
 * `cost-mechanism-not-built`, `judge-call-cost-excluded`) all describe or
 * point at the cost section — dropped from the rendered list whenever that
 * section is hidden, replaced by the page's own single "Run cost is not
 * shown" line below. */
const COST_RELATED_LIMITATION_IDS = new Set(['unpriced-eval-only-model', 'cost-mechanism-not-built', 'judge-call-cost-excluded']);

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-sm font-semibold">{children}</h4>;
}

/** User-requested (2026-11-20, amended): "hide cost until it is complete,
 * no partial sums" — only once every group (target models, Sonnet, judges)
 * actually recorded usage AND has a price does the page show a cost figure
 * at all. `groups` itself is optional (backward compat with a published
 * file written before per-group cost reporting existed) — absent counts as
 * incomplete, the same as any group not `'measured'`. Data/schema are
 * unchanged; this is a page-only decision. */
function isCostComplete(cost: EvaluationResponse['evals']['cost']): boolean {
  if (!cost.groups) return false;
  return cost.groups.targetModels.status === 'measured' && cost.groups.sonnet.status === 'measured' && cost.groups.judges.status === 'measured';
}

function EvaluationResultsSection({ evals, t }: { evals: EvaluationResponse['evals']; t: TFunction<'evaluation'> }) {
  const totalGuardrails = evals.safety.suites.reduce((sum, suite) => sum + suite.total, 0);
  const passedGuardrails = evals.safety.suites.reduce((sum, suite) => sum + suite.passed, 0);
  const guardrailPassRate = totalGuardrails > 0 ? Math.round((passedGuardrails / totalGuardrails) * 100) : 100;
  const costComplete = isCostComplete(evals.cost);

  // User-requested (2026-11-20, amended): "keep the stat-tile row balanced
  // (3 tiles, no gap)" when cost is hidden — built as a list, then laid out
  // in exactly as many columns as there are tiles (never a leftover empty
  // cell). Deliberately a single, non-responsive `grid-cols-N` class (see
  // the gauges-row comment below) rather than combining a bare `grid-cols-2`
  // with an `sm:grid-cols-4` variant of the same property, which collides
  // with `shadcn-glass-ui/styles.css`'s own bundled utilities layer.
  const tiles = [
    <MetricCardGlass
      key="runDate"
      title={t('evaluationResults.runDate')}
      value={evals.runDate.slice(0, 10)}
      icon={<CalendarDays className="h-4 w-4" />}
      showProgress={false}
      showSparkline={false}
    />,
    <MetricCardGlass
      key="guardrails"
      title={t('evaluationResults.guardrails.heading')}
      value={`${passedGuardrails}/${totalGuardrails}`}
      description={`${guardrailPassRate}%`}
      icon={<ShieldCheck className="h-4 w-4" />}
      variant={evals.safety.allBuiltSuitesPassed ? 'success' : 'destructive'}
      progress={guardrailPassRate}
      showSparkline={false}
    />,
    costComplete ? (
      <MetricCardGlass
        key="cost"
        title={t('evaluationResults.cost.heading')}
        value={`$${evals.cost.totalEstimatedCostUsd.toFixed(4)}`}
        // User-requested (2026-11-20, amended): the headline card shows
        // the exact same short label as the detail "Total (...)" line
        // below — never a separate, hardcoded "priced target models
        // only" qualifier that could drift out of sync with it.
        description={evals.cost.totalLabel}
        icon={<CircleDollarSign className="h-4 w-4" />}
        showProgress={false}
        showSparkline={false}
      />
    ) : null,
    evals.mistralJailbreakFlagRate.status === 'ok' ? (
      <MetricCardGlass
        key="mistralFlagRate"
        title={t('evaluationResults.mistralFlagRate.heading')}
        value={`${evals.mistralJailbreakFlagRate.flaggedCount}/${evals.mistralJailbreakFlagRate.total}`}
        icon={<Flag className="h-4 w-4" />}
        variant="warning"
        showProgress={false}
        showSparkline={false}
      />
    ) : null,
  ].filter((tile): tile is React.ReactElement => tile !== null);

  const tileGridColsClass = tiles.length >= 4 ? 'grid-cols-4' : tiles.length === 3 ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <div className="flex flex-col gap-6">
      {/* UX fix (user-requested): a stat-tile summary row up top — the
       * same headline facts the sections below also detail in full, just
       * scannable at a glance first. */}
      <div className={`grid gap-3 ${tileGridColsClass}`}>{tiles}</div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('evaluationResults.accuracyTable.model')}</SectionHeading>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.accuracyTarget', { target: Math.round(evals.trajectoryAccuracyTarget * 100) })}
        </p>
        {/* User-requested (2026-11-20, amended): replaced the separate
         * "Model accuracy" table entirely — a 4-column table of mostly
         * short values (model id, "13/13", "100%", one badge) next to the
         * much longer-content guardrail/judge tables below it kept reading
         * as "misaligned" no matter how its own columns were sized (fixed
         * widths, `table-fixed`, both already tried). One stat card per
         * model instead — same full-width, always-4-across `grid-cols-4`
         * as the page's other stat rows (see that pattern's own doc
         * comment on the tile row above) — folds the gauge and every
         * table column into one block, so there's no second table left to
         * visually compare against the ones below it at all. */}
        <div className="grid grid-cols-4 gap-4">
          {evals.perModelAccuracy.map((row) => (
            <div key={row.modelId} className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/10 p-4 text-center">
              <CircularProgressGlass
                value={Math.round(row.accuracy * 100)}
                size="sm"
                color={row.meetsTarget ? 'emerald' : 'rose'}
                label={`${Math.round(row.accuracy * 100)}%`}
              />
              <span className="max-w-full truncate font-mono text-xs text-muted-foreground" title={row.modelId}>
                {row.modelId}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('evaluationResults.accuracyTable.passed')}: {row.passedCaseCount}/{row.deterministicCaseCount}
              </span>
              <Badge variant={row.meetsTarget ? 'default' : 'muted'}>
                {t('evaluationResults.accuracyTable.target')} {row.meetsTarget ? '✓' : '✗'}
              </Badge>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading>{t('evaluationResults.guardrails.heading')}</SectionHeading>
          <Badge variant={evals.safety.allBuiltSuitesPassed ? 'default' : 'muted'}>
            {evals.safety.allBuiltSuitesPassed
              ? t('evaluationResults.guardrails.allPassedLabel')
              : t('evaluationResults.guardrails.notAllPassedLabel')}
          </Badge>
        </div>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('evaluationResults.guardrails.suite')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.guardrails.result')}</th>
              </tr>
            </thead>
            <tbody>
              {evals.safety.suites.map((suite) => (
                <React.Fragment key={suite.file}>
                  <tr className={TABLE_ROW}>
                    <td className={TABLE_CELL}>{suite.label}</td>
                    <td className={`${TABLE_CELL} whitespace-nowrap`}>
                      <Badge variant={suite.allPassed ? 'default' : 'muted'}>
                        {suite.passed}/{suite.total}
                      </Badge>
                    </td>
                  </tr>
                  {/* User-requested (2026-11-20): "write under each a short
                   * example [of] the text that was actually sent" — real,
                   * copied-verbatim example from the suite's own fixture
                   * (`guardrails.ts`'s `GUARDRAIL_SUITES`, AD-29: never
                   * hand-typed on the page itself). Optional for backward
                   * compatibility with a published file written before
                   * this field existed. */}
                  {suite.example ? (
                    <tr className={TABLE_ROW}>
                      <td colSpan={2} className={`${TABLE_CELL} text-xs italic text-muted-foreground`}>
                        {suite.example}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('evaluationResults.judgeScores.heading')}</SectionHeading>
        {/* User-requested (2026-11-20): "i don't even know what the judges
         * judged" — this table has no fixed reference to check against
         * (unlike the Model accuracy table above, which is an exact-match
         * check); each row is 2 judge models grading one real agent run
         * against a deliberately messy/indirect input for whether it makes
         * sense and reaches the goal, not whether it matches a reference. */}
        <p className="text-xs text-muted-foreground">{t('evaluationResults.judgeScores.description')}</p>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.judgeScores.judgeModelsLabel')}: {evals.judges.judgeModelIds.join(', ')}
        </p>
        <div className={`${TABLE_WRAPPER} max-h-64 overflow-y-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className={`${TABLE_HEAD_ROW} sticky top-0`}>
                <th className={TABLE_CELL}>{t('evaluationResults.judgeScores.model')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.judgeScores.case')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.judgeScores.judge')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.judgeScores.score')}</th>
              </tr>
            </thead>
            <tbody>
              {evals.judges.qualityResults.map((row, index) => (
                <tr key={`${row.modelId}-${row.caseId}-${row.judgeId}-${index}`} className={`${TABLE_ROW} align-top`}>
                  <td className={`${TABLE_CELL} font-mono text-xs`}>{row.modelId}</td>
                  <td className={`${TABLE_CELL} text-xs`}>{row.caseId}</td>
                  <td className={`${TABLE_CELL} font-mono text-xs`}>{row.judgeId}</td>
                  <td className={`${TABLE_CELL} text-xs`}>
                    {row.error ? (
                      <Badge variant="muted">{t('evaluationResults.judgeScores.errorLabel')}</Badge>
                    ) : typeof row.score === 'boolean' ? (
                      row.score
                        ? t('evaluationResults.judgeScores.yes')
                        : t('evaluationResults.judgeScores.no')
                    ) : (
                      row.score
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* User-requested (2026-11-20): "write a short sentence with
         * conclusion, as for now i am not sure what that's supposed to
         * show off" — a one-line summary computed from the real rows
         * above (never hand-typed, AD-29), explaining what the table
         * demonstrates: how often the 2 pinned judges scored a sampled
         * quality case as acceptable, and how many judge calls themselves
         * failed (excluded from that count, not counted as a "No"). */}
        {(() => {
          const judgedRows = evals.judges.qualityResults.filter((row) => row.error === undefined);
          const yesCount = judgedRows.filter((row) => row.score === true).length;
          const errorCount = evals.judges.qualityResults.length - judgedRows.length;
          return (
            <p className="text-xs text-muted-foreground">
              {t('evaluationResults.judgeScores.conclusion', { yesCount, judgedCount: judgedRows.length })}
              {errorCount > 0 ? ` ${t('evaluationResults.judgeScores.conclusionErrors', { errorCount })}` : ''}
            </p>
          );
        })()}
      </div>

      {/* User-requested (2026-11-20, amended): "hide cost until it is
       * complete, no partial sums" — the whole section (tile already
       * handled above, per-model table, groups table, total line) only
       * ever renders once `costComplete` is true. The matching "Run cost
       * is not shown" limitations line is appended below, page-side only —
       * `evals.limitations` itself is untouched. */}
      {costComplete ? (
        <div className="flex flex-col gap-3">
          <SectionHeading>{t('evaluationResults.cost.heading')}</SectionHeading>
          <div className={TABLE_WRAPPER}>
            <table className="w-full text-sm">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.model')}</th>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.role')}</th>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.input')}</th>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.output')}</th>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {evals.cost.perModel.map((row) => (
                  <tr key={`${row.modelId}-${row.role ?? 'target'}`} className={TABLE_ROW}>
                    <td className={`${TABLE_CELL} font-mono text-xs`}>{row.modelId}</td>
                    <td className={`${TABLE_CELL} text-xs`}>{row.role ?? 'target'}</td>
                    <td className={TABLE_CELL}>{row.inputTokens}</td>
                    <td className={TABLE_CELL}>{row.outputTokens}</td>
                    <td className={TABLE_CELL}>{`$${(row.estimatedCostUsd ?? 0).toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={TABLE_WRAPPER}>
            <table className="w-full text-sm">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.group')}</th>
                  <th className={TABLE_CELL}>{t('evaluationResults.cost.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [t('evaluationResults.cost.groupTargetModels'), evals.cost.groups!.targetModels],
                    [t('evaluationResults.cost.groupSonnet'), evals.cost.groups!.sonnet],
                    [t('evaluationResults.cost.groupJudges'), evals.cost.groups!.judges],
                  ] as const
                ).map(([label, group]) => (
                  <tr key={label} className={TABLE_ROW}>
                    <td className={TABLE_CELL}>{label}</td>
                    <td className={TABLE_CELL}>{`$${(group.estimatedCostUsd ?? 0).toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            {/* `costComplete` guarantees every group is `'measured'`, so
             * `totalLabel` here is always the no-exclusion form (e.g.
             * "target models + Sonnet + judges") — never a partial-sum
             * disclosure, since a partial sum is never shown at all. */}
            {t('evaluationResults.cost.total')}
            {evals.cost.totalLabel ? ` (${evals.cost.totalLabel})` : ''}: ${evals.cost.totalEstimatedCostUsd.toFixed(4)} (
            {t('evaluationResults.cost.mechanism')}: {evals.cost.mechanism})
          </p>
        </div>
      ) : null}

      {/* Optional for backward compatibility with a published eval-results.json
       * written before this field existed (same `evals.mistralJailbreakFlagRate`
       * guarded-render precedent above) — simply not rendered yet, never a
       * broken page over one missing section. */}
      {evals.latency ? (
        (() => {
          // User-requested (2026-11-20, amended): never render a column of
          // nothing but "Not measured" — the trajectory-case column only
          // earns its place once at least one model actually has a
          // recorded `durationMs` (a full `npm run eval` run), not just the
          // cheap standalone `npm run eval:latency` measurement.
          const hasTrajectoryData = evals.latency.deterministicByModel.some((row) => row.medianMs !== null);
          return (
            <div className="flex flex-col gap-3">
              <SectionHeading>{t('evaluationResults.latency.heading')}</SectionHeading>
              <p className="text-xs text-muted-foreground">
                {hasTrajectoryData ? t('evaluationResults.latency.descriptionWithTrajectory') : t('evaluationResults.latency.description')}
              </p>
              <div className={TABLE_WRAPPER}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_CELL}>{t('evaluationResults.latency.model')}</th>
                      <th className={TABLE_CELL}>{t('evaluationResults.latency.ackMedian')}</th>
                      <th className={TABLE_CELL}>{t('evaluationResults.latency.ackMax')}</th>
                      <th className={TABLE_CELL}>{t('evaluationResults.latency.calls')}</th>
                      {hasTrajectoryData ? <th className={TABLE_CELL}>{t('evaluationResults.latency.trajectoryMedian')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {evals.latency.ackByModel.map((row) => {
                      const trajectoryRow = evals.latency?.deterministicByModel.find((entry) => entry.modelId === row.modelId);
                      return (
                        <tr key={row.modelId} className={TABLE_ROW}>
                          <td className={`${TABLE_CELL} font-mono text-xs`}>{row.modelId}</td>
                          <td className={TABLE_CELL}>{row.medianMs === null ? t('evaluationResults.latency.notMeasured') : `${Math.round(row.medianMs)} ms`}</td>
                          <td className={TABLE_CELL}>{row.maxMs === null ? t('evaluationResults.latency.notMeasured') : `${Math.round(row.maxMs)} ms`}</td>
                          <td className={TABLE_CELL}>{row.calls ?? 0}</td>
                          {hasTrajectoryData ? (
                            <td className={TABLE_CELL}>
                              {trajectoryRow?.medianMs == null ? t('evaluationResults.latency.notMeasured') : `${Math.round(trajectoryRow.medianMs)} ms`}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()
      ) : null}

      <div className="flex flex-col gap-2">
        <SectionHeading>{t('evaluationResults.limitations.heading')}</SectionHeading>
        <ul className="flex flex-col gap-2">
          {/* User-requested (2026-11-20, amended): "when you remove the
           * estimated cost, you should also remove what was related to
           * it" — these 3 ids (`build-report.ts`'s own cost-related
           * limitations) all describe or point at the cost section; once
           * that section is hidden they'd dangle (e.g. "see the cost
           * groups above" when there's no cost section above any more).
           * The one `!costComplete` line below replaces all of them. */}
          {(costComplete ? evals.limitations : evals.limitations.filter((l) => !COST_RELATED_LIMITATION_IDS.has(l.id))).map((limitation) => (
            <li key={limitation.id} className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              {limitation.summary}
            </li>
          ))}
          {/* User-requested (2026-11-20, amended): "when hidden, add one
           * line to Known limitations" — page-computed only, `evals.
           * limitations` itself (server-generated, AD-29) stays untouched.
           * Hardcoded English, not run through `t()`, matching every
           * sibling `<li>` above: `evals.limitations` is report content,
           * always English regardless of UI language (the page's own
           * `contentLanguageNotice` banner). */}
          {!costComplete ? (
            <li key="cost-not-shown" className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              Run cost is not shown: judge-model usage was not recorded in this run.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function DecisionsSection({ decisions, t }: { decisions: EvaluationResponse['decisions']; t: TFunction<'evaluation'> }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {decisions.map((decision) => (
        <div key={decision.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/10 p-4 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{decision.id}</Badge>
            <span className="font-semibold">{decision.title}</span>
          </div>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{t('decisions.reason')}:</span> {decision.reason}
          </p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{t('decisions.tradeoff')}:</span> {decision.tradeoff}
          </p>
        </div>
      ))}
    </div>
  );
}

function ReflectionSection({
  weaknesses,
  reflection,
  t,
}: {
  weaknesses: EvaluationResponse['weaknesses'];
  reflection: EvaluationResponse['reflection'];
  t: TFunction<'evaluation'>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/10 p-4">
        <SectionHeading>{t('reflection.promptVsRagVsAgents')}</SectionHeading>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          {reflection.agentVsPromptEngineeringVsRag.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('reflection.knownWeaknesses.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('reflection.knownWeaknesses.weakness')}</th>
                <th className={TABLE_CELL}>{t('reflection.knownWeaknesses.impact')}</th>
                <th className={TABLE_CELL}>{t('reflection.knownWeaknesses.suggestion')}</th>
              </tr>
            </thead>
            <tbody>
              {weaknesses.knownWeaknesses.map((row) => (
                <tr key={row.id} className={`${TABLE_ROW} align-top`}>
                  <td className={TABLE_CELL}>{row.weakness}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.impact}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.suggestion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('reflection.edgeCases.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('reflection.edgeCases.scenario')}</th>
                <th className={TABLE_CELL}>{t('reflection.edgeCases.whatHappens')}</th>
                <th className={TABLE_CELL}>{t('reflection.edgeCases.suggestion')}</th>
              </tr>
            </thead>
            <tbody>
              {weaknesses.edgeCases.map((row) => (
                <tr key={row.id} className={`${TABLE_ROW} align-top`}>
                  <td className={TABLE_CELL}>{row.scenario}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.whatHappens}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.suggestion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('reflection.codeImprovements.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('reflection.codeImprovements.suggestion')}</th>
                <th className={TABLE_CELL}>{t('reflection.codeImprovements.why')}</th>
              </tr>
            </thead>
            <tbody>
              {weaknesses.codeImprovements.map((row) => (
                <tr key={row.id} className={`${TABLE_ROW} align-top`}>
                  <td className={TABLE_CELL}>{row.suggestion}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Story 7.5/7.2: "Tools" section — both pipe tables parsed server-side from
 * `docs/TECHNICAL-RATIONALE.md`'s own "Tool boundary" section (AD-29: never
 * hand-copied), plus the "One chat turn (middleware lifecycle)" diagram
 * (same Mermaid source as `ARCHITECTURE-SPINE.md`, drawn by hand as a
 * static, theme-aware SVG — see `ChatTurnDiagram.tsx`'s own doc comment).
 */
function ToolsSection({ tools, t }: { tools: EvaluationResponse['tools']; t: TFunction<'evaluation'> }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionHeading>{t('tools.agentTools.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('tools.agentTools.whereUserIs')}</th>
                <th className={TABLE_CELL}>{t('tools.agentTools.agentThread')}</th>
                <th className={TABLE_CELL}>{t('tools.agentTools.toolsModelCanCall')}</th>
              </tr>
            </thead>
            <tbody>
              {tools.agentTools.map((row, index) => (
                <tr key={index} className={`${TABLE_ROW} align-top`}>
                  <td className={TABLE_CELL}>{row.whereUserIs}</td>
                  <td className={TABLE_CELL}>{row.agentThread}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.toolsModelCanCall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('tools.toolDetails.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('tools.toolDetails.tool')}</th>
                <th className={TABLE_CELL}>{t('tools.toolDetails.kind')}</th>
                <th className={TABLE_CELL}>{t('tools.toolDetails.whoCallsIt')}</th>
                <th className={TABLE_CELL}>{t('tools.toolDetails.whereInFlow')}</th>
                <th className={TABLE_CELL}>{t('tools.toolDetails.whatItDoes')}</th>
                <th className={TABLE_CELL}>{t('tools.toolDetails.writesState')}</th>
              </tr>
            </thead>
            <tbody>
              {tools.toolDetails.map((row) => (
                <tr key={row.tool} className={`${TABLE_ROW} align-top`}>
                  <td className={`${TABLE_CELL} font-mono text-xs`}>{row.tool}</td>
                  <td className={TABLE_CELL}>{row.kind}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.whoCallsIt}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.whereInFlow}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.whatItDoes}</td>
                  <td className={`${TABLE_CELL} text-muted-foreground`}>{row.writesState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('tools.diagram.heading')}</SectionHeading>
        <div className="rounded-lg border border-border bg-muted/10 p-4">
          <ChatTurnDiagram />
        </div>
        <p className="text-xs text-muted-foreground">{t('tools.diagram.caption')}</p>
      </div>
    </div>
  );
}

/**
 * The signed-in `/evaluation` page (Story 7.5). `App.tsx` renders this at
 * the same width as the ideas/plan views (`<main>`'s own `max-w-6xl`, no
 * extra wrapper) — user-requested, was narrower. No "Back to app" affordance
 * (user-requested removal) — the sidebar's own navigation is how the user
 * already gets everywhere else in the app; this page needs no second one.
 */
export function EvaluationPage() {
  const { t } = useTranslation('evaluation');
  const [data, status] = useEvaluationData();

  return (
    <div className="flex flex-col gap-6 pb-10">
      <h2 className="text-xl font-semibold tracking-tight">{t('title')}</h2>

      {status === 'loading' ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}
      {status === 'error' ? (
        <p className="text-sm text-muted-foreground" role="alert">
          {t('error')}
        </p>
      ) : null}

      {status === 'loaded' && data ? (
        <>
          <p className="text-xs text-muted-foreground" role="note">
            {t('contentLanguageNotice')}
          </p>
          <Card>
            <CardHeader>
              <CardTitle>{t('evaluationResults.heading')}</CardTitle>
            </CardHeader>
            <CardContent>
              <EvaluationResultsSection evals={data.evals} t={t} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('decisions.heading')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DecisionsSection decisions={data.decisions} t={t} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('tools.heading')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ToolsSection tools={data.tools} t={t} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('reflection.heading')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ReflectionSection weaknesses={data.weaknesses} reflection={data.reflection} t={t} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
