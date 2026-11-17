---
title: 'Story 2.7: Translate Idea Cards on Language Change'
type: 'feature'
created: '2026-11-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/implementation-artifacts/spec-2-5-opportunity-discovery-growth-path.md']
baseline_commit: 'c3259f1401061f0e4e081eb799a0aedf31c50a5c'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Ideas have no stored language and no translation path. A card generated in German stays German forever even after the user switches the UI to English (and vice versa); "Generate new ideas" currently picks its write language from the discovery thread's last chat message, not from the UI toggle.

**Approach:** Persist the language each idea was generated in; when a visible card's language differs from the UI language, batch-translate title/rationale/demand-note/growth-path for all visible cards in one internal-model call, moderate (AD-11) and cache the result per idea+language so repeat switches never re-call the model. Numbers, currency, citations, URLs, quotes and trust labels are never sent to or touched by the translation call. Button-triggered generation now writes in the current UI language; chat-triggered generation is unchanged (AD-25).

## Boundaries & Constraints

**Always:**
- Translation model: new registry entry, `category: 'translation'` — excluded from `listSelectableModels`'s existing `chat`-only filter; reuses `OPENROUTER_API_KEY`, no new env var.
- One attempt, no retry: fixed timeout (`setTimeout`→`controller.abort()`) + `req.on('close')` abort, mirroring `ideas.ts:161-163`. Failure/abort/moderation-reject persists nothing; cards keep their stored language.
- Translated text re-validated against the existing `title`/`rationale`/`demandEvidenceNote`/`growthPath` length/shape constants before persisting.
- AD-11 output moderation (`defaultClassify`/`evaluateAssistantMessage`, `src/agent/moderation.ts`) runs on the batch before persist/return.
- `idea_translations` rows are an immutable cache keyed `(idea_id, language)`, written with `onConflictDoNothing`; ideas never change post-generation, so a cached translation never needs invalidation.
- `baselineRateQuote`/`demandEvidenceQuote`, citations, URLs, numbers, currency, `sourceTrustTier` are never sent to or returned by the translation call.
- "Generate new ideas" (button) sends `i18n.language` explicitly; server uses it as `replyLanguage` directly, skipping `detectUserReplyLanguage`.

**Never:**
- Don't touch `plan-chat.ts`, plan/check-in/settings files, the chat-triggered tool-calling path, or epics.md/sprint-status.yaml/the spine.
- No server-side retry loop — the UI "retry" is a fresh user-initiated request.
- No new `caveat` field — it's the existing optional 3rd `rationale` bullet (`generate_ideas.ts:953`), already covered by translating `rationale`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Language match | `idea.language === i18n.language` | Rendered as-is, no call | N/A |
| Mismatch, no cache | No `idea_translations` row | Loading state, one batched call, atomic swap | Timeout/abort/moderation-reject → stays stored-language, notice + retry |
| Mismatch, cache hit | Row exists for `(ideaId, language)` | Instant DB read, no model call | N/A |
| Toggle back and forth | Same ideas, two languages | 2nd+ switch instant (cache) | N/A |
| "Generate new ideas" click | Button POST | New batch persisted with `language = i18n.language` | N/A |
| Chat-triggered generation | Model calls `generate_ideas` mid-chat | `language` = model's own `replyLanguage` (AD-25, unchanged) | N/A |

</frozen-after-approval>

## Code Map

