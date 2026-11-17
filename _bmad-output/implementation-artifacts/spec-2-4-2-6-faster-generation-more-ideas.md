---
title: 'Story 2.6 Faster Idea Generation + Story 2.4 Generate More Ideas'
type: 'feature'
created: '2026-11-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '6412b5d50513740565322564e1fd279ed23ab234'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Idea generation (35-60s/2 ideas), card translation (~6-7s, runs twice per generation), and plan creation (10-11s) are all too slow, and "Generate new ideas" currently *replaces* the suggested batch instead of adding to it, risking repeats.

**Approach:** Cut output length on the three dominant free-text fields and the plan's step/bullet counts, drop the proactive other-language translation prefetch, dedupe the per-card `/api/intake` fetch, and switch `generate_ideas`' persistence from delete+insert to append-with-exclusion. No hard validation rule (quote verification, moderation, vendor/login-wall rejection, citation/occupation checks) changes.

## Boundaries & Constraints

**Always:** every hard check in `evaluateDraft`/`evaluateBatch` stays exactly as strict; `web_search` call count and moderation coverage stay unchanged (2.11's cache/budget guard already covers the "reuse cached search results" speed lever — not re-implemented here); `DRAFT_ATTEMPT_TIMEOUT_MS` is not raised; a batch that passes all hard rules is still accepted on attempt 1; "Generate new ideas" never deletes/repeats a `suggested`/`bookmarked`/`rejected`/`selected` idea.

**Never:** touch `create_plan`'s step-writing call's reasoning quality, only its requested breadth (step/bullet counts); add `excludeTitles`/exclusion to the model-facing tool schema (stays a server-side DB read, per `shared/schemas/ideas.ts`'s own "Story 2.4's addition" note — Boundary precedent); spend the one live web-search run anywhere but the final confirmation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Generate more ideas | N existing ideas (mixed status) | `IDEAS_PER_BATCH` new ideas appended; none repeat any existing title; old ideas untouched | N/A |
| Generate fails fast | Every `web_search` call fails this round | `SearchServiceUnavailableError` → 503; existing ideas untouched; `refundUserGeneration` gives back the counted attempt | Test asserts count returns to pre-call value |
| Card translation after generate | UI language matches stored language | No translate call at all (removed prefetch no longer fires for the untouched language either) | N/A |

</frozen-after-approval>

## Code Map

- `src/tools/llm/generate_ideas.ts:1528-1543` — `tx.delete(...status='suggested')` + insert → insert-only.
- `src/tools/llm/generate_ideas.ts:1359-1376` — fetch all existing idea titles for `userId` (new small query, reuse `ideas` import) once before the attempt loop; pass as `excludeTitles` into both the normal `generateDrafts` call (1421-1425, currently no options arg) and the repair-pass call (1486, merge with its own same-batch `excludeTitles`).
- `shared/schemas/ideas.ts:85,212,216` — `RATIONALE_LINE_MAX_LENGTH` 140→100, `DEMAND_EVIDENCE_NOTE_MAX_LENGTH` 200→140, `GROWTH_PATH_MAX_LENGTH` 220→150 (single source of truth already; `generate_ideas.ts`'s `truncateAtWordBoundary` and prompt wording follow these constants).
- `src/tools/llm/generate_ideas.ts:956-1057` (`buildNestedAgentPrompt`) — update wording to match the shortened field lengths above.
- `src/api/routes/ideas.ts:359,378-380` — `beforeSuggestedIds`→`beforeIds` (all statuses, not just `suggested`); `regenerated` = count of returned ideas whose id wasn't in `beforeIds` equals `env.IDEAS_PER_BATCH`.
- `src/api/routes/ideas.ts:406-411` — refund already wired; only a test is needed here.
- `src/agent/registry.ts:79` (`TRANSLATION_MODEL_ID`) — swap candidate; keep `'openai/gpt-6-luna'` unless one measured live translate call with an alternate (`anthropic/claude-haiku-4.5`) shows a real latency win.
- `web/src/features/ideas/IdeasPanel.tsx:959-973` — delete the background other-language prefetch effect entirely (keep the foreground effect at 937-944).
- `web/src/features/ideas/IdeasPanel.tsx:414-445` (`IdeaCard` props), `499` (`useViewerCountry()` call), `1272-1286` (render loop) — lift `useViewerCountry()` into the parent component body; pass `viewerCountry` down as a new `IdeaCard` prop instead of calling the hook per card.
- `src/tools/llm/create_plan.ts:81-84` + `shared/schemas/plans.ts:35-38` — `MAX_PLAN_STEPS` 12→8, `MAX_STEP_ACTIONS` 5→3; prompt wording updated to match.
- `src/api/routes/ideas.test.ts` (near line 332's existing 503 test) — new test: generation count before the 503 call equals the count after (import `getUserGenerationCount`).
- `src/tools/llm/generate_ideas.test.ts`, `src/api/routes/ideas.test.ts` — existing "regenerate replaces batch" tests updated to assert append (old ids survive, new ids added, no title repeats).

## Tasks & Acceptance

**Execution:**
- [x] `src/tools/llm/generate_ideas.ts` -- insert-only persistence + excludeTitles fetched from DB and threaded into both the normal and repair draft calls -- Story 2.4 AC1/AC2
- [x] `shared/schemas/ideas.ts` + prompt wording in `generate_ideas.ts` -- shorten rationale/demandEvidenceNote/growthPath caps -- Story 2.6 AC3/AC5 (shorter output, no weaker hard rule)
- [x] `src/api/routes/ideas.ts` -- `regenerated`/`beforeIds` logic updated for append semantics -- Story 2.4 AC1
- [x] `src/agent/registry.ts` / `translate-idea-cards.ts` -- measure one live translate call with an alternate model id; document the before/after and the decision -- Story 2.6 AC3
- [x] `web/src/features/ideas/IdeasPanel.tsx` -- remove background prefetch effect; lift `useViewerCountry()` to the panel, pass as prop -- Story 2.6 AC5
- [x] `src/tools/llm/create_plan.ts` + `shared/schemas/plans.ts` -- shorten step/bullet counts -- Story 2.6 AC4
- [x] One real instrumented run (before any change) -- report per-step timing -- Story 2.6 AC1 (pre-existing baseline already measured/documented in `generate_ideas.ts`'s own history comments; reused per the user's explicit "do not re-measure" instruction)
- [x] Tests listed in Code Map -- updated/added -- Story 2.4 AC1/AC2, Story 2.11 refund AC

**Acceptance Criteria:**
- Given existing ideas of every status, when "Generate new ideas" runs, then exactly `IDEAS_PER_BATCH` new ideas are appended and no existing or repeated title is removed/duplicated.
- Given a typical successful generation run measured after these changes, then the report states both the before and after timing honestly, including if the ~30s target is missed.
- Given every `web_search` call fails, when the route returns 503, then the user's counted generation for that day is refunded (test-verified).

## Implementation Notes

- Translation model: measured `anthropic/claude-haiku-4.5` against current `openai/gpt-6-luna` with one real `translateIdeaCards` call each (real OpenRouter creds) — 5107ms vs 2436ms, 2.1x *slower*, not faster. Kept `openai/gpt-6-luna` unchanged; decision documented in `registry.ts`'s own doc comment.
- Live confirmation run (`WEB_SEARCH_MODE=live`, this session's only live run): 153.2s total for a 2-idea batch (two attempts rejected on a pre-existing, unrelated hard check — a login-walled source — then an accepted repair pass). The ~30s/batch target was not met; this story's levers (shorter free-text fields, dropped prefetch, deduped intake fetch, append-only write) don't touch the dominant cost (per-attempt model+search round trip), which stays out of scope per Boundaries (search parallelism/caching already landed in 2.5/2.10/2.11; `DRAFT_ATTEMPT_TIMEOUT_MS` not raised). Reported honestly per the AC rather than tuned to look better.
- Full suite verified independently after implementation: shared 37/37, src 350/350, web 79/79 passed; `npm run typecheck` clean across all three workspaces.
- Review patch fixes applied (see Review Triage Log): `getIdeasByUserId` now skips (logs, doesn't throw on) a legacy row that fails the shrunk-cap schema; `existingTitles` capped to the 50 most recent titles via `EXCLUDE_TITLES_LIMIT`. Re-verified independently: shared 37/37, src 352/352 (2 new patch tests), web 79/79 passed; `npm run typecheck` clean.

## Review Triage Log

Reviewer: edge-case-hunter (sole layer, per "one pass, at most 1 reviewer").

1. **`high` — legacy idea rows written under the old, larger length caps now fail strict `.parse()` on every future read, and can never self-heal.** Verified: `ideaResponseSchema`'s `rationale`/`demandEvidenceNote`/`growthPath` checks now use the lowered `RATIONALE_LINE_MAX_LENGTH`/`DEMAND_EVIDENCE_NOTE_MAX_LENGTH`/`GROWTH_PATH_MAX_LENGTH` (`shared/schemas/ideas.ts`); `toIdeaResponse` (`generate_ideas.ts`) calls `.parse()`, not `.safeParse()`, and `getIdeasByUserId` has no try/catch per row; `GET /api/ideas` wraps the whole call in one try/catch, so one offending row 502s the user's entire ideas list. Before this diff, any `suggested` row was purged on the next regenerate (self-healing); the diff's own insert-only switch removes that, so a row written under the old 140/200/220 caps is now permanent. Caused by this diff (the cap shrink and the permanent-retention switch land together) — **route: patch**.
2. **`medium` — `existingTitles` (new in this diff) is every title ever generated for the user, unbounded, re-fetched and re-embedded into the prompt on every regenerate now that rows are never deleted.** Verified at `generate_ideas.ts`'s new fetch (before the attempt loop) and its two use sites. Prompt size/token cost/latency grow without bound across repeated regenerates — works against this same story's own speed goal. Caused by this diff (old delete-then-insert kept the population small; insert-only removes that natural cap) — **route: patch**.
3. **`maybe-false` (pre-existing shape) — a race between the `beforeIds` snapshot and the `after` snapshot in `POST /generate` under two concurrent requests for the same user.** Verified the same two-snapshot structure existed before this diff (`beforeSuggestedIds`/`afterSuggested`); this diff changes what's compared, not the snapshot-then-read-again shape itself, and actually lowers the race's worst case (no more concurrent deletes racing each other). Not caused by this story — **route: defer**.
4. **`low` — no DB-level uniqueness or write-time dedup backs the "never repeats a title" AC; enforcement is the prompt's own exclusion instruction only.** Verified: no unique constraint on `(userId, title)`, no post-generation dedup check. Same enforcement style as the pre-existing repair-pass `excludeTitles` (prompt-only, never hard-enforced) and consistent with this codebase's existing precedent of reserving hard DB/code-level checks for correctness-critical fields (money, quotes, limits), never title uniqueness. Fix would add a new guard/branch for a cosmetic-only failure mode a cooperative model essentially never hits — **rejected** (low, fix exceeds direct-correction threshold, unlikely in everyday use).

## Design Notes

The three shortened free-text caps (rationale bullet length, demand-evidence note, growth path) are the one AC-sanctioned "tighter fields" lever available without touching `citedIntakeFields` (the structured, actually-AC-checked 3-field citation requirement) or any quote/citation field (must stay verbatim, per hard rule). Search parallelism and per-user search caching are already in place from Stories 2.5/2.10/2.11 — this story's own timing report should say so rather than re-implementing either.

## Verification

**Commands:**
- `npm test -- generate_ideas` -- expected: all pass, including updated append-semantics assertions
- `npm test -- ideas.test` -- expected: all pass, including the new refund test
- `npm test -- plans` / `create_plan` -- expected: pass with new step/bullet bounds
- `npm test -- IdeasPanel` -- expected: pass with lifted `viewerCountry` prop
- One live `POST /api/ideas/generate` run (`WEB_SEARCH_MODE=live`, the session's only live run) -- expected: succeeds, ideas still pass every hard check

**Manual checks (if no CLI):**
- Confirm `.env.example`/`src/config/env.ts` need no new variable (no new external service introduced).
