# Epic 6 Context: Automated Evaluation & Quality Report

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give a grader, collaborator, or future maintainer objective proof that the agent's tool-calling actually works across every selectable model — not a claim in a README, but an automated test suite plus a generated report backing it.

## Stories

- Story 6.1: Deterministic Tool & Guardrail Tests
- Story 6.2: Trajectory Eval Suite Across All Models
- Story 6.3: Evaluation Report Generation

## Requirements & Constraints

- All evals are TypeScript-only, running inside Vitest; no Python eval package (e.g. Ragas) is ever introduced.
- Two pass bars, never conflated: safety/guardrail tests (guilt/streak-language across all 3 personalities, moderation, HITL-bypass negative test, `web_search` prompt-injection, direct prompt-injection outcome test) require a hard 100% pass rate, zero tolerance. Trajectory/tool-call accuracy targets 80% per model (not an aggregate), as a single tunable constant, and the actual measured number is always shown even below target — never suppressed or rounded up.
- Bilingual coverage (FR15/CAP-10) is mandatory, not optional: guardrail tests and the direct-prompt-injection cases each run in both German and English at the same 100% bar; the trajectory suite's 15-25 cases include both languages within one suite (not separate suites per language).
- Direct prompt-injection is a distinct guardrail case from the jailbreak/moderation trigger, covering 4 patterns (ignore instructions, output system prompt, list tools, injected instruction embedded in a normal check-in message); assertions target the outcome (no non-schema tool call, no plan reaching `active` without the HITL pause, no system-prompt/tool-list disclosure), not which layer caught it.
- Mistral Moderation's own jailbreak-category flag rate on the direct-injection inputs is recorded as a separate, non-gating, visibility-only metric — it never affects pass/fail, since Mistral Moderation 2 itself is still pending validation.
- The suite runs on demand via `npm run eval` only — never wired into CI on every commit.
- Eval results are linked to LangSmith.
- The report (Story 6.3) must show tool-call accuracy per model, guardrail pass/fail, a model x accuracy table, run date, known limitations, and the eval run's own estimated cost; one command (`npm run eval:report`) produces it end to end, plus a machine-readable JSON summary with the same facts. That JSON is the source the public Quality & Decisions page (Epic 7) reads — never hand-copied.

## Technical Decisions

- **AD-23 (eval tooling):** `agentevals` running inside Vitest — `createTrajectoryMatchEvaluator` with `toolArgsMatchMode` for fully deterministic tool-argument checks (no judge model), and `createTrajectoryLLMAsJudge` for quality-only judging. Suite composition: deterministic unit tests for plain-code tools; one real-Postgres integration test for the exactly-one-active-plan constraint (AD-14); the HITL-bypass negative test; guardrail tests; the 15-25 case versioned trajectory suite (fixture files committed in-repo), including a "no tool call on smalltalk" case.
- **Judge models:** two fixed, exactly-pinned judges — `google/gemini-3.8-flash` and `deepseek/deepseek-v4.1-flash`. The latter is judge-only, never user-selectable. The former is also a user-selectable registry entry, so it can judge its own model's trajectories — this overlap must be disclosed in the report as a known limitation, stating which judge scored which model.
- **AD-20 (model registry):** 3 user-selectable chat entries, all via OpenRouter — `openai/gpt-6-luna` (default), `google/gemini-3.8-flash`, `anthropic/claude-haiku-4.5`. `anthropic/claude-sonnet-5.5` exists only in eval config — eval-only, never in the registry or settings dropdown. Moderation and transcription models are never user-selectable regardless of registry contents. The full eval suite runs at least once against each of the 3 registry entries plus the eval-only model (4 total).
- **AD-14 (HITL plan activation):** `activate_plan` uses LangGraph's `interrupt()`/`Command({resume})` pattern; the active-plan transition is enforced by a database-level partial unique constraint (one active plan per user) inside a single transaction. This constraint needs a real-Postgres integration test, not a mock.
- **AD-12 (guilt/streak-language):** a separate lightweight `afterModel` check, scoped to CAP-4 responses, distinct from general moderation (AD-11) — must be tested once per personality (CAP-7: formal/friendly/terse), since personality must never weaken it.
- **AD-11 (moderation):** Mistral Moderation 2 (`mistral-moderation-2603`) at three hook points (`beforeModel`, `wrapToolCall` around `web_search`, `afterModel`). Its own adoption is still pending validation — hence the non-gating jailbreak-flag-rate metric in 6.1/6.2.
- **AD-27 (currency):** money stored as integer minor units + ISO code, never floats; conversion via one configured rate with an as-of date, no live FX call; every converted amount labeled "estimate." Unit tests must cover both EUR and USD formatted under both `de-DE` and `en-US` locales, and confirm changing currency never mutates a stored sourced-baseline rate or its citation.
- **AD-16 (shared Zod schemas):** the "no tool call outside Zod-validated schemas" assertion in the injection tests relies on this shared schema layer as the enforcement boundary.
- FR15/CAP-10 (bilingual): reply language is determined per-message from what the user wrote, independent of UI-language setting (AD-25) — this is why guardrail/injection tests must run in both languages rather than relying on one.

## Cross-Story Dependencies

- Story 6.2 and 6.3 depend on Story 6.1's guardrail test outcomes and on the model registry (AD-20) being in place.
- Story 6.3's JSON summary is a direct input to Epic 7 Story 7.5 (public Quality & Decisions page) and is cross-referenced by Epic 7 Story 7.4 (known-weaknesses/traceability docs) and linked from the Epic 7 README.