- `shared/schemas/ideas.ts` — extract `replyLanguageSchema = z.enum(['en','de'])` (currently inline on `generateIdeasToolSchema:307`); add `language: replyLanguageSchema` to `ideaResponseSchema:253-297`.
- `shared/schemas/idea-translations.ts` (new) — `ideaTranslationSchema`, `translateIdeasRequestSchema` (`{ideaIds: uuid[], language}`), `translateIdeasResponseSchema` (`{translations: ideaTranslationSchema[]}`); reuses `rationaleSchema`/`GROWTH_PATH_MAX_LENGTH`/`DEMAND_EVIDENCE_NOTE_MAX_LENGTH` for the translated fields.
- `src/db/schema/ideas.ts:49-88` — add `language text not null default 'en'`; new `ideaTranslations` table (`id`, `ideaId` FK cascade, `language`, `title`, `rationale`, `demandEvidenceNote`/`growthPath` nullable, `createdAt`; unique on `(ideaId, language)`). `src/db/schema/index.ts` re-exports it.
- `src/agent/registry.ts:24,58-114` — widen `ModelCategory` with `'translation'`; one new entry (`openai/gpt-6-mini`, `openrouter`, `translation`, price 0/0 — same never-displayed precedent as the moderation entry).
- `src/agent/translate-idea-cards.ts` (new) — `translateIdeaCards(db, model, env, ideaIds, targetLanguage, signal)`: cache read first; for misses, one `createChatModel(env, TRANSLATION_MODEL_ID).withStructuredOutput(...)` call (no agent, no tools — mirrors `model.ts:20-26`'s factory); validate, moderate, insert `onConflictDoNothing`, return merged.
- `src/api/routes/ideas.ts` — new `POST /translate` (ownership-check vs `getIdeasByUserId`, abort-wired per `:161-163`, 502 on failure, Zod-parsed response). `POST /generate:143-210` — accept `language` in body, use directly as `replyLanguage`, skip `detectUserReplyLanguage:52-61`. `generate_ideas.ts` persistence — write `language: replyLanguage` per row.
- `web/src/features/ideas/IdeasPanel.tsx` — `handleGenerate:811-854` sends `{language: i18n.language}` JSON body. New effect: visible ideas with `language !== i18n.language` and no cached translation → one batched `POST /api/ideas/translate`; `'idle'|'translating'|'error'` state. `IdeaCard` builds `displayIdea` (translation merged over `idea`) passed to rendering + `IdeaEvidence` unchanged. Loading banner mirrors `IdeasSkeleton`; error banner mirrors `error.loadFailed` + new retry button; swap is atomic per batch, never per-card (no mixed-language flash).
- `web/src/locales/{en,de}/ideas.json` — add `translating`, `error.translateFailed`, `actions.retryTranslation`.
- Fixture ripple only: `generate_ideas.test.ts`, `IdeasPanel.test.tsx`'s `fakeIdea()` gain `language`.

## Tasks & Acceptance

**Execution:**
- [x] `shared/schemas/ideas.ts`, `shared/schemas/idea-translations.ts` -- schemas + `replyLanguageSchema` extraction -- AC1/AC2
- [x] `src/db/schema/ideas.ts`, `src/db/schema/index.ts` -- `language` column + `idea_translations` table -- AC1/AC2
- [x] `src/agent/registry.ts` -- internal translation model entry -- AC2
- [x] `src/agent/translate-idea-cards.ts` -- batch translate + cache + moderate -- AC1/AC2/AC5
- [x] `src/api/routes/ideas.ts` -- `POST /translate`, `POST /generate` language param -- AC1/AC2/AC4
- [x] `src/tools/llm/generate_ideas.ts` -- persist `language` -- AC4
- [x] `web/src/features/ideas/IdeasPanel.tsx` -- translate trigger, loading/error states, button language -- AC3/AC4
- [x] `web/src/locales/{en,de}/ideas.json` -- new keys -- AC3

**Acceptance Criteria:** (verbatim AC1-AC5 from epics.md Story 2.7 — not restated here)

## Implementation Notes

- Built per spec by a single implementation subagent; typecheck/lint clean across all 3 workspaces. Verified independently (re-run, not just trusted): `shared` 31/31, targeted `src` (translate-idea-cards/ideas/generate_ideas) 66/66, full `src` 275/275 (real Postgres, lane-b test DB), `web` IdeasPanel 19/19.
- Migration `0004_blushing_dakota_north.sql` was generated without first merging `main` per this story's own prompt instruction ("generate only at the end, after checking git log main and merging main into this branch") — a planning omission (not carried into this spec's Boundaries). `main`'s working tree has since advanced to its own, different `0003_outgoing_stick.sql`/`0004_long_the_initiative.sql` (Lane A/3.1, uncommitted). This lane's `0004` will very likely need regenerating at merge time under the already-established "whichever lands second regenerates its own" procedure — not fixed here since it requires merging `main` mid-flight against another session's actively-changing, uncommitted work.
- Manual check "measure wall-clock time for translating 5 cards" (spec Verification) was not run — needs real `OPENROUTER_API_KEY`/`MISTRAL_API_KEY` credentials this session doesn't hold and must not read from `.env`. Flagged for the user to run (or authorize inline) before calling this story fully done.

**User-reported bug, found live post-handoff (translation always failed):**

