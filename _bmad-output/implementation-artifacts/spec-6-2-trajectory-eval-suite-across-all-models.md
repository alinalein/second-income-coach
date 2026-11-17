---
title: 'Story 6.2: Trajectory Eval Suite Across All Models'
type: 'feature'
created: '2026-11-16'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '00273c4d72686a48dbf7b872833ba6d475e7ecf0'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 6 (AD-23) needs an `agentevals`-based trajectory eval harness proving tool-calling accuracy per model across all 4 evaluated models (3 registry entries + eval-only `anthropic/claude-sonnet-5.5`), with a 15-25 case versioned fixture suite, deterministic `toolArgsMatchMode` cases plus LLM-judge quality cases, and a results file Story 6.3's report reads. None of this exists yet.

**Approach:** Build `src/evals/` as a Vitest-based harness, run only via `npm run eval` (separate Vitest config/glob so it never joins the default `npm test`/CI suite). Reuse `createCoachAgent` as-is for real model behavior, with one additive seam (a `tools` override) so eval cases can swap in fast/no-cost stand-ins for `generate_ideas` (schema-identical, instant fake handler — the real factory makes its own nested real-model call, which would compound per-model cost) while reusing the real `submit_intake` tool unmodified (cheap, no model call). Fixture cases are committed JSON files under `src/evals/fixtures/`; `set_ui_language`/`set_currency` are **not** agent-callable (AD-20), so their fixtures are reframed as negative cases — the agent must emit zero tool calls when asked to change them via chat — per the human's explicit decision, recorded below.

**Decision (resolves the set_ui_language/set_currency conflict):** Fixtures named after `set_ui_language`/`set_currency` assert the agent proposes **no tool call** (and no hallucinated tool name) when the user asks in chat to change language/currency — this is the only form these cases can take without reversing AD-20, and it directly exercises AD-20's "agent never autonomously changes UI language or currency" rule.

</frozen-after-approval>

## Boundaries & Constraints

**Always:** Deterministic cases use `createTrajectoryMatchEvaluator` with `toolArgsMatchMode: 'exact'`, no judge model. Quality cases use `createTrajectoryLLMAsJudge` with the two pinned judges (`google/gemini-3.8-flash`, `deepseek/deepseek-v4.1-flash`), built via `createChatModel(env, judgeId)` (OpenRouter) and passed as the `judge` param (not the `model: "provider:id"` string form, which assumes native provider APIs). The 80% per-model target is one named constant (`TRAJECTORY_ACCURACY_TARGET`). `anthropic/claude-sonnet-5.5` is built the same way (`createChatModel(env, 'anthropic/claude-sonnet-5.5')`) and never added to `MODEL_REGISTRY` or any selectable list.

