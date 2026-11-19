import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { qualityResponseSchema, type QualityResponse } from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
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

function EvaluationResultsSection({ evals, t }: { evals: QualityResponse['evals']; t: TFunction<'quality'> }) {
  return (
    <div className="flex flex-col gap-6">
      <span className="text-xs text-muted-foreground">
        {t('evaluationResults.runDate')}: {evals.runDate.slice(0, 10)}
      </span>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.accuracyTarget', { target: Math.round(evals.trajectoryAccuracyTarget * 100) })}
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.accuracyTable.model')}</th>
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.accuracyTable.passed')}</th>
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.accuracyTable.accuracy')}</th>
              <th className="py-1 font-medium">{t('evaluationResults.accuracyTable.target')}</th>
            </tr>
          </thead>
          <tbody>
            {evals.perModelAccuracy.map((row) => (
              <tr key={row.modelId} className="border-b border-border/50">
                <td className="py-1 pr-2 font-mono text-xs">{row.modelId}</td>
                <td className="py-1 pr-2">
                  {row.passedCaseCount}/{row.deterministicCaseCount}
                </td>
                <td className="py-1 pr-2">{Math.round(row.accuracy * 100)}%</td>
                <td className="py-1">
                  <Badge variant={row.meetsTarget ? 'default' : 'muted'}>{row.meetsTarget ? '✓' : '✗'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">{t('evaluationResults.guardrails.heading')}</h4>
          <Badge variant={evals.safety.allBuiltSuitesPassed ? 'default' : 'muted'}>
            {evals.safety.allBuiltSuitesPassed
              ? t('evaluationResults.guardrails.allPassedLabel')
              : t('evaluationResults.guardrails.notAllPassedLabel')}
          </Badge>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.guardrails.suite')}</th>
              <th className="py-1 font-medium">{t('evaluationResults.guardrails.result')}</th>
            </tr>
          </thead>
          <tbody>
            {evals.safety.suites.map((suite) => (
              <tr key={suite.file} className="border-b border-border/50">
                <td className="py-1 pr-2">{suite.label}</td>
                <td className="py-1">
                  {suite.passed}/{suite.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('evaluationResults.judgeScores.heading')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.judgeScores.judgeModelsLabel')}: {evals.judges.judgeModelIds.join(', ')}
        </p>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="sticky top-0 border-b border-border bg-card text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">{t('evaluationResults.judgeScores.model')}</th>
                <th className="py-1 pr-2 font-medium">{t('evaluationResults.judgeScores.case')}</th>
                <th className="py-1 pr-2 font-medium">{t('evaluationResults.judgeScores.judge')}</th>
                <th className="py-1 font-medium">{t('evaluationResults.judgeScores.score')}</th>
              </tr>
            </thead>
            <tbody>
              {evals.judges.qualityResults.map((row, index) => (
                <tr key={`${row.modelId}-${row.caseId}-${row.judgeId}-${index}`} className="border-b border-border/50 align-top">
                  <td className="py-1 pr-2 font-mono text-xs">{row.modelId}</td>
                  <td className="py-1 pr-2 text-xs">{row.caseId}</td>
                  <td className="py-1 pr-2 font-mono text-xs">{row.judgeId}</td>
                  <td className="py-1 text-xs">
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

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('evaluationResults.mistralFlagRate.heading')}</h4>
        {evals.mistralJailbreakFlagRate.status === 'ok' ? (
          <p className="text-sm">
            {t('evaluationResults.mistralFlagRate.flaggedOf', {
              flagged: evals.mistralJailbreakFlagRate.flaggedCount,
              total: evals.mistralJailbreakFlagRate.total,
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('evaluationResults.mistralFlagRate.pending', { reason: evals.mistralJailbreakFlagRate.reason })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('evaluationResults.cost.heading')}</h4>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.cost.model')}</th>
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.cost.input')}</th>
              <th className="py-1 pr-2 font-medium">{t('evaluationResults.cost.output')}</th>
              <th className="py-1 font-medium">{t('evaluationResults.cost.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {evals.cost.perModel.map((row) => (
              <tr key={row.modelId} className="border-b border-border/50">
                <td className="py-1 pr-2 font-mono text-xs">{row.modelId}</td>
                <td className="py-1 pr-2">{row.inputTokens}</td>
                <td className="py-1 pr-2">{row.outputTokens}</td>
                <td className="py-1">
                  {row.estimatedCostUsd === null ? t('evaluationResults.cost.unpriced') : `$${row.estimatedCostUsd.toFixed(4)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">
          {t('evaluationResults.cost.total')}: ${evals.cost.totalEstimatedCostUsd.toFixed(4)} ({t('evaluationResults.cost.mechanism')}: {evals.cost.mechanism})
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('evaluationResults.limitations.heading')}</h4>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {evals.limitations.map((limitation) => (
            <li key={limitation.id}>{limitation.summary}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DecisionsSection({ decisions, t }: { decisions: QualityResponse['decisions']; t: TFunction<'quality'> }) {
  return (
    <div className="flex flex-col gap-3">
      {decisions.map((decision) => (
        <div key={decision.id} className="flex flex-col gap-1 border-b border-border/50 pb-3 text-sm last:border-none">
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
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('reflection.promptVsRagVsAgents')}</h4>
        <p className="whitespace-pre-line text-sm text-muted-foreground">{reflection.agentVsPromptEngineeringVsRag}</p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('reflection.knownWeaknesses.heading')}</h4>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('reflection.knownWeaknesses.weakness')}</th>
              <th className="py-1 pr-2 font-medium">{t('reflection.knownWeaknesses.impact')}</th>
              <th className="py-1 font-medium">{t('reflection.knownWeaknesses.suggestion')}</th>
            </tr>
          </thead>
          <tbody>
            {weaknesses.knownWeaknesses.map((row) => (
              <tr key={row.id} className="border-b border-border/50 align-top">
                <td className="py-1 pr-2">{row.weakness}</td>
                <td className="py-1 pr-2 text-muted-foreground">{row.impact}</td>
                <td className="py-1 text-muted-foreground">{row.suggestion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('reflection.edgeCases.heading')}</h4>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('reflection.edgeCases.scenario')}</th>
              <th className="py-1 pr-2 font-medium">{t('reflection.edgeCases.whatHappens')}</th>
              <th className="py-1 font-medium">{t('reflection.edgeCases.suggestion')}</th>
            </tr>
          </thead>
          <tbody>
            {weaknesses.edgeCases.map((row) => (
              <tr key={row.id} className="border-b border-border/50 align-top">
                <td className="py-1 pr-2">{row.scenario}</td>
                <td className="py-1 pr-2 text-muted-foreground">{row.whatHappens}</td>
                <td className="py-1 text-muted-foreground">{row.suggestion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('reflection.codeImprovements.heading')}</h4>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t('reflection.codeImprovements.suggestion')}</th>
              <th className="py-1 font-medium">{t('reflection.codeImprovements.why')}</th>
            </tr>
          </thead>
          <tbody>
            {weaknesses.codeImprovements.map((row) => (
              <tr key={row.id} className="border-b border-border/50 align-top">
                <td className="py-1 pr-2">{row.suggestion}</td>
                <td className="py-1 text-muted-foreground">{row.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The signed-in `/quality` page (Story 7.5). `onBackToApp` is a plain nav
 * callback from `App.tsx`'s own router — this component owns no routing
 * itself.
 */
export function QualityPage({ onBackToApp }: { onBackToApp: () => void }) {
  const { t } = useTranslation('quality');
  const [data, status] = useQualityData();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">{t('title')}</h2>
        <Button type="button" variant="outline" size="sm" onClick={onBackToApp}>
          {t('backToApp')}
        </Button>
      </div>

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
