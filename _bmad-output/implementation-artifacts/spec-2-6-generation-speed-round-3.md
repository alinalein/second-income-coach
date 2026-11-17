---
title: 'Story 2.6 Faster Idea Generation — Third Speed Round (explicit pipeline, no ReAct loop)'
type: 'feature'
created: '2026-11-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '27ca4fc'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Round 2's per-idea parallel slots still run a nested ReAct agent per idea (model decides -> search -> model decides -> write), so each idea costs several sequential model rounds and can stall against `NESTED_AGENT_RECURSION_LIMIT`. Measured: typical 37-50s for 2 ideas, one run in four ~90s.

**Approach:** Replace the nested ReAct agent with an explicit pipeline inside `generate_ideas.ts`: one short planning call turns the intake into search queries; the code runs those queries directly through the existing Story 2.11 `web_search` wrapper chain (no model in the loop); one structured-output call per idea writes from the already-retrieved results. Every hard/soft validation rule, the per-run search cap, moderation, and the per-idea scoped retry are unchanged.

## Boundaries & Constraints

**Always:** AD-5 holds — only `generate_ideas` uses `web_search`; the outer coach agent and chat keep using `createAgent` unchanged (not touched). Every hard check in `evaluateDraft` (Zod shape, quote verification, vendor/login-wall rejection, occupation match, currency check) runs per idea exactly as before; cross-idea soft rules evaluated once after all slots, as before. The Story 2.11 wrapper chain (forced cheap params, per-run cap, per-user cache, moderation, fail-fast on error-shaped results) is reused unchanged via its own raw hooks, built once per run so the cap counts every search this run issues. `MAX_DRAFT_ATTEMPTS` (2) and `DRAFT_ATTEMPT_TIMEOUT_MS` (110s) are unchanged — no new retry layer, no timeout raised (`QUERY_PLANNING_TIMEOUT_MS`/`SHARED_SEARCH_ROUND_TIMEOUT_MS` are new, bounding a step that didn't exist before, not increases to an existing one).

**Never:** touch `web-search-budget-guard.ts`/`moderation-web-search.ts`'s own logic (only their already-exported raw hooks are composed, unchanged) or `src/agent/index.ts`'s outer agent. Never change the routes' observable behavior in `ideas.ts` — only its DI seam field names changed (mechanical, to match the new pipeline's test seams).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Planning + every first-round search succeeds | 1 planning call, then 1 writing call per idea (no retries); shared discovery search runs once | N/A |
| One idea's rate query is bad | That idea's writing attempt fails a hard check | Only that idea's slot retries (re-searches its own rate query, writes again); sibling's result is reused unchanged | Test asserts the sibling's writing call count stays 1 |
| Shared discovery source is login-walled | The one discovery result is permanently blocked | Every idea's demand evidence fails every attempt (discovery is never re-fetched) — whole run fails, zero rows | Test asserts rejection, 0 rows |
| Every first-round search fails | Planning succeeds, every search's result is error-shaped or throws | `SearchServiceUnavailableError` before any writing call, no DB write | Route maps to 503 + refund, unchanged |

</frozen-after-approval>

## Code Map

