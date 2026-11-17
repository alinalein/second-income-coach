import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getIntakeResponseSchema,
  submitIntakeRequestSchema,
  submitIntakeResponseSchema,
  weeklyTimeAvailabilitySchema,
  startingBudgetRangeSchema,
  riskToleranceSchema,
  countryCodeSchema,
  INTAKE_FREE_TEXT_MAX_LENGTH,
  type IntakeResponse,
  type SubmitIntakeRequest,
} from '@app/shared';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';

/** Client-side cap on how long `POST /api/intake` (an LLM-backed, agent-
 * invoking call) is allowed to hang before this form treats it the same as
 * any other submit failure — no request should ever leave the user staring
 * at "Saving…" forever. Bug fix (user-reported: intake submit "takes long"):
 * must stay longer than the server's own per-call budget
 * (`MODEL_NODE_TIMEOUT_MS`, `src/agent/resilience.ts`, 30s — moderation
 * before + the classification call + moderation after, all within one node)
 * or this form can abort and report "failed" on a request that was still
 * genuinely working server-side and would have succeeded. Same
 * client-longer-than-server margin `IdeasPanel.tsx`'s own
 * `GENERATE_TIMEOUT_MS`/`IDEAS_MODEL_NODE_TIMEOUT_MS` pair already uses. */
const SUBMIT_TIMEOUT_MS = 40_000;

const BLANK_FORM: SubmitIntakeRequest = {
  skillsInterests: '',
  weeklyTimeAvailability: weeklyTimeAvailabilitySchema.options[0]!,
  startingBudgetRange: startingBudgetRangeSchema.options[0]!,
  riskTolerance: riskToleranceSchema.options[0]!,
  stoppedBeforeText: '',
  // Review fix (blind-hunter #5): unlike the other enum defaults above (a
  // wrong starting guess there is just a slightly-off estimate), defaulting
  // to a *specific* country would assert a possibly-false fact about the
  // user that steers real behavior (source-region preference, the "foreign
  // source" label) — 'other' ("no preference / prefer not to say") is the
  // only default that makes no unearned claim.
  country: 'other',
};

function formFromRecord(record: IntakeResponse): SubmitIntakeRequest {
  return {
    skillsInterests: record.skillsInterests,
    weeklyTimeAvailability: record.weeklyTimeAvailability,
    startingBudgetRange: record.startingBudgetRange,
    riskTolerance: record.riskTolerance,
    stoppedBeforeText: record.stoppedBeforeText,
    country: record.country,
  };
}

type FieldErrors = Partial<Record<keyof SubmitIntakeRequest, string>>;

export interface IntakeFormProps {
  /** Called once a submission has been persisted and read back (AC: the app
   * shows chat next). */
  onSaved: (record: IntakeResponse) => void;
}

/**
 * AC1/AC5/AC6: the structured intake form. Fetches `GET /api/intake` on
 * mount to prefill (I/O matrix: "Revisit with existing intake"; blank if the
 * user has none yet — "No intake yet"); validates client-side with the
 * shared `submitIntakeRequestSchema` before ever posting (AC6).
 * `failurePattern` is deliberately not a field here — the agent classifies
 * it while handling the POST (Boundary: "never a client-supplied field").
 */
