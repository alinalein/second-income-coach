---
title: 'Story 6.1: Deterministic Tool & Guardrail Tests'
type: 'chore'
created: '2026-11-16'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.1 asks for deterministic Vitest proof that critical tools and guardrails behave correctly. Several named ACs (`activate_plan`, `complete_step`, exactly-one-active-plan, timeline recalculation, guilt/streak-language AD-12, HITL-bypass negative test) reference tools/guardrails from Epic 3/4 that don't exist in this codebase yet. The buildable remainder splits into: coverage that already exists from prior stories (submit_intake, set_ui_language, set_currency, generate_ideas hard rules, moderation AD-11, model registry), and genuine gaps this story's distinct guardrail framing calls for (direct prompt-injection as its own case, a web_search-result prompt-injection case, and the full EUR/USD x de-DE/en-US currency-formatting matrix).

**Approach:** Add only the tests covering the genuine gaps, as new/extended Vitest test files (no production code changes). Everything already covered by an existing test from a prior story is left as-is and cited, not duplicated. Everything that needs an unbuilt tool/table is deferred and named as pending in the report, with the blocking story.

</frozen-after-approval>

## Implementation Notes

- `src/agent/direct-prompt-injection.test.ts` (new): Story 6.1's "direct prompt injection" AC, kept distinct from the generic jailbreak test in `index.test.ts`/`moderation.test.ts` per the AC's own instruction. 3 phrase-categories ("ignore/disregard instructions", "output system prompt", "list your tools") x EN/DE = 6 `it.each` rows against `createCoachAgent`, asserting the realistic branch the architecture relies on: Mistral flags `jailbreaking` -> turn rejected before the model is ever called -> fixed EN/DE message, zero model calls, no disclosure possible (hardcoded string). DE phrasing was hand-checked against `detectReplyLanguage`'s stopword heuristic (needs >=2 distinct German stopword hits or an umlaut/ß) so each DE case actually resolves to `'de'`.
  - Deliberately did not add a branch simulating "moderation fails to flag it, does a fake model's canned reply still get caught" — that would test the test's own fixture, not real behavior. Whether a real model complies with injected instructions when moderation doesn't flag them is exactly what Story 6.2's trajectory evals (real models, LLM-judge) measure; out of scope for a deterministic unit test.
- `src/agent/moderation-web-search.test.ts` (extended): added one new `describe` block simulating a prompt-injection payload inside a `web_search` tool result block, classified under Mistral's `jailbreaking` category (not the generic `dangerous` category the existing tests use), asserting the block is stripped via the same `isFlagged` mechanism. This is the AC's named "simulated prompt-injection via a web_search result" case, kept distinct from the pre-existing generic-unsafe-content test.
- `shared/money.test.ts` (extended): replaced the single EUR/en-US `formatMoney` assertion with a 4-row `it.each` covering EUR and USD under both `de-DE` and `en-US` (AD-27's named matrix). de-DE expected strings use ` ` (non-breaking space before the currency symbol) — verified against actual `Intl.NumberFormat` output, not guessed.
  - `convertMoney`'s estimate-labeling and "changing currency never alters a stored baseline rate/citation" clause: left untested here. `convertMoney` already has same-currency/cross-currency coverage from Story 2.2. The baseline-rate-immutability claim is already structurally proven by the existing `set_currency.test.ts` (`toHaveBeenCalledWith(db, userId, currency)` — only 3 args, no idea/baseline-rate data in `setCurrency`'s signature at all) plus `updateCurrency` in `settings-repository.ts` only ever touching `userSettings`. A new test re-asserting that an unrelated table is untouched would be testing structure that's already provable by inspection, not a meaningful new deterministic check.
- No production code changed. Files touched: the 2 test files above plus the new file — nothing else.

**Pending (blocked on unbuilt stories, no test written, none skipped/weakened):**
- `activate_plan`, `complete_step`, exactly-one-active-plan rule, timeline recalculation — Epic 3 (Plan Creation & Activation) not built yet.
- Real-Postgres integration test for the exactly-one-active-plan partial unique constraint — same blocker (no `plans` table yet).
- `activate_plan` HITL-bypass negative test — same blocker (tool doesn't exist).
- Guilt/streak-language guardrail (AD-12), once per personality — scoped to CAP-4 (missed check-ins), not built yet. `index.test.ts` already documents this gap inline.
- 4th direct-injection case ("injected instruction embedded inside an otherwise normal check-in message") — needs the check-in feature (FR6), not built yet.
- Non-gating visibility metric ("how often Mistral's own jailbreak category flagged each of the four direct-injection cases on its own") — this is a report-generation concern per the AC's own wording ("When the report is generated"); belongs to Story 6.3, not this story's Vitest suite.
- "No Python eval package is used" (AD-23) — verified by inspection (TS/Vitest only, no Python deps in `package.json`); not a runtime behavior to unit-test.

## Review Triage Log

Blind-hunter review found 5 issues (floor N=3 for ~8.26 kB of changed content). All patched (simple fixes, caused/exposed by this change):

- `moderation-web-search.test.ts`: a pre-existing doc comment got orphaned above the new describe block instead of the fallback block it actually documents — moved it back into place.
- new web_search-injection test was missing `toBeInstanceOf(ToolMessage)` and `handler` call-count assertions the sibling AD-11 test makes — added both.
- new web_search-injection test placed its flagged block last, same position as the sibling test, so neither could catch a "strips whichever block is last" bug — moved the injected block to first position in this test.
- `direct-prompt-injection.test.ts`: `classify` fake ignored its `text` argument for all 6 cases, so a wiring bug (wrong/stale text reaching the classifier) would go undetected — changed to a `vi.fn` spy asserting `classify` was called with each row's own text.
- `money.test.ts`: AD-27's "integer-minor-units storage (never floats)" sub-clause had no test anywhere and wasn't noted as deferred — added `moneySchema` integer-rejection/acceptance tests.

## Verification

**Commands:**
- `npx vitest run src/agent/direct-prompt-injection.test.ts src/agent/moderation-web-search.test.ts --config src/vitest.config.ts` -- expected: all pass
- `npx vitest run money.test.ts` (from `shared/`) -- expected: all pass
