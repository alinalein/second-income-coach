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

/** Bug fix (user-reported, live): on a re-save, the button itself goes
 * straight back to its resting label — a small "Changes saved" note next to
 * it is what shows for this long instead (also dismissed immediately,
 * regardless of this timer, the instant the user edits a field again —
 * `handleChange` below cancels the pending dismissal and clears it right
 * away). Never shown for a first-ever save, since `onSaved` there navigates
 * this component away before this state is ever reached. */
const SAVED_CONFIRMATION_DURATION_MS = 2_000;

/** Bug fix (user-reported, live): "the Saving… appears for just a
 * millisecond, looking like a glitch" — intake save is a fast plain DB
 * write (AC: "stored immediately ... within 1s"), so the real round trip is
 * often well under this. A floor on how long the button's own `'submitting'`
 * display stays up (never on `onSaved(...)` itself — that still fires the
 * instant the real response lands, so a first-ever save's redirect/ideas-
 * generation start is never delayed by this) turns that flash into a
 * deliberate, readable state instead. */
const MIN_SAVING_VISIBLE_MS = 400;

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

/** UX fix (user-requested): a small fixed set of mutually-exclusive options
 * (time/budget/risk below) as a row of pill buttons instead of a `<select>`
 * dropdown — the selected one filled, the rest outlined, same shape as the
 * reference screenshot. `country` keeps the native `Select` (too many
 * options for this to read well as pills). */