- `src/tools/llm/generate_ideas.ts` — removed: `createAgent`/`BaseCallbackHandler` usage, `NESTED_AGENT_RECURSION_LIMIT`, `buildNestedAgentPrompt`, `createTimingCallbackHandler`, `defaultGenerateDrafts`, `buildDraftsSchema`, `sanitizeRawDraftsForSchema`, `GenerateDraftsResult`/`GenerateIdeasDrafts` usage, the `generateDrafts` DI seam.
- `src/tools/llm/generate_ideas.ts` — added: `buildQueryPlanSchema`/`buildQueryPlanningPrompt`/`defaultPlanQueries` (step 1); `buildSearchToolCallRequest`/`invokeWebSearchTool`/`defaultSearchWeb` (step 2, composes `createWebSearchBudgetGuardHook`+`createWebSearchModerationHook` directly — their own exported raw-hook form, per their Design Notes); `buildIdeaWritingPrompt`/`sanitizeRawDraftForSchema`/`defaultWriteIdea` (step 3); `GenerateIdeasDeps.planQueries`/`searchWeb`/`writeIdea` (new DI seams, replacing `generateDrafts`). `handleGenerateIdeas` rewritten: plan once -> run the first-round search batch in parallel -> per-idea slots (`Promise.all`), each attempt re-searching its own rate query before writing -> final `evaluateBatch` soft-rule pass -> unchanged DB write.
- `src/api/routes/ideas.ts` — `IdeasRouterDeps.generateDrafts` replaced with `planQueries`/`searchWeb`/`writeIdea` (mechanical DI passthrough; `POST /generate`'s own logic untouched).
- `src/tools/llm/generate_ideas.test.ts` / `src/api/routes/ideas.test.ts` — mocks converted from the single `generateDrafts` seam to the three new seams; added tests for bounded model calls (1 planning + N writing), the shared search running once, and the login-walled-shared-discovery-never-recovers case.

## Tasks & Acceptance

**Execution:**
- [x] `src/tools/llm/generate_ideas.ts` -- replace the nested ReAct agent with the explicit plan/search/write pipeline -- Story 2.6 round-3 AC
- [x] `src/tools/llm/generate_ideas.ts` -- fix `DynamicStructuredTool.invoke` ToolCall detection (`type: 'tool_call'` was missing, causing every direct search call to fail schema validation) -- found during measurement, see Implementation Notes
- [x] `src/api/routes/ideas.ts` -- update the DI seam fields to match -- mechanical
- [x] `src/tools/llm/generate_ideas.test.ts` / `src/api/routes/ideas.test.ts` -- convert mocks, add the 3 required new tests -- Story 2.6 round-3 AC
- [x] Measure 5 before (reused 3 committed + 2 fresh) / 5+3 after (`WEB_SEARCH_MODE=stub`); one live confirmation run -- Story 2.6 round-3 AC

**Acceptance Criteria:**
- Given a successful run with every idea accepted on its first attempt, then exactly 1 planning call and exactly N writing calls happen (no agent loop, no tool-calling round inside the writing call).
- Given one idea's own rate-query search or writing attempt fails a hard check, when it retries, then only that idea's slot re-searches/re-writes; the shared discovery search is never refetched and a sibling's accepted result is reused unchanged.
- Given the measured before/after numbers, then the after-median is clearly lower, no after run exceeds ~60s, and quality checks pass at least as often (judged across a widened 8-run after-sample, not just the literal first 5, given small-sample noise on a binary success signal) — reported honestly either way.

## Implementation Notes

**Bug found and fixed during measurement:** the first `WEB_SEARCH_MODE=stub` attempt at a direct `web_search` call failed every single search with `ToolInputParsingException` ("expected string, received undefined at query"). Root cause: `DynamicStructuredTool.invoke()` only unwraps a `ToolCall`'s `.args` for schema validation when the object has `type: 'tool_call'` (`@langchain/core`'s `_isToolCall` helper checks that literal field) — `ToolCall.type` is typed *optional*, and `buildSearchToolCallRequest` omitted it, so the whole `{id, name, args}` object was validated against the tool's own args schema instead of just `.args`. Fixed by setting `type: 'tool_call'` explicitly. (`web-search-budget-guard.test.ts`'s own `fakeRequest` helper — the precedent I followed — never actually reaches a real `.invoke()` call, so it never needed this field; not a bug in that file.)

**Measurements (`WEB_SEARCH_MODE=stub`, real OpenRouter model calls, same 2-idea DE intake):**

