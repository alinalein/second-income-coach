import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CalendarDays, CircleDollarSign, Flag, ShieldCheck } from 'lucide-react';
import { CircularProgressGlass, MetricCardGlass } from 'shadcn-glass-ui';
import { qualityResponseSchema, type QualityResponse } from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Story 7.5 (AD-28: behind the same auth as every other route, no
 * exception; AD-29: every section below is generated from `GET
 * /api/quality`'s own sources, never hand-typed here).
 */
function useQualityData(): [QualityResponse | undefined, LoadStatus] {
  const [data, setData] = React.useState<QualityResponse | undefined>();
  const [status, setStatus] = React.useState<LoadStatus>('loading');

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/quality', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const body: unknown = await res.json();
        const result = qualityResponseSchema.safeParse(body);
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-sm font-semibold">{children}</h4>;
}

function EvaluationResultsSection({ evals, t }: { evals: QualityResponse['evals']; t: TFunction<'quality'> }) {
  const totalGuardrails = evals.safety.suites.reduce((sum, suite) => sum + suite.total, 0);
  const passedGuardrails = evals.safety.suites.reduce((sum, suite) => sum + suite.passed, 0);
  const guardrailPassRate = totalGuardrails > 0 ? Math.round((passedGuardrails / totalGuardrails) * 100) : 100;

  return (
    <div className="flex flex-col gap-6">
      {/* UX fix (user-requested): a stat-tile summary row up top — the
       * same headline facts the sections below also detail in full, just
       * scannable at a glance first. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCardGlass
          title={t('evaluationResults.runDate')}
          value={evals.runDate.slice(0, 10)}
          icon={<CalendarDays className="h-4 w-4" />}
          showProgress={false}
          showSparkline={false}
        />
        <MetricCardGlass
          title={t('evaluationResults.guardrails.heading')}
          value={`${passedGuardrails}/${totalGuardrails}`}
          description={`${guardrailPassRate}%`}
          icon={<ShieldCheck className="h-4 w-4" />}
          variant={evals.safety.allBuiltSuitesPassed ? 'success' : 'destructive'}
          progress={guardrailPassRate}
          showSparkline={false}
        />
        <MetricCardGlass
          title={t('evaluationResults.cost.heading')}
          value={`$${evals.cost.totalEstimatedCostUsd.toFixed(4)}`}
          icon={<CircleDollarSign className="h-4 w-4" />}
          showProgress={false}
          showSparkline={false}
        />
        {evals.mistralJailbreakFlagRate.status === 'ok' ? (
          <MetricCardGlass
            title={t('evaluationResults.mistralFlagRate.heading')}
            value={`${evals.mistralJailbreakFlagRate.flaggedCount}/${evals.mistralJailbreakFlagRate.total}`}
            icon={<Flag className="h-4 w-4" />}
            variant="warning"
            showProgress={false}
            showSparkline={false}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('evaluationResults.accuracyTable.model')}</SectionHeading>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.accuracyTarget', { target: Math.round(evals.trajectoryAccuracyTarget * 100) })}
        </p>
        {/* UX fix (user-requested): a circular gauge per model — the
         * "graph" alongside the exact-figures table below it. */}
        <div className="flex flex-wrap gap-6">
          {evals.perModelAccuracy.map((row) => (
            <div key={row.modelId} className="flex flex-col items-center gap-2 text-center">
              <CircularProgressGlass
                value={Math.round(row.accuracy * 100)}
                size="sm"
                color={row.meetsTarget ? 'emerald' : 'rose'}
                label={`${Math.round(row.accuracy * 100)}%`}
              />
              <span className="max-w-24 truncate font-mono text-xs text-muted-foreground" title={row.modelId}>
                {row.modelId}
              </span>
            </div>
          ))}
        </div>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('evaluationResults.accuracyTable.model')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.accuracyTable.passed')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.accuracyTable.accuracy')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.accuracyTable.target')}</th>
              </tr>
            </thead>
            <tbody>
              {evals.perModelAccuracy.map((row) => (
                <tr key={row.modelId} className={TABLE_ROW}>
                  <td className={`${TABLE_CELL} font-mono text-xs`}>{row.modelId}</td>
                  <td className={TABLE_CELL}>
                    {row.passedCaseCount}/{row.deterministicCaseCount}
                  </td>
                  <td className={TABLE_CELL}>{Math.round(row.accuracy * 100)}%</td>
                  <td className={TABLE_CELL}>
                    <Badge variant={row.meetsTarget ? 'default' : 'muted'}>{row.meetsTarget ? '✓' : '✗'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                <tr key={suite.file} className={TABLE_ROW}>
                  <td className={TABLE_CELL}>{suite.label}</td>
                  <td className={`${TABLE_CELL} whitespace-nowrap`}>
                    <Badge variant={suite.allPassed ? 'default' : 'muted'}>
                      {suite.passed}/{suite.total}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('evaluationResults.judgeScores.heading')}</SectionHeading>
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
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading>{t('evaluationResults.cost.heading')}</SectionHeading>
        <div className={TABLE_WRAPPER}>
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_CELL}>{t('evaluationResults.cost.model')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.cost.input')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.cost.output')}</th>
                <th className={TABLE_CELL}>{t('evaluationResults.cost.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {evals.cost.perModel.map((row) => (
                <tr key={row.modelId} className={TABLE_ROW}>
                  <td className={`${TABLE_CELL} font-mono text-xs`}>{row.modelId}</td>
                  <td className={TABLE_CELL}>{row.inputTokens}</td>
                  <td className={TABLE_CELL}>{row.outputTokens}</td>
                  <td className={TABLE_CELL}>
                    {row.estimatedCostUsd === null ? t('evaluationResults.cost.unpriced') : `$${row.estimatedCostUsd.toFixed(4)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.cost.total')}: ${evals.cost.totalEstimatedCostUsd.toFixed(4)} ({t('evaluationResults.cost.mechanism')}: {evals.cost.mechanism})
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <SectionHeading>{t('evaluationResults.limitations.heading')}</SectionHeading>
        <ul className="flex flex-col gap-2">
          {evals.limitations.map((limitation) => (
            <li key={limitation.id} className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              {limitation.summary}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DecisionsSection({ decisions, t }: { decisions: QualityResponse['decisions']; t: TFunction<'quality'> }) {
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
  weaknesses: QualityResponse['weaknesses'];
  reflection: QualityResponse['reflection'];
  t: TFunction<'quality'>;
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
 * The signed-in `/quality` page (Story 7.5). `App.tsx` renders this at the
 * same width as the ideas/plan views (`<main>`'s own `max-w-6xl`, no extra
 * wrapper) — user-requested, was narrower. No "Back to app" affordance
 * (user-requested removal) — the sidebar's own navigation is how the user
 * already gets everywhere else in the app; this page needs no second one.
 */
export function QualityPage() {
  const { t } = useTranslation('quality');
  const [data, status] = useQualityData();

  return (
    <div className="flex flex-col gap-6">
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