function PillSelect<T extends string>({
  labelId,
  value,
  options,
  getLabel,
  onChange,
}: {
  labelId: string;
  value: T;
  options: readonly T[];
  getLabel: (option: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = option === value;
        return (
          <Button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            variant={selected ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
            onClick={() => onChange(option)}
          >
            {getLabel(option)}
          </Button>
        );
      })}
    </div>
  );
}

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
  // editable form — 'error' just adds the error message.
  //
  // Bug fix (user-reported, live): the button used to stay stuck on
  // "Saving…" forever after a successful save — the success branch below
  // called `onSaved(...)` but never transitioned `phase` back out of
  // `'submitting'` at all (only the failure branch did). Invisible on a
  // first-ever save, since `onSaved` there navigates this component away
  // before the stuck state could ever be seen; very visible on a re-save,
  // which stays mounted on this same form.
  const [phase, setPhase] = React.useState<'idle' | 'submitting' | 'error'>('idle');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const submitting = phase === 'submitting';
  // Bug fix (user-reported, live): "only the button changes" — this used to
  // also disable every field (`disabled:opacity-50` on `Select`/`Textarea`),
  // which dimmed the *entire form* the instant a save started and un-dimmed
  // it moments later, read as the whole form jumping/flickering. Scoped to
  // the submit button alone now (prevents a double-submit, which is all it
  // was really there for) — the fields stay fully interactive throughout; a
  // mid-flight edit doesn't corrupt anything since the in-flight request
  // already has its own snapshot of `form` from when it started.
  const disabled = submitting;
  // Bug fix (user-reported, live): a re-save's own feedback — "Changes
  // saved" next to the button, for `SAVED_CONFIRMATION_DURATION_MS` or
  // until the next edit, whichever comes first (Spec 2.12 AC1 amendment: a
  // re-save stays on this form instead of being redirected away by
  // `App.tsx`). Never set on a first-ever save (see that effect's own doc
  // comment on `SAVED_CONFIRMATION_DURATION_MS` above).
  const [justSaved, setJustSaved] = React.useState(false);
  const savedDismissTimeoutRef = React.useRef<number | null>(null);
  const clearSavedDismissTimeout = React.useCallback(() => {
    if (savedDismissTimeoutRef.current !== null) {
      window.clearTimeout(savedDismissTimeoutRef.current);
      savedDismissTimeoutRef.current = null;
    }
  }, []);
  React.useEffect(() => clearSavedDismissTimeout, [clearSavedDismissTimeout]);

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

  const setField = React.useCallback(
    (key: keyof SubmitIntakeRequest, value: string) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      // Bug fix (user-reported, live): dismisses "Changes saved"
      // immediately on the next edit, rather than waiting out the rest of
      // its timer — cancels the pending auto-dismiss (it would otherwise
      // still fire later and no-op harmlessly, but there's no reason to
      // leave it dangling).
      clearSavedDismissTimeout();
      setJustSaved(false);
    },
    [clearSavedDismissTimeout],
  );

  const handleChange = React.useCallback(
    (key: keyof SubmitIntakeRequest) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        setField(key, event.target.value);
      },
    [setField],
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
      // Bug fix (user-reported, live): "the Saving… appears for just a
      // millisecond, looking like a glitch" — see `MIN_SAVING_VISIBLE_MS`'s
      // own doc comment. Measured from here (not from the fetch call below)
      // so it covers the client-side validation branch's own negligible
      // cost too, though that's never the bottleneck.
      const submitStartedAt = Date.now();

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
          const remainingMs = Math.max(0, MIN_SAVING_VISIBLE_MS - (Date.now() - submitStartedAt));

          if (!res.ok || !result.success) {
            window.setTimeout(() => {
              if (isMountedRef.current) setPhase('error');
            }, remainingMs);
            return;
          }

          // `onSaved` fires the instant the real response lands, never
          // delayed by the floor below — a first-ever save's redirect/ideas-
          // generation start must never wait on this.
          onSaved(result.data.intake);
          window.setTimeout(() => {
            if (!isMountedRef.current) return;
            // Bug fix (user-reported, live): this is the line that was
            // missing entirely — the button must leave `'submitting'` on
            // success too, not just on failure (the actual stuck-button
            // bug). Goes straight back to its resting label; "Changes
            // saved" next to it is the feedback, not the button itself.
            setPhase('idle');
            setJustSaved(true);
            clearSavedDismissTimeout();
            savedDismissTimeoutRef.current = window.setTimeout(() => {
              if (isMountedRef.current) setJustSaved(false);
            }, SAVED_CONFIRMATION_DURATION_MS);
          }, remainingMs);
        })
        .catch(() => {
          // Covers both a thrown network error and the timeout abort above —
          // on failure or timeout, fall back out of the pending state with
          // fields re-enabled so the user can retry.
          const remainingMs = Math.max(0, MIN_SAVING_VISIBLE_MS - (Date.now() - submitStartedAt));
          window.setTimeout(() => {
            if (isMountedRef.current) setPhase('error');
          }, remainingMs);
        })
        .finally(() => window.clearTimeout(timeoutId));
    },
    [disabled, form, onSaved, t, clearSavedDismissTimeout],
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
            />
            {fieldErrors.skillsInterests ? (
              <Badge variant="muted" role="alert">
                {fieldErrors.skillsInterests}
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label id="intake-weeklyTimeAvailability-label">{t('weeklyTimeAvailability.label')}</Label>
            <PillSelect
              labelId="intake-weeklyTimeAvailability-label"
              value={form.weeklyTimeAvailability}
              options={weeklyTimeAvailabilitySchema.options}
              getLabel={(option) => t(`weeklyTimeAvailability.options.${option}`)}
              onChange={(value) => setField('weeklyTimeAvailability', value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label id="intake-startingBudgetRange-label">{t('startingBudgetRange.label')}</Label>
            <PillSelect
              labelId="intake-startingBudgetRange-label"
              value={form.startingBudgetRange}
              options={startingBudgetRangeSchema.options}
              getLabel={(option) => t(`startingBudgetRange.options.${option}`)}
              onChange={(value) => setField('startingBudgetRange', value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-riskTolerance">{t('riskTolerance.label')}</Label>
            <Select id="intake-riskTolerance" value={form.riskTolerance} onChange={handleChange('riskTolerance')}>
              {riskToleranceSchema.options.map((option) => (
                <option key={option} value={option}>
                  {t(`riskTolerance.options.${option}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="intake-country">{t('country.label')}</Label>
            <Select id="intake-country" value={form.country} onChange={handleChange('country')}>
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
        {/* Bug fix (user-reported, live): "Changes saved" belongs next to
         * the button, at the same height — not on its own line below it —
         * so `flex-row items-center` (not the stacked `flex-col` this used
         * to be). */}
        <CardFooter className="flex flex-row items-center gap-3">
          <Button type="submit" disabled={disabled}>
            {phase === 'submitting' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('savingButton')}
              </>
            ) : (
              t('submitButton')
            )}
          </Button>
          {/* Bug fix (user-reported, live): a re-save's own small, separate
           * confirmation — next to the button, never inside it, and only
           * ever for `SAVED_CONFIRMATION_DURATION_MS` (or until the next
           * edit, whichever comes first). */}
          {justSaved ? (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {t('savedConfirmation')}
            </p>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
