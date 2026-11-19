---
title: 'Story 6.1: Deterministic Tool & Guardrail Tests (continuation)'
type: 'chore'
created: '2026-11-18'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The prior Story 6.1 build (`spec-6-1-deterministic-tool-guardrail-tests.md`, `status: done`) deferred several named ACs as blocked on unbuilt tools: `activate_plan`, `complete_step`, exactly-one-active-plan, timeline recalculation, the guilt/streak-language guardrail (AD-12, once per personality), and the 4th direct-prompt-injection case (injected instruction inside a check-in message). Epic 3 (plan activation) and Epic 4 (check-ins/steps/guilt-language) have since shipped, unblocking all of these.

**Approach:** Close exactly the ACs no longer blocked. `activate_plan`, exactly-one-active-plan, and the HITL-bypass negative test turned out to already be covered by `activate_plan.test.ts` from a prior story — cited, not duplicated. Added deterministic/integration tests for `complete_step`, `start_step`, `record_check_in`, and `getCurrentStep`'s timeline-recalculation write; extended `guilt-language.test.ts` with a once-per-personality case and `direct-prompt-injection.test.ts` with the 4th injection form. Updated `src/evals/guardrails.ts`'s `GUARDRAIL_SUITES`/`PENDING_GUARDRAIL_CATEGORIES` so the Story 6.3 report reflects that `guilt-streak-language` and `hitl-bypass` are no longer pending (only `mistral-flag-rate`, which genuinely needs a live run, remains). Currency (AD-27) and AD-23 ("no Python eval package") were already fully covered by a prior story — no changes needed there.

</frozen-after-approval>

## Implementation Notes

- `src/tools/plain/complete_step.test.ts` (new): integration tests (real Postgres) — advances to the next step, completes the plan on the final step, rejects a non-current `stepId` (AD-13 state machine).
- `src/tools/plain/start_step.test.ts` (new): same pattern — sets `startedAt`, rejects a non-current `stepId`.
- `src/tools/plain/record_check_in.test.ts` (new): records a check-in and resets `timelineAnchorAt` (AD-15); `getCheckInStatus` is true across the user's other plans, not just the one checked into (Story 4.1 AC).
- `src/tools/plain/get_current_step.test.ts` (extended): added a real-Postgres integration describe block proving the actual timeline-recalculation write — pending/current steps' `dayOffset` shifts forward by the missed-day count, a `completed` step's `dayOffset` is untouched, and the anchor resets. The pure day-math (`computeMissedDays`) was already covered; this is the DB-write half of AC1's "timeline recalculation."
- `src/agent/guilt-language.test.ts` (extended): new `it.each` over the 3 personalities (formal/friendly/terse) — AD-20 ("personality is a prompt layer only, never bypasses a constraint") means the guardrail has no personality parameter at all, so this proves the fallback still triggers regardless of which personality's tone produced the flagged text.
- `src/agent/direct-prompt-injection.test.ts` (extended): 2 new `it.each` rows (EN+DE) for the 4th named case — an injected instruction inside an otherwise normal check-in message. No check-in-specific wiring needed: the `beforeModel` moderation hook screens every turn's last human message regardless of which tools are registered for that thread.
- `src/evals/guardrails.ts`: added `agent/guilt-language.test.ts` and `tools/plain/activate_plan.test.ts` to `GUARDRAIL_SUITES` (the Story 6.3 report's own pass/fail mechanism); removed the now-stale `guilt-streak-language`/`hitl-bypass` entries from `PENDING_GUARDRAIL_CATEGORIES`. `mistral-flag-rate` stays pending (genuinely needs a live Mistral run — Story 6.1's own AC defers this to report generation).
- Consequential fixes (same change, not a new defect): `src/evals/build-report.test.ts` and `src/evals/render.test.ts` each hardcoded an assertion against the now-removed `hitl-bypass` pending entry/label — updated both to assert against what's still true (`mistral-flag-rate` remains pending, `hitl-bypass` does not).
- Not changed: `shared/money.test.ts` already fully covers AD-27's EUR/USD × de-DE/en-US matrix, integer-minor-units rejection, and conversion/estimate-labeling from a prior story. The "changing currency never alters a stored baseline rate/citation" sub-clause stays proven by inspection (`setCurrency`'s own signature only ever touches `user_settings`) rather than a new test, per the prior story's own documented reasoning — still accurate.
- Follow-up (user-requested): `agent/moderation.test.ts` (general AD-11 — jailbreak/PII/unsafe-output, EN+DE) added to `GUARDRAIL_SUITES`, same as the others. No `testNamePattern` needed — unlike `activate_plan.test.ts`, every test in this file is itself an AD-11 moderation test (no unrelated DB/other-concern tests mixed in), and it needs no real DB/network (all `classify` calls are mocked). Nothing to remove from `PENDING_GUARDRAIL_CATEGORIES` — this category was never listed there (a silent omission from `GUARDRAIL_SUITES`, not a documented pending item). `build-report.test.ts`/`render.test.ts` needed no changes: both inject a synthetic `GuardrailSuiteResult[]` fixture directly into `buildReport()` rather than reading the live `GUARDRAIL_SUITES` constant, and nothing was removed from `PENDING_GUARDRAIL_CATEGORIES` this time.