export function IntakeForm({ onSaved }: IntakeFormProps) {
  const { t } = useTranslation('intake');
  const [form, setForm] = React.useState<SubmitIntakeRequest>(BLANK_FORM);
  const [loaded, setLoaded] = React.useState(false);
  // 'submitting': POST in flight. 'idle'/'error' both render the normal,
  // editable form — 'error' just adds the error message. On success,
  // `onSaved` fires immediately (no separate confirmation phase/delay).
  const [phase, setPhase] = React.useState<'idle' | 'submitting' | 'error'>('idle');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const submitting = phase === 'submitting';
  const disabled = submitting;

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    // Must reset to `true` on each (re-)run, not just rely on the `useRef`
    // initializer: React 19's `<StrictMode>` (enabled in `main.tsx`, dev-only)
    // double-invokes this effect on mount (mount -> cleanup -> mount again),
    // so a setup that does nothing would leave `.current` stuck at `false`
    // from the first cleanup for the component's entire real lifetime — every
    // `if (isMountedRef.current)` guard below would then silently no-op
    // forever, even though the fetch itself completes fine (this was
    // swallowing every success/error transition, including `onSaved`).
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/intake', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = getIntakeResponseSchema.safeParse(body);
        if (result.success && result.data.intake) {
          setForm(formFromRecord(result.data.intake));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = React.useCallback(
    (key: keyof SubmitIntakeRequest) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        setForm((prev) => ({ ...prev, [key]: event.target.value }));
      },
    [],
  );

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (disabled) return;

      // AC6: client-side `submitIntakeRequestSchema.safeParse` before any
      // POST — an invalid/missing field never reaches the network.
      const parseResult = submitIntakeRequestSchema.safeParse(form);
      if (!parseResult.success) {
        const nextFieldErrors: FieldErrors = {};
        for (const issue of parseResult.error.issues) {
          const key = issue.path[0] as keyof SubmitIntakeRequest | undefined;
          if (key && !nextFieldErrors[key]) {
            nextFieldErrors[key] = issue.code === 'too_big' ? t('error.tooLong') : t('error.required');
          }
        }
        setFieldErrors(nextFieldErrors);
        return;
      }

      setFieldErrors({});
      setPhase('submitting');

      // No request should leave the user staring at "Saving…" forever — a
      // hung/slow agent turn is treated the same as any other submit failure.
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

      fetch('/api/intake', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parseResult.data),
        signal: controller.signal,
      })
        .then(async (res) => {
          const body: unknown = await res.json();
          const result = submitIntakeResponseSchema.safeParse(body);
          if (!res.ok || !result.success) {
            if (isMountedRef.current) setPhase('error');
            return;
          }
          if (isMountedRef.current) onSaved(result.data.intake);
        })
        .catch(() => {
          // Covers both a thrown network error and the timeout abort above —
          // on failure or timeout, fall back out of the pending state with
          // fields re-enabled so the user can retry.
          if (isMountedRef.current) setPhase('error');
        })
        .finally(() => window.clearTimeout(timeoutId));
    },
    [disabled, form, onSaved, t],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} aria-busy={submitting}>
        <CardContent className="flex flex-col gap-5">
          {!loaded ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-skillsInterests">{t('skillsInterests.label')}</Label>
            <Textarea
              id="intake-skillsInterests"
              value={form.skillsInterests}
              onChange={handleChange('skillsInterests')}
              placeholder={t('skillsInterests.placeholder')}
              maxLength={INTAKE_FREE_TEXT_MAX_LENGTH}
              disabled={disabled}
            />
            {fieldErrors.skillsInterests ? (
              <Badge variant="muted" role="alert">
                {fieldErrors.skillsInterests}
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-weeklyTimeAvailability">{t('weeklyTimeAvailability.label')}</Label>
            <Select
              id="intake-weeklyTimeAvailability"
              value={form.weeklyTimeAvailability}
              onChange={handleChange('weeklyTimeAvailability')}
              disabled={disabled}
            >
              {weeklyTimeAvailabilitySchema.options.map((option) => (
                <option key={option} value={option}>
                  {t(`weeklyTimeAvailability.options.${option}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-startingBudgetRange">{t('startingBudgetRange.label')}</Label>
            <Select
              id="intake-startingBudgetRange"
              value={form.startingBudgetRange}
              onChange={handleChange('startingBudgetRange')}
              disabled={disabled}
            >
              {startingBudgetRangeSchema.options.map((option) => (
                <option key={option} value={option}>
                  {t(`startingBudgetRange.options.${option}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-riskTolerance">{t('riskTolerance.label')}</Label>
            <Select
              id="intake-riskTolerance"
              value={form.riskTolerance}
              onChange={handleChange('riskTolerance')}
              disabled={disabled}
            >
              {riskToleranceSchema.options.map((option) => (
                <option key={option} value={option}>
                  {t(`riskTolerance.options.${option}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-country">{t('country.label')}</Label>
            <Select id="intake-country" value={form.country} onChange={handleChange('country')} disabled={disabled}>
              {countryCodeSchema.options.map((option) => (
                <option key={option} value={option}>
                  {t(`country.options.${option}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-stoppedBeforeText">{t('stoppedBeforeText.label')}</Label>
            <Textarea
              id="intake-stoppedBeforeText"
              value={form.stoppedBeforeText}
              onChange={handleChange('stoppedBeforeText')}
              placeholder={t('stoppedBeforeText.placeholder')}
              maxLength={INTAKE_FREE_TEXT_MAX_LENGTH}
              disabled={disabled}
            />
            {fieldErrors.stoppedBeforeText ? (
              <Badge variant="muted" role="alert">
                {fieldErrors.stoppedBeforeText}
              </Badge>
            ) : null}
          </div>

          {phase === 'error' ? (
            <Badge variant="muted" role="alert">
              {t('error.submitFailed')}
            </Badge>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-2">
          <Button type="submit" disabled={disabled}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('savingButton')}
              </>
            ) : (
              t('submitButton')
            )}
          </Button>
          {/* UX fix (user-reported: submit "takes long" with no explanation)
           * — the real cause (moderation + the model's own classification
           * call, AD-4/AD-11) can't be removed without weakening either, so
           * this sets honest expectations instead of leaving a bare spinner,
           * same pattern as `IdeasPanel`'s `generatingHint`/`PlanWorkspace`'s
           * `loadingHint`. */}
          {submitting ? (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {t('savingHint')}
            </p>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
