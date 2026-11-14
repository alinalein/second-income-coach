# Evals & Quality Report

TypeScript-only. No Python eval packages (Ragas is Python-only and excluded entirely; DeepEval-TS is optional/beta, not required).

## Tooling

- `agentevals` (npm: `agentevals` + `@langchain/core`):
  - `createTrajectoryMatchEvaluator` — modes `strict`/`unordered`/`subset`/`superset`, plus `toolArgsMatchMode`.
  - `createTrajectoryLLMAsJudge`.
- Runs inside Vitest.
- Results linked to LangSmith.

## Test composition

- **Deterministic Vitest unit tests** for the plain-code tools: `activate_plan`, `complete_step`, the exactly-one-active-plan rule, timeline recalculation.
- **Integration test on real Postgres** (not a mock) exercising the exactly-one-active-plan partial unique constraint (AD-14).
- **Currency conversion/formatting unit tests** (AD-27): both EUR and USD, formatted under both the `de-DE` and `en-US` locales - confirms money is handled as integer minor units + currency code (never floats), conversion uses the configured rate and is labeled an estimate, and the stored sourced-baseline-rate value/citation never changes when the display currency changes.
- **Negative test**: `activate_plan` can never reach `active` status without passing through the HITL pause - no code path skips it.
- **Guardrail tests**: guilt/streak language (AD-12) - run once per personality (CAP-7), not just the default - moderation triggers (AD-11), prompt-injection via `web_search` results (AD-7's moderation-before-cache rule). **All guardrail tests run in both German and English** (CAP-10) - German is not assumed to be covered just because Mistral Moderation's training data includes it; the bespoke guilt/streak-language check specifically needs its own German example patterns, since nothing guarantees it generalizes from English prompts alone. The 100% pass bar applies identically in both languages.
- **Trajectory suite**: 15-25 cases, including a "no tool call on smalltalk" case, versioned as committed fixture files, not generated ad hoc, **with German and English cases both represented** within that range (not a separate suite per language) - two distinct check types:
  - **Trajectory-match cases** (`createTrajectoryMatchEvaluator`, with `toolArgsMatchMode` - tool arguments checked, not just tool names) are fully **deterministic** - no judge model involved.
  - **LLM-as-judge quality cases** (`createTrajectoryLLMAsJudge`) alone use the fixed judge model.
- **Judge model**: `gpt-6-sol` (OpenAI, released 2026-09-23, $2/$10 per 1M input/output) - fixed, pinned by exact id in config, distinct from all 4 registry entries, never exposed in the user-facing model list. **Known limitation to disclose in the report**: the judge shares a provider (OpenAI) with one evaluated registry model (`gpt-6-luna`).
- **Pass thresholds** (two distinct bars, never conflated):
  - **Trajectory/tool-call accuracy**: 80% target, measured **per model**, not as an aggregate average. The report always shows the actual measured number per model, even when below 80% - never suppressed or rounded up.
  - **Safety/guardrail tests**: a hard **100% pass bar**, zero tolerance - guilt/streak language across all 3 personalities, moderation triggers, the `activate_plan` HITL-bypass negative test, and the `web_search` prompt-injection test (all defined above/in Story 7.1).

## Per-model run

The full suite runs at least once against each of the 4 model registry entries (see `stack.md`), so tool-call accuracy is comparable model-to-model, not just validated against whichever one happens to be selected during development. Triggered on demand via `npm run eval` - never wired into CI to run on every commit.

## Report

A single command (e.g. `npm run eval:report`) produces a markdown/HTML evaluation report containing: tool-call accuracy per model (actual numbers, never hidden), which constraint/guardrail tests passed against the 100% bar, a model × accuracy table, the run date, known limitations (cross-referencing Epic 5's Story 5.4, plus the judge/`gpt-6-luna` shared-provider note above), and the eval run's own estimated cost (via the CAP-8/AD-21 token/cost mechanism, applied to the eval run's own model calls). Linked from the README (Epic 5).

**Also emits a machine-readable JSON summary** alongside the human-readable report, with the same facts (per-model accuracy, safety pass/fail, run date, judge model, run cost, limitations) - this is what the public Quality & Decisions page (CAP-11/AD-29) reads, so that page's content is generated from this data rather than a hand-copied summary.