## Review Triage Log

One reviewer, scoped to guardrail-outcome correctness only (per instruction), over the new/changed guardrail files (`direct-prompt-injection.test.ts`'s 4th case, `guilt-language.test.ts`'s personality case, `guardrails.ts`'s suite/pending-list edit, and the consequential `build-report.test.ts`/`render.test.ts` fixes).

- **`medium` (patched):** adding the whole `tools/plain/activate_plan.test.ts` file to `GUARDRAIL_SUITES` violated that module's own documented invariant ("each deterministic and free of any real network call ... safe to run every time") and would have aggregated 6 unrelated DB-integration tests (unique-index constraint, resume/pause, draft-save) under the "HITL-bypass" label — an unrelated failure there would have misreported as a guardrail failure, and the label overclaimed what was actually being measured. Evidence: hand-confirmed the file has 7 tests across 4 describe blocks, only 1 of which (`createActivatePlanGraph`, "pauses on a fresh invocation...") is the HITL-bypass test. **Fix:** added an optional `testNamePattern` field to `GuardrailSuiteDef`, passed as vitest's own `-t` filter in `runGuardrailSuites`, scoping this entry to exactly that one test.
- **Second-order bug found while patching (self-caught, not from the reviewer):** vitest's `-t` filter reports non-matching tests as `status: 'skipped'` (`numPendingTests`), not excluded from `numTotalTests` — the scoped entry would have reported "7 total, 1 passed" instead of "1 total, 1 passed." Fixed `parseVitestJsonReport` to subtract `numPendingTests` from `total` (optional field, defaults to 0, so the pre-existing fixtures in `guardrails.test.ts` still parse unchanged); added a table-driven case for it.
- **`false` (item 1, direct-prompt-injection.test.ts):** reviewer checked whether the DE 4th-case fixture text would actually resolve to `'de'` via `detectReplyLanguage`'s real heuristic (not just the mocked `classify`). Confirmed: "außerdem" contains ß, an unambiguous German-character match independent of the mock; the EN fixture has no umlaut/ß and no German-stopword overlap. Not a bug.
- **`false` (item 2, guilt-language.test.ts):** reviewer hand-matched all 3 personality `flaggedText` fixtures against `GUILT_LANGUAGE_PATTERNS` — all 3 genuinely match and enter the regenerate/fallback path, not the pass-through path. Not a bug.
- **`false` (item 4, build-report.test.ts/render.test.ts):** both assert against the live `PENDING_GUARDRAIL_CATEGORIES`/`buildReport` output, not a fixture — genuine assertions, not no-ops. Not a bug.

## Verification

**Commands:**
- `npx vitest run tools/plain/complete_step.test.ts tools/plain/start_step.test.ts tools/plain/record_check_in.test.ts tools/plain/get_current_step.test.ts --config vitest.config.ts` (from `src/`) -- all pass
- `npx vitest run agent/guilt-language.test.ts agent/direct-prompt-injection.test.ts agent/moderation-web-search.test.ts evals/build-report.test.ts evals/render.test.ts evals/guardrails.test.ts --config vitest.config.ts` (from `src/`) -- all pass
- `npm test --workspace=src` -- 56 files / 511 tests pass
- `npm run test --workspace=shared` -- 6 files / 41 tests pass (unchanged; confirms AD-27 coverage still green)