**Never:** No production behavior change beyond the one named seam. No fixture for `activate_plan`/`complete_step`/check-in tools (don't exist). No full cross-model run in this session (cost) — verify with one deterministic case on one model only. Never touch `epics.md`/`sprint-status.yaml`/`ARCHITECTURE-SPINE.md`/`ideas`/`IdeasPanel` files. Never write/read `.env`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deterministic match, correct call | fixture HumanMessage(s) + reference trajectory | `createTrajectoryMatchEvaluator` scores `true` | recorded false on mismatch, never thrown |
| Negative case (no agent tool exists) | "change my currency to USD" (chat) | actual trajectory has zero `tool_calls` | a hallucinated tool call scores `false`, recorded |
| Quality case | ambiguous intake phrasing | `createTrajectoryLLMAsJudge` returns score+comment, no reference required to pass structurally | judge call failure recorded as an error row, run continues to next case |
| Eval-only model | `anthropic/claude-sonnet-5.5` | built via `createChatModel`, bypasses `createModelSelectionMiddleware` (the `model` seam already does this) | N/A |
| Results file | after all cases/models run | JSON written to `src/evals/results/trajectory-results.json`: per-model accuracy (actual %, never suppressed), per-case rows, judge-id-per-case, LangSmith run links | partial run (interrupted) leaves no stale file — written once at the end |

</frozen-after-approval>

## Code Map

- `src/agent/index.ts:109-214` (`CreateCoachAgentDeps`, `createCoachAgent`) -- add optional `tools?: DynamicStructuredTool[]` to the deps interface, defaulting to today's hardcoded `[createSubmitIntakeTool(db), createGenerateIdeasTool(...)]` when omitted (named seam; no other line changes) — this is the only production file touched.
- `src/agent/model.ts:20` (`createChatModel`) -- reused as-is: builds a `ChatOpenAI` for ANY OpenRouter id string, including the eval-only model and both judges (no registry validation inside it) — no change needed here.
- `src/agent/registry.ts` -- read-only reference for the 3 chat ids; `anthropic/claude-sonnet-5.5` is intentionally never added here.
- `src/tools/plain/submit_intake.ts` (`createSubmitIntakeTool`) -- reused unmodified in eval cases (cheap, deterministic, no model call).
- `shared/schemas/intake.ts` (`submitIntakeToolSchema`, `failurePatternSchema`) / `shared/schemas/ideas.ts:275` (`generateIdeasToolSchema`) -- the exact arg shapes fixtures must match.
- `src/agent/index.test.ts:10-20` (`fakeDb`) -- same fake-db chain shape to reuse/extend for the eval harness's stub db.
- `src/config/env.ts` -- `OPENROUTER_API_KEY`/`LANGSMITH_*` already required; no new variables needed (eval-only model and both judges route through the existing `OPENROUTER_API_KEY`).
- `src/vitest.config.ts` -- untouched; the eval suite gets its own sibling config so it's never picked up by `npm test`.

## Tasks & Acceptance

**Execution:**
- [x] `src/agent/index.ts` -- add the `tools` override seam described above -- lets eval cases stub `generate_ideas` without duplicating `createCoachAgent`'s wiring
- [x] `src/evals/constants.ts` -- `TRAJECTORY_ACCURACY_TARGET = 0.8`, `EVAL_ONLY_MODEL_ID`, `JUDGE_MODEL_IDS`, `EVAL_MODEL_IDS` (3 registry chat ids + eval-only) -- single tunable source (AC)
- [x] `src/evals/harness.ts` -- builds a `createCoachAgent` instance per model under test: real model via `createChatModel`, pass-through `classify`, stub `db` (in-memory, captures writes), stub `webSearchTool`, and a `tools` override providing the real `submit_intake` + a schema-identical fake `generate_ideas` -- isolates tool-call accuracy from moderation/DB/websearch cost and flakiness
- [x] `src/evals/judges.ts` -- builds the two pinned judge `ChatOpenAI` instances by exact id, exported for `createTrajectoryLLMAsJudge`'s `judge` param
- [x] `src/evals/fixtures/*.json` -- 17 committed fixture cases (13 deterministic + 4 quality): 5 `submit_intake` (one per `failurePattern`, mixed EN/DE), 2 `generate_ideas` (EN/DE), 2 smalltalk no-tool-call (EN/DE), 2 currency-change negative (EN/DE), 2 ui-language-change negative (EN/DE), 4 quality cases (ambiguous intake phrasing / generate_ideas phrasing variety, EN/DE) -- within the 15-25 AC range using only tools that exist today
- [x] `src/evals/trajectory.eval.ts` -- loads fixtures, runs each against each of `EVAL_MODEL_IDS`, scores deterministic cases via `createTrajectoryMatchEvaluator({toolArgsMatchMode: 'exact'})` and quality cases via `createTrajectoryLLMAsJudge`, writes `src/evals/results/trajectory-results.json`, links each run to LangSmith (existing `LANGSMITH_*` env — no new tracing code, same as the rest of the app)
- [x] `src/evals/vitest.eval.config.ts` -- separate Vitest config, `include: ['evals/**/*.eval.ts']`, longer `testTimeout` for real model calls
- [x] `src/package.json` / root `package.json` -- add `"eval"` script (src: `vitest run --config evals/vitest.eval.config.ts`, cwd-relative — see Implementation Notes Deviation 1; root: `npm run eval --workspace=src`)
- [x] `src/package.json` devDependencies -- add `agentevals` (`^0.0.7`) -- `@langchain/core`/`@langchain/langgraph` peer ranges already satisfied by installed versions

**Acceptance Criteria:**
- Given the fixture suite, when `npm run eval` runs, then it covers 15-25 cases with both German and English represented, versioned as committed JSON files (epics.md Story 6.2, AC1)
- Given a deterministic case, when scored, then `toolArgsMatchMode` checks tool arguments, not just names, with no judge model involved (AC2)
- Given a quality case, when scored, then only `google/gemini-3.8-flash` and `deepseek/deepseek-v4.1-flash` (pinned by exact id) ever judge, and results record which judge scored which model (AC3/AC4)
- Given results, when aggregated, then 80% tool-call accuracy is a per-model (not aggregate) single tunable constant, and the actual number is always written even below target (AC5)
- Given the 4 evaluated models, when `npm run eval` runs, then each is exercised at least once; `anthropic/claude-sonnet-5.5` never appears in `MODEL_REGISTRY` or any selectable list (AC6/AC7)
- Given this build session, when verifying, then only a dry run or one case on one model is actually executed against a real API — not the full matrix (explicit user instruction)

## Implementation Notes

**Deviation 1 (script path):** `src/package.json`'s `eval` script uses `vitest run --config evals/vitest.eval.config.ts` (cwd-relative), not the Code Map's literal `src/evals/vitest.eval.config.ts` — `npm run eval --workspace=src` runs with `cwd=src/`, so the literal path double-nests to `src/src/evals/...` and fails. `vitest.eval.config.ts` pins `root` to its own directory so the path resolves the same way regardless of invocation cwd (confirmed by independent re-run from the repo root, see Verification).

**Deviation 2 (env loading):** `src/evals/env.ts`'s `loadEvalEnv()` reads `OPENROUTER_API_KEY`/`MISTRAL_API_KEY`/`LANGSMITH_PROJECT` straight off `process.env`, not `src/config/env.ts`'s `loadEnv()` — the full `Env` schema also requires `GOOGLE_CLIENT_ID`/`DATABASE_URL`/`SESSION_SECRET`/`TAVILY_API_KEY`/etc., none of which this harness touches (stub `db`, no web search, pass-through moderation), and which the spec's own verification command never sets.

**LangSmith linking (AC):** `src/evals/harness.ts`'s `captureRootRunId` records each turn's root LangSmith run id via a callback handler (same precedent as `generate_ideas.ts`'s existing timing callback — no new tracing code); `trajectory.eval.ts` writes `langsmithProject`/`langsmithRunId` onto every result row.

**Fixture coverage:** all 5 `failurePattern` enum values covered exactly once (3 EN, 2 DE); `generate_ideas` EN/DE cases match `generateIdeasToolSchema`'s `replyLanguage` exactly; `set_ui_language`/`set_currency` negative cases assert zero tool calls per the recorded Intent decision.

## Review Triage Log

Three layers reviewed the diff (verification-gap, blind-hunter N=8 floor met with 10 findings, edge-case-hunter). 13 raw findings, 2 pairs merged by shared root cause (11 entries below). No `intent_gap`/`bad_spec` entries — no loopback. All 4 `patch` entries sent back to the implementation agent and verified fixed (re-ran typecheck/lint/full `npm test` — 271 pass, up 2 from 269 — plus scoped dummy-key re-runs of the eval suite).

- **`medium` — `patch` — fixed.** The `tools` override seam (`src/agent/index.ts`) has no fast/offline unit test confirming its contract (omitted → default two-tool wiring; supplied → wholesale override). Only exercised indirectly via the on-demand `npm run eval`, which wasn't run against a real model this session — a regression here would ship silently (verification-gap + blind-hunter, same root cause). Fixed: two new `fakeModel`-based cases in `src/agent/index.test.ts` (`describe('createCoachAgent (tools override seam: Story 6.2, AD-23)')`), spying on `model.bindTools` to assert the overridden array is bound (and the default is bound when omitted).
- **`medium` — `patch` — fixed.** `runQualityCase` called `buildEvalAgent`+`runFixtureTurn` separately per judge in `JUDGE_MODEL_IDS`, so the real target model was invoked twice per quality fixture instead of once, doubling real API cost and letting the two judges score two independently-sampled trajectories instead of the same one (blind-hunter). Fixed: `getOrGenerateQualityTrajectory` memoizes the one real model call per (model, fixture) in a `Map<string, Promise<...>>`; both judges now score the same captured trajectory, each with its own try/catch.
- **`medium` — `patch` — fixed.** `loadFixtures()` (`trajectory.eval.ts`) parsed JSON with a bare `as Fixture` assertion and no runtime validation; a malformed fixture either crashed whole-file collection or silently reached `fixture.referenceTrajectory!` as `undefined` (blind-hunter + edge-case-hunter, same root cause). Real risk given the story's own "make adding a fixture file enough" forward-compat intent for Epic 3/4 tools. Fixed: `assertFixtureShape()` validates every required field per file, naming the exact file and reason on failure; `JSON.parse` errors are also re-thrown with the file name attached.
- **`low` — `patch` — fixed.** `buildEvalAgent(modelId, env)` was called outside the `try` block in both `runDeterministicCase`/`runQualityCase`; a synchronous construction failure would skip `resultRows.push`, leaving that (model, case) silently absent from the results file instead of recorded as an error row (edge-case-hunter). Unlikely in practice (`ChatOpenAI` construction doesn't validate eagerly) but the fix was a one-line move into the existing `try` (now inside `runDeterministicCase` and `getOrGenerateQualityTrajectory`), so the "reject low" carve-out didn't apply.
- **`low` — rejected.** `package-lock.json` drops `"dev": true` from 5 `@tailwindcss/oxide-wasm32-wasi` nested deps, unrelated to `agentevals` (blind-hunter + edge-case-hunter, same root cause). Real but cosmetic — standard npm resolver behavior on a new devDependency, not a functional break; rejected per "unlikely to be met in everyday use + no real fix available" (re-running install may reproduce the same diff).
- **Rejected — fix would edit the spec.** 85 generated Vitest cases vs. CLAUDE.md's 20-test stop-and-list threshold (blind-hunter). The fan-out is the AC's own explicit mandate (15-25 fixtures × 4 models), already disclosed and approved at the spec checkpoint; its only "fix" is documenting that in the spec, which is an explicitly excluded fix per triage rules.
- **Rejected — fix would edit the spec.** Verification section lacks a per-test AC/AD mapping table and eval-suite run time (blind-hunter). Same exclusion.
- **`false`.** `MISTRAL_API_KEY: 'unused-in-trajectory-eval'` placeholder risk if a future change rewires moderation into the real path (blind-hunter). Checked `moderation.ts`: `defaultClassify(env)` (the only reader of `MISTRAL_API_KEY`) is never invoked today since `classify` is always the hardcoded pass-through — the claimed outcome doesn't occur in this diff.
- **`false`.** All 17 fixtures are single-turn, "narrower than what 'trajectory' implies" (blind-hunter). Checked `evals.md`/AD-23/agentevals' own README: "trajectory" means the intra-turn tool-call message sequence (exactly what's built), not a multi-turn conversation — no AC/AD text requires multi-turn coverage.
- **`false`.** `createStubDb` accepts any args unconditionally, so schema/enum drift in `submit_intake` args would go uncaught (blind-hunter). Checked `src/tools/plain/submit_intake.ts:104`: `submitIntakeToolSchema.parse(args)` (real Zod validation) runs before `upsertIntake`/any DB call, independent of whether `db` is the stub or real Postgres — drift is already caught upstream.
- **`false`.** `EVAL_MODEL_IDS` could get a duplicate entry if `EVAL_ONLY_MODEL_ID` is ever also added to `MODEL_REGISTRY` (edge-case-hunter). That's explicitly forbidden by this story's own Boundaries/AC6-AC7 — the trigger condition requires violating an already-named invariant, not a defect in this code.
- **`false`.** Quality-case judge loop has no `judgeId === modelId` skip, so `google/gemini-3.8-flash` could judge its own trajectory (edge-case-hunter). This is exactly what AC3/AC4 explicitly require and mandate disclosing as a known limitation — the proposed "fix" would violate the AC.
- **`false`.** `captureRootRunId`'s multi-invoke reset logic is dead code since each `EvalAgent` only ever sees one invoke today, risking future cross-case "checkpoint bleed" if reused (blind-hunter). Checked: `MemorySaver` isolates by `thread_id`, not by agent instance, and every call site already passes a unique `thread_id` per case — the named harm doesn't hold.

## Design Notes

**Why stub `generate_ideas` but not `submit_intake`:** `generate_ideas`'s real factory (`createGenerateIdeasTool`) runs its own nested `createAgent` with the *same* real model under test, plus retries and web search — letting it execute for real inside a trajectory case would silently multiply the very thing being measured (model cost/behavior) by an unbounded, non-eval factor. The eval-only stand-in keeps the same `name`/`schema` (`generateIdeasToolSchema`), so the outer model under test still must produce the correct tool name and `replyLanguage` arg to pass `toolArgsMatchMode` — only the tool's *execution* is faked, not what's being measured.

**Why the `tools` seam on `createCoachAgent` instead of a parallel harness-only agent builder:** duplicating the middleware/tool wiring in `src/evals/` would silently drift from what production actually runs, defeating the point of a trajectory eval. One additive, optional, backward-compatible parameter is the smaller change.

## Verification

**Commands run (this session, no real API key available — never read from `.env`):**
- `npx tsc -p src/tsconfig.json --noEmit` -- clean, no errors (re-verified after the review patches)
- `npm run lint` (root) -- clean (re-verified after the review patches)
- `npm test` (root) -- 271 tests pass (shared 20, src 207 incl. all of `agent/index.test.ts` with its 2 new tools-seam cases, web 44); the eval suite correctly excluded from this run
- `OPENROUTER_API_KEY=dummy-key LANGSMITH_TRACING=false npx vitest run --config src/evals/vitest.eval.config.ts -t "openai/gpt-6-luna :: (submit-intake-overwhelm-en|quality-ambiguous-intake-en)"` (from repo root) -- 1 deterministic case failed its assertion on a clean 401 (expected — no real key), both quality-case judge rows passed (memoized single generation handled the dummy-key failure without throwing); confirms the harness, fixture validation, memoization, and tool-call wiring all the way up to authentication
- Same command plus `-t "writes the aggregated"` -- confirmed `src/evals/results/trajectory-results.json` is written with the correct shape (`perModelAccuracy` listing all 4 `EVAL_MODEL_IDS` including `anthropic/claude-sonnet-5.5`, per-row `langsmithProject`); file deleted afterward (gitignored, not a meaningful result)

**Still needed (the user's own real key — never available in this sandboxed session):**
- `OPENROUTER_API_KEY=<real key> LANGSMITH_TRACING=false npx vitest run --config src/evals/vitest.eval.config.ts -t "openai/gpt-6-luna :: submit-intake-overwhelm-en"` (from repo root) -- expected: passes against the default model only; this is the one real-API-call pass/fail confirmation, explicitly deferred per the build instruction to avoid cost in this session
- `npm run eval` -- the full cross-model/cross-judge matrix; explicitly NOT run per the build instruction (cost)