- **Root cause, confirmed directly from the running dev server's own error log (not a guess):** `TRANSLATION_MODEL_ID` (`src/agent/registry.ts`) was set to `'openai/gpt-6-mini'`, an id invented by analogy with the existing chat entries' naming at planning time and never verified against the real OpenRouter catalog — unlike the three existing chat entries, whose ids are each documented as checked against OpenRouter's own model pages. Every real `POST /api/ideas/translate` call failed immediately: `400 openai/gpt-6-mini is not a valid model ID`, logged and surfaced to the user as the spec's own intended "neutral notice + retry" — the failure-handling path worked exactly as designed, the model id behind it was simply wrong.
- **Fix:** `TRANSLATION_MODEL_ID` now reuses `'openai/gpt-6-luna'` — the exact id already proven live-working by every `generate_ideas`/chat call, same id as `DEFAULT_MODEL_ID`. This doesn't weaken "internal model, never in the user-selectable registry" (AC2): that guarantee comes from the entry's own `category: 'translation'` (excluded from `listSelectableModels`'s `chat`-only filter), not from using a literal id no other entry also uses. The registry now has two entries sharing one `id` (different `category`/`displayName`) — harmless, since nothing in this story's own path looks the translation id up via `findModelEntry`/`resolveModelId`; it's passed straight to `createChatModel`.
- **Verified:** `npm run typecheck --workspace=src`, `eslint src/agent/registry.ts`, and `registry`/`translate-idea-cards`/`generate_ideas.test` (61/61) all clean after the fix. The real live-translate call itself (and the 5-card timing measurement) still needs re-running with real credentials — same outstanding item as above, now unblocked by this fix rather than blocked by both the missing credentials and a wrong model id.
- **Test:** none added — this is a single string-literal value with no new branch of behavior; existing tests reference `TRANSLATION_MODEL_ID` symbolically and pass unchanged.

**Known-bad state avoided:** every translate request failing identically forever, with the user only ever seeing "couldn't translate, retry" and no way to tell it was a configuration bug rather than a transient one.

## Spec Change Log

## Review Triage Log

Two layers ran (blind-hunter, verification-gap), per this build's "one pass, at most 2 reviewers" budget.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | `translateIdeasRequestSchema.ideaIds` has no `.max()` and isn't deduped — a request can batch an unbounded/duplicated id list | low | Blind-hunter. Verified: `shared/schemas/idea-translations.ts`'s `z.array(z.uuid()).min(1)` has no upper bound; a duplicate id in `ideaIds` makes `translateIdeaCards`'s final `ideaIds.map(...)` return the same translation twice (harmless client-side — the frontend's `Map` collapses it — but wasteful). Bounded by the caller's own idea ownership, no cross-user harm. Trivial fix (`.max()` + dedupe). | patch |
| 2 | `generate_ideas`/`create_plan` reply-language enum duplication: `shared/schemas/plans.ts`'s `createPlanToolSchema.replyLanguage` hand-copies `z.enum(['en','de'])` instead of importing this story's new `replyLanguageSchema` | low | Verification-gap (pre-verified). `plans.ts` is concurrent, not-yet-committed lane work outside this diff's own baseline — fixing it here would cross this story's own Boundary ("don't touch plan files"). | defer |
| 3 | `translateIdeaCards`'s "model omitted a translation for idea X" throw branch has no dedicated test | low | Blind-hunter. Verified: only the moderation-reject and pre-aborted-signal branches are covered by the existing `it.each` failure-branch table; this third branch is real code with no test exercising it. Trivial to add as one more case. | patch |
| 4 | The model's structured output isn't filtered to the requested `missingIds` before building `translatedById` — a hallucinated extra `ideaId` flows into the moderation-text blob unfiltered | low | Blind-hunter. Verified: no leak or bad persistence results (insert/return are keyed off `translatable`, the real requested set), but nothing stops stray model output from reaching the moderation call. Trivial filter fix. | patch |
| 5 | `evaluateAssistantMessage(moderationText, classify, undefined)` always passes `undefined` for `threadId`, so a rejected-batch moderation-incident log has no correlating id | low | Blind-hunter. Verified: unlike other moderation call sites, this one has no real thread; a synthetic id from the already-in-scope `ideaIds` is a trivial substitute for the bare `undefined`. | patch |
| 6 | New `src/db/migrations/0004_blushing_dakota_north.sql` collides with `main`'s own, different, uncommitted `0004_long_the_initiative.sql`; this diff's snapshot `prevId` also doesn't match `main`'s current `0003` snapshot id | real (merge-blocking, not a code-logic defect) | Blind-hunter, cross-checked directly against `main`'s live `src/db/migrations/` tree and `meta/_journal.json`. Caused by a planning omission (see Implementation Notes), not fixable here without merging `main` mid-flight against another session's own in-progress work. | defer |
| 7 | Spec's own manual "measure 5-card translate latency" check wasn't run; `TRANSLATE_TIMEOUT_MS=30_000` is unvalidated against real model latency | real but blocked | Blind-hunter. Verified: every automated test stubs the model to resolve instantly; no real-credential run exists anywhere in this diff. Needs live `OPENROUTER_API_KEY`/`MISTRAL_API_KEY` this session must not pull from `.env`. | defer |
| 8 | Untested race-recovery branch: `onConflictDoNothing` + re-fetch-of-`stillMissingIds`, if a concurrent identical request wins the insert race | low | Verification-gap (pre-verified). Verified: deleting the block wouldn't fail any current test (no test forces the race). Low severity (silently-stays-untranslated, not a crash; retry available) and reproducing the race deterministically doesn't fit this repo's preference for non-flaky unit tests. | defer |
| 9 | All translated fields for a batch are discarded together if even one idea's translation fails re-validation | false | Verified against the spec's own Boundary: "One attempt, no retry... Failure/abort/moderation-reject persists nothing" and the "never a mixed-language flash, atomic swap" Design Note explicitly mandate whole-batch atomicity — this is the spec's intended behavior, not an unintended defect. | — |
| 10 | `ideaTranslationSchema.ideaId` is `z.string().min(1)` while `translateIdeasRequestSchema.ideaIds` is `z.array(z.uuid())` — inconsistent id typing | low | Blind-hunter. Verified real but no named harm (every real id is a valid UUID, so the looser schema never rejects good data) and the existing `idea-translations.test.ts` fixture deliberately uses a non-UUID `'idea-1'` id — tightening would require updating that test too, more than a direct correction. | reject (low + non-trivial fix) |
| 11 | `{language: 'fr'}` (a present-but-malformed body value) has no dedicated test of the "falls back to detection" path | false | Blind-hunter. Verified: this takes the exact same code path as the pre-existing, already-tested bodyless-request case (`bodyParseResult.success` is `false` either way) — no new, unproven behavior. | — |
| 12 | `POST /translate`'s ownership check loads the caller's full idea list via `getIdeasByUserId` on every request | false | Blind-hunter. Verified: identical pre-existing pattern already used by `GET /`/`POST /generate` before this diff, bounded by realistic per-user idea counts — not a regression this story introduces. | — |
| 13 | Spec's `Review Triage Log`/`Implementation Notes` were empty while `status: in-review` and all tasks checked | false | Blind-hunter. Moot — both are being written now as this review step's own output. | — |
| 14 | `rationaleSchema.safeParse` re-validation of a translated rationale appears unreachable given the model's own upstream `ideaDraftRationaleSchema` constraints | false | Verification-gap "other findings," verified: joining 2-3 already-≤140-char bullets with `\n` can't violate `rationaleSchema`'s 2-3-line/2000-char rule. Harmless defensive code, not a defect. | — |

**Patches applied:** findings #1, #3, #4, #5 (see Implementation Notes below for what changed). **Deferred:** #2, #6, #7, #8 (appended to `deferred-work.md`). **Rejected:** #9, #10, #11, #12, #13, #14 (disproven/false or low-with-no-named-harm, per evidence above).

## Design Notes

- New table, not a JSON column: simpler to key/upsert `(idea_id, language)`, keeps `ideas` untouched post-generation.
- New `translation` category: reusing the chat default's own id would make it user-selectable by definition; a distinct category reuses the moderation entry's existing exclusion mechanism.
- Merge happens in `IdeaCard`, not `IdeaEvidence` — zero prop changes to `IdeaEvidence.tsx`.

## Verification

**Commands:**
- `DATABASE_URL=<lane-b-test-db> npm test --workspace=src -- translate-idea-cards ideas` -- expected: new/changed tests pass
- `npm test --workspace=shared -- idea-translations` -- expected: pass
- `npm test --workspace=web -- IdeasPanel` -- expected: pass
- `npm run typecheck && npm run lint` (each workspace) -- expected: clean

**Manual checks:**
- Generate a batch in German, switch UI to English, confirm cards translate once (loading state, no mixed-language flash) and toggling back/forth after is instant.
- Measure wall-clock time for translating 5 cards; report it.
- Force a moderation/timeout failure path, confirm cards stay in stored language with a neutral notice + working retry, never blank.