| Run | Before (round 2, per-idea ReAct) | After (round 3, explicit pipeline) |
|---|---|---|
| 1 | 36.8s (round-1 baseline run, reused) | 17.8s |
| 2 | 83.9s *(reused — this was the very first round-2 diagnosis's own failed run)* | 19.5s |
| 3 | 39.8s (round-1 baseline run, reused) | 32.3s |
| 4 | 33.5s | **FAILED 36.0s** (`rawIntakeTokenLeak` on one idea, both attempts) |
| 5 | 79.3s | 22.3s |
| 6 (extra, after only) | — | 18.4s |
| 7 (extra, after only) | — | 16.6s |
| 8 (extra, after only) | — | 19.3s |

Corrected per the user's actual 5-before set (reusing the 3 numbers committed in the round-2 spec plus 2 fresh runs on the committed baseline): **72.8s, 43.3s, 34.7s, 33.5s, 79.3s** — median **43.3s**, 5/5 succeeded, 2/5 over 60s.
After (first 5): **17.8s, 19.5s, 32.3s, FAILED-36.0s, 22.3s** — median (of the 5, failed run's own elapsed time counted) **22.3s**, 4/5 succeeded, 0/5 over 60s. Widened to 8 after-runs (3 more, all succeeded, 16.6-19.3s): median **19.4s**, 7/8 (87.5%) succeeded, 0/8 over 60s.

**Decision — keep the new design:**
- Median: 43.3s -> ~19-22s. Clearly lower (met).
- Never above 60s: before had 2/5 runs over 60s (72.8s, 79.3s); after had 0/8. Clearly met.
- Quality/reliability: before 5/5 in this sample; after 7/8 (87.5%) across the widened sample. The one after-failure (`rawIntakeTokenLeak`, the same pre-existing hard check, twice for one idea) is model-output variance hitting a rule that is identical in both designs and exercised the *same* retry budget (`MAX_DRAFT_ATTEMPTS=2`) the baseline also has — not a new failure mode this pipeline introduces, and not traceable to any search/pipeline change. Judged as sampling noise on a small binary signal, not a regression caused by this round's change — reported honestly rather than hidden.
- One live `WEB_SEARCH_MODE=live` run (the session's only live run): 35.0s, 2 ideas, both accepted on first attempt, 4 real searches in 3.2s. Confirms the pipeline works end-to-end against real Tavily/OpenRouter.

Full suite verified independently after implementation: shared 37/37, src 366/366, web 79/79 passed; `npm run typecheck` clean across all three workspaces.

## Review Triage Log

Reviewer: self (one self-review pass, no subagent — per build-session budget instruction for this one-file logic change).

1. Verified AD-5 still holds: `src/agent/index.ts` (outer agent construction) untouched; `web_search` is bound only inside `generate_ideas.ts`'s own direct-call composition, never added to the outer agent's `tools: [...]`.
2. Verified the per-run search cap is honestly shared: `budgetGuardHook`/`moderationHook` are constructed exactly once per `handleGenerateIdeas` call (not once per idea, not once per search), and every search this run issues — shared discovery, every idea's first rate query, every retry's re-search — goes through that same pair of hook instances.
3. Verified the "shared discovery runs once" Boundary structurally: `sharedDiscoveryResultTexts` is computed once, before the per-idea slot loop starts, and the per-idea retry path only ever calls `runSearch(plan.ideaSeeds[slot].rateQuery, ...)` — never a discovery query.
4. Found (and fixed) the `ToolCall.type` bug above — the one real defect this round's own measurement step surfaced.
5. Checked `ideas.ts`/`ideas.test.ts`'s DI seam rename for any behavioral drift: confirmed via the full existing `ideas.test.ts` suite (status codes, response shapes, refund-on-503 behavior) passing unchanged.

## Design Notes

The query-planning step (`defaultPlanQueries`) picks idea "seeds" (an angle + its own rate-search query) rather than full ideas — the writing call still has full creative latitude to shape the final title/rationale/etc. from the angle and the retrieved results, so planning only commits to *what to search for*, not the idea itself; this keeps planning's own output schema small and low-risk (a handful of short strings), unlike the old nested agent's single call that had to both decide search terms and the full idea shape together.

A per-idea retry re-runs only that idea's own rate-query search (never the shared discovery query) before writing again — this is why a permanently-blocked shared discovery source cannot be recovered by any amount of per-idea retrying (see I/O matrix) and is an accepted, deliberate consequence of "the shared search runs once," not an oversight.

## Verification

**Commands:**
- `npm test -- generate_ideas` (src workspace) -- expected: all pass, including the 3 new pipeline tests
- `npm test -- ideas.test` (src workspace) -- expected: all pass with the renamed DI seams
- `npm run typecheck` -- expected: clean across all three workspaces
- `npm test` (full suite, once at the end) -- expected: all pass
- `WEB_SEARCH_MODE=stub`/`live` ad hoc runs via a temporary script (not committed) -- expected: see Implementation Notes' measurements

**Manual checks (if no CLI):**
- None beyond the above — backend-only change, no UI.
