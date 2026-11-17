---
title: 'Story 2.5: Opportunity Discovery & Growth Path'
type: 'feature'
created: '2026-11-16'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: '0a90c60'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.2's ideas are grounded only in a baseline *rate*, with no current demand/trend evidence, no growth note, and no country signal — so sources skew US-centric (dollar figures for a German user), Glassdoor-style masked-by-region pages have slipped through, and a cited source can describe a different occupation than the idea.

**Approach:** Add a discovery step (still one bounded `web_search`-backed nested agent, AD-5) that sources a demand/trend note per idea alongside the existing baseline rate, add a translated growth-path note, add an intake `country` field that steers source-region preference, and add a deterministic occupation-match check + source-region label so a mismatched or foreign-region source is visible, never silently presented as local.

## Boundaries & Constraints

**Always:**
- Everything stays inside `generate_ideas`'s existing nested, bounded, uncheckpointed `createAgent` call (one invocation, no new agent/tool-calling loop) — the discovery search is a prompt-level addition to the same batch of `web_search` calls, not a second LLM call.
- `MAX_DRAFT_ATTEMPTS` (2) and `NESTED_AGENT_RECURSION_LIMIT` are unchanged — no new retry mechanism, no new attempt budget. **Renegotiated post-handoff (Spec Change Log, round 1):** `DRAFT_ATTEMPT_TIMEOUT_MS`/`IDEAS_MODEL_NODE_TIMEOUT_MS`/the client's `GENERATE_TIMEOUT_MS`/`TYPICAL_GENERATE_DURATION_MS` values *did* change, with explicit user approval, after a live-reproduced 502 showed the original "no timeout changes" line was no longer viable once this story's extra required search per idea was accounted for.
- New per-idea evidence (`demandEvidenceNote`/`Citation`/`Quote`, `growthPath`) are hard Zod-required on the model's draft output; an idea whose demand-evidence quote doesn't verify against a real retrieved result, or whose source looks login-walled/blurred/empty, is rejected and retried (mirrors `baselineRateQuote`'s existing hard treatment) — never persisted as invented.
- Occupation/activity match (idea title vs. the quoted passage, for both baseline rate and demand evidence) is a deterministic, non-blocking label: a mismatch sets the relevant unverified flag, never rejects. Demand-evidence domain diversity is likewise logged-only, never blocking — consistent with round 12's explicit lesson and this story's "no new retries" instruction.
- Glassdoor-style masked-by-region sources stay a hard rejection (already built in 2.2 round 15; reused for demand evidence too via the generalized blocked/hidden check).
- `ideas` table gets new nullable columns (no default possible for free text) for the new evidence fields — Lane A's frozen `src/api/routes/ideas.ts`/`ideas.test.ts` insert fixtures without them, so these must tolerate `null`, never `NOT NULL`.
- `intake.country` is `NOT NULL DEFAULT 'other'` at the DB level (migration safety net only); the client-facing Zod request schema still requires it on every new submission.
- Source-region labeling is computed from the stored citation URL at render time (new pure `shared/region.ts` function), never persisted as its own column — one source of truth, no schema growth for a derivable value.
- `country` values: `['DE', 'AT', 'CH', 'US', 'GB', 'other']` (human-confirmed) — matches every domain already in `generate_ideas.ts`'s tier-1 official-statistics list; `'other'` means no regional preference.

**Never:**
- Do not touch `web/src/features/ideas/IdeasPanel.tsx` beyond the one line mounting `<IdeaEvidence idea={idea} />` — **renegotiated post-handoff, narrowly:** two numeric timeout constants (`GENERATE_TIMEOUT_MS`, `TYPICAL_GENERATE_DURATION_MS`) were also edited, with explicit user approval, per the Spec Change Log; no layout/button/status/JSX in that file changed. Still do not touch `src/api/routes/ideas.ts`, `set_idea_status`, chat, auth, or `scripts/`.
- Do not change any timeout/ms constant in `generate_ideas.ts`/`resilience.ts`/`IdeasPanel.tsx` — **renegotiated post-handoff**, see Spec Change Log.
- Do not add a second trust-tier system for demand evidence — reuse the existing blocked/hidden + quote-verification checks, no new tier taxonomy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Demand evidence quote not retrievable | Model's quote absent from any search result | Batch rejected, retried once | Same AD-4 retry-then-error path |
| Demand evidence source blocked/masked | Retrieved page login-walled/blurred/empty | Batch rejected, retried once | Same as baseline-rate's existing check |
| Occupation mismatch | Quote describes a different activity than the idea title | Idea persisted, relevant `isXUnverified` flag true | Never rejected |
| Foreign-region source | Citation domain resolves to a country != user's `country` | Card shows a region label (e.g. "US data") | N/A |
| Unknown-domain source | Citation domain not in the region map | No region label shown (no claim either way) | N/A |
| Legacy/foreign idea row missing new fields | A row inserted outside this path (e.g. Lane A's test fixtures) | `GET /api/ideas` still returns 200; `IdeaEvidence` renders nothing for that idea | N/A |

</frozen-after-approval>

## Code Map

- `src/tools/llm/generate_ideas.ts` -- add `demandEvidenceNote/Citation/Quote`, `growthPath` to `ideaDraftSchema` + prompt; add `occupationMatchesIdea` (deterministic word-overlap, non-blocking); reuse `quoteMatchesSearchResults`/generalize `sourceEvidenceLooksBlockedOrHidden` to take `(citation, quote, searchResultTexts)` for both evidence types; add demand-evidence domain-diversity as a logged-only soft check (mirrors `MIN_DISTINCT_CITATION_DOMAINS`); persist new columns + `isDemandEvidenceUnverified`; prompt gains country-driven region preference (replacing the current reply-language-only heuristic) and discovery-search instructions.
- `shared/schemas/ideas.ts` -- new fields on `ideaDraftSchema`/`ideaResponseSchema` (nullable on the response side), `isDemandEvidenceUnverified`.
- `shared/schemas/intake.ts` -- `countryCodeSchema` (or import from new `shared/region.ts`), add `country` to `submitIntakeRequestSchema`/`intakeResponseSchema`.
- `shared/region.ts` (new) -- `countryCodeSchema`, `classifyCitationRegion(citation): CountryCode | undefined`, domain->region map seeded from 2.2's own tier-1 domain list.
- `src/db/schema/ideas.ts` -- new nullable `text()` columns (`demand_evidence_note/citation/quote`, `growth_path`) + `is_demand_evidence_unverified boolean NOT NULL DEFAULT false`.
- `src/db/schema/intake.ts` -- `country text NOT NULL DEFAULT 'other'`.
- `src/tools/plain/submit_intake.ts` -- `toIntakeResponse` passes through `country`; no logic change otherwise (same enum-field precedent as `riskTolerance`).
- `src/api/routes/intake.ts` -- `buildIntakeAgentMessage` includes `country` in the literal-data message (same style as the other enum fields).
- `web/src/features/intake/IntakeForm.tsx` -- one new `<Select>` field (country), `BLANK_FORM`/`formFromRecord` gain it.
- `web/src/features/ideas/IdeaEvidence.tsx` (new) -- renders demand evidence note + citation link + region label (if foreign/resolvable), growth path, and a baseline-rate region label (since the existing citation row can't be touched); fetches `GET /api/intake` itself for the viewer's `country` (no prop threading through the frozen `IdeasPanel.tsx`/`ideas.ts`).
- `web/src/features/ideas/IdeasPanel.tsx:~342` -- one added line inside `IdeaCard`'s existing `CardFooter`, mounting `<IdeaEvidence idea={idea} />`.
- `web/src/locales/{en,de}/intake.json` + `ideas.json` -- `country.*` option labels; `card.growthPathLabel`, `card.demandEvidenceLabel`, `card.region.*`, `card.foreignSourceLabel` (interpolated).
- Tests to extend (fixtures only, no new `it`): `src/tools/plain/submit_intake.test.ts`, `src/api/routes/intake.test.ts` (`country` in fixture helpers); `src/tools/llm/generate_ideas.test.ts` (`buildValidDraft`/`DEFAULT_SEARCH_RESULT_TEXTS` gain the new fields); `web/src/features/ideas/IdeasPanel.test.tsx` (mock `/api/intake` for the new component's own fetch).

## Tasks & Acceptance

**Execution:**
- [x] `shared/region.ts` -- new `countryCodeSchema` + `classifyCitationRegion` -- region labeling, country AC
- [x] `shared/schemas/intake.ts` -- `country` field -- country AC
- [x] `shared/schemas/ideas.ts` -- demand-evidence/growth-path fields, `isDemandEvidenceUnverified` -- AC1/AC2/AC4
- [x] `src/db/schema/intake.ts`, `src/db/schema/ideas.ts` -- new columns (nullable per Boundary) -- AC6
- [x] `src/tools/plain/submit_intake.ts`, `src/api/routes/intake.ts` -- thread `country` through -- country AC
- [x] `src/tools/llm/generate_ideas.ts` -- discovery prompt, occupation-match check, demand-evidence hard/soft checks, persistence -- AC1-AC7
- [x] `web/src/features/intake/IntakeForm.tsx` -- country select -- country AC
- [x] `web/src/features/ideas/IdeaEvidence.tsx` (new) + one line in `IdeasPanel.tsx` -- AC2/AC4/AC6/AC7
- [x] `web/src/locales/{en,de}/{intake,ideas}.json` -- new keys
- [x] Migration -- generated last, after confirming no new commits on `main` since baseline (`0003_cloudy_wolfsbane.sql`)

**Acceptance Criteria:** (verbatim from epics.md Story 2.5 — see that file; not restated here)

## Implementation Notes

- Built per spec, then 6 review patches applied (see Review Triage Log). Final: `shared` 23/23, `src` 202/202, `web` 45/45 tests pass (+8/+8/+3 new, 19 total — under CLAUDE.md's 20-test cap); `npm run typecheck`/`npm run lint` clean across all three workspaces.
- `shared/tsconfig.json` needed `"types": ["node"]` added (matching `src`'s own precedent) plus `region.ts` added to its `include` list — `region.ts` uses `new URL(...)`, which needs Node's ambient types since `shared`'s `lib` has no DOM; this doesn't leak into consumers since no exported function signature references `URL`.
- `sourceEvidenceLooksBlockedOrHidden`'s signature changed from `(draft, searchResultTexts)` to `(citation, quote, searchResultTexts)` so the identical check applies to demand evidence too — updated its one call site and its own test's call site (both in files this story owns).
- Test fixture ripple (no new `it`s beyond what's listed in Review Triage/below): `submit_intake.test.ts`, `intake.test.ts`, `App.test.tsx` fixture helpers gained `country`; `generate_ideas.test.ts`'s `buildValidDraft`/`DEFAULT_SEARCH_RESULT_TEXTS` gained the new demand-evidence fields (and the baseline quote was reworded to genuinely match the title via `occupationMatchesIdea`, documented inline); `IdeasPanel.test.tsx`'s `fakeIdea()` gained the new nullable fields, and its 3 pre-existing tests now also mock `/api/intake` (the new `IdeaEvidence` component's own fetch).
- **Boundary-driven design choice, not a judgment call left open:** the 4 new `ideas` columns are nullable (no default possible for free text) specifically because Lane A's frozen `src/api/routes/ideas.test.ts` inserts fixture rows without them, and that file is off-limits to this story.
- **User-reported live bug, post-handoff (1 fix, timeout values raised — see Spec Change Log below for the full story):** the user hit a real 502 live. Reproduced directly (`handleGenerateIdeas` called against the real DB/credentials, bypassing HTTP) — this story's extra required search per idea pushed real attempts close to/over the existing `DRAFT_ATTEMPT_TIMEOUT_MS` (75s). A first fix attempt (merge the two searches into one per idea, to cut search *count*) was tried and measured live — it backfired (more total searches, larger retrieved pages, no improvement) and was reverted. The user then approved raising timeouts (same precedent as Story 2.2's own round 8). **Verified live after the raise:** a clean run persisted 5 real ideas for the user's actual account in **94,600ms**, first attempt, zero soft failures, zero degradation — not a synthetic measurement.
- DB: applied the equivalent `ALTER TABLE` statements directly to `second_income_coach_b`/`second_income_coach_b_test` (with the user's explicit permission, after auto-mode blocked the first attempt) so the integration suite could run against real schema; then generated the real migration (`0003_cloudy_wolfsbane.sql`) and registered it in `drizzle.__drizzle_migrations` in both lane databases (same sync procedure as every prior round in `spec-2-2`) rather than re-running its SQL, since it was already applied by hand. Never touched the shared `second_income_coach` database.

## Spec Change Log

**User-reported bug, round 1, found live post-handoff (timeout values raised, Boundary explicitly renegotiated):**

- **Root cause, confirmed by live reproduction (not just read from the code):** called `handleGenerateIdeas` directly against the user's real account/intake row with real Tavily/OpenRouter credentials, bypassing HTTP. This story's second required `web_search` per idea (discovery/demand-evidence, on top of the existing baseline-rate search) roughly doubled real search volume per attempt. One attempt measured ~74s — already within a few seconds of the then-75s `DRAFT_ATTEMPT_TIMEOUT_MS` — before being rejected on an unrelated hard check; a second attempt needed even more search rounds and was killed by that same timeout before finishing. This is exactly the user's observed 502.
- **Fix attempt 1, tried and reverted (user-directed: "cut search volume instead"):** merged the two per-idea searches (baseline rate + demand evidence) into one combined search instruction. Measured live: this backfired — the model issued *more* total search calls (17 vs. 10-13), apparently because satisfying one search with two distinct information needs is a harder ask, and some retrieved pages were far larger (65-85KB), increasing moderation/reasoning time per call. Still timed out. Reverted to the original two-separate-searches prompt wording (verified byte-for-byte equivalent to the pre-fix version by direct comparison).
- **Fix attempt 2, applied (user-approved after fix 1's live failure — explicit Boundary renegotiation, not a judgment call):** this story's original Boundary said "do not change any timeout values." The user approved raising them once fix 1 (cutting volume without touching timeouts) was shown live not to work. Raised, same precedent as Story 2.2's own round 8 ("the budget was shorter than a normal successful run"):
  - `DRAFT_ATTEMPT_TIMEOUT_MS` (`generate_ideas.ts`) 75s -> 110s.
  - `IDEAS_MODEL_NODE_TIMEOUT_MS` (`resilience.ts`) 170s -> 230s (2 attempts at 110s = 220s, plus margin for the outer agent's own decision/final-reply calls).
  - `GENERATE_TIMEOUT_MS` (`IdeasPanel.tsx`) 190s -> 250s, `TYPICAL_GENERATE_DURATION_MS` (same file) 56s -> 82s (scaled proportionally; an estimate, not a fresh measurement of a clean successful run at the time it was set).
  - **Boundary exception, explicitly called out:** `IdeasPanel.tsx` was edited beyond the one `<IdeaEvidence>` line this story's Boundary otherwise restricts it to — but only these two numeric constants, with user approval obtained specifically for this exception; no layout/button/status/JSX in that file was touched.
- **Verified live, after the raise:** a clean `handleGenerateIdeas` run persisted all 5 ideas for the user's real account on the first attempt, zero soft failures, zero degradation, in **94,600ms** — this is the story's own honestly-measured generation time, not a placeholder.
- **Test:** no new test added — these are plain numeric constants with no new branch of behavior (same precedent as Story 2.2's own round 8, which also added none); `resilience.test.ts`/`generate_ideas.test.ts` reference the constants symbolically, confirmed to pass unchanged against the new values.

**DB migration sync:** none — this round changed no schema.

**Known-bad state avoided:** a per-attempt budget shorter than the real workload this story added, guaranteeing intermittent 502s on real accounts; a "fix" (merging searches) that looked reasonable but measurably made real-world latency worse, shipped without ever being measured live.

**KEEP (round 1, verified still true):** every other Story 2.5 mechanism (occupation-match check, demand-evidence hard/soft checks, source-region labeling, country field) is untouched by this round — only the four timing constants and the prompt's search-instruction wording (reverted to its original, pre-fix-attempt-1 text) changed.

**User-directed fixes, round 2, found live post-handoff (3 directives):**

- **Fix 1 (bug — AD-27 currency-consistency gap, user-reported):** verified the concern directly: nothing previously checked that the currency *symbol* in `baselineRateQuote` actually matched the self-reported `baselineRateCurrency` persisted alongside it. A model could (and, per the existing test fixtures' own long-standing `$`-quote/`EUR`-code mismatch, plausibly would) mislabel a genuinely-USD source as EUR — the number would still pass `quoteSupportsRate`, and the frontend's `convertMoney` would then treat it as "already in the target currency" (no conversion, no estimate badge), silently presenting a USD rate as a local EUR one. Fixed with a new deterministic hard check, `quoteContradictsCurrency` (`generate_ideas.ts`): rejects (retries, same path as every other hard check) when the quote clearly shows the *other* supported currency's symbol/word and not the reported one. Deliberately only flags an explicit contradiction — a quote with no recognizable symbol at all is not rejected.
- **Fix 2 (country enum narrowed, FR16/AD-27):** `countryCodeSchema` (`shared/region.ts`) narrowed from `['DE','AT','CH','US','GB','other']` to `['DE','AT','US','other']` — `CH`/`GB` use CHF/GBP, which this codebase's `currencyCodeSchema` (EUR/USD only) can't represent or convert; a CH/GB user now picks `'other'`, the same "no regional preference" outcome an unmapped country already gets. `REGION_DOMAINS` lost its `CH`/`GB` entries (`bfs.admin.ch`/`ons.gov.uk` now resolve to no region label — they remain genuinely trustworthy tier-1 *sources* in `generate_ideas.ts`'s own separate trust-tier list, unchanged); `COUNTRY_PREFERENCE_TEXT` lost the same two entries. Intake form options and both locale files' `country.*`/`card.region.*` keys updated to match (dead `CH`/`GB` keys removed, not just unreferenced).
- **Fix 3 (no-crash guarantee for legacy data):** `country` is plain `text()` with no DB check constraint (unchanged, established precedent) — an existing row could still hold `'CH'`/`'GB'`. New `normalizeCountry` (`submit_intake.ts`) falls back to `'other'` for any value `countryCodeSchema` no longer recognizes, applied inside `toIntakeResponse` so every read path (`GET /api/intake`, the agent's `generate_ideas` prompt input, `IdeaEvidence`'s own fetch) is covered by the one normalization point — never throws.
- **DB:** confirmed via `npm run db:generate` — "No schema changes, nothing to migrate." `0003_cloudy_wolfsbane.sql` is unaffected; no new migration. No existing row in either lane-b database currently holds `CH`/`GB` (checked directly).
- **Test:** 2 new (`generate_ideas.test.ts`'s corrupted-batch table gained one row for the currency-contradiction hard check; `submit_intake.test.ts` gained one test proving a raw `'CH'` row reads back as `'other'` without throwing). `shared/region.test.ts`'s existing CH/GB rows had their expectations changed in place (now `undefined`, same row count) rather than removed, to keep regression coverage that those specific domains are deliberately unmapped. **Running total for this story: 21 new tests across both rounds (19 + 2) — one over CLAUDE.md's 20-test guideline, flagged here rather than dropped: both of this round's tests protect a real correctness/no-crash guarantee the user explicitly asked for.**

**Known-bad state avoided (round 2):** a USD-sourced rate silently rendered as an unconverted "local" EUR figure with no estimate badge at all — the exact AD-27 violation this story's own AC exists to prevent; a CH/GB-selecting user being offered a country whose currency this codebase can never correctly display; a legacy CH/GB intake row 503ing `GET /api/intake` forever once the enum narrowed.

**KEEP (round 2, verified still true):** every round-1 mechanism (occupation-match check, demand-evidence hard/soft checks, the raised timeouts, DE/AT/US region-preference text) is untouched by this round except where explicitly narrowed above.

**User-reported bug, round 3, found live post-handoff (this story's final fix round, per the user's own fix-round cap):**

- **Diagnosis (user-directed: diagnose first, change nothing until the cause was known):** the "Generate new ideas" 502 was not a timeout or a validation rejection — it was upstream of `generate_ideas` entirely. The outer coach agent (the one `POST /api/ideas/generate` actually invokes) never called the tool at all; it replied conversationally asking the user to resupply intake fields (including `country`), even though intake already existed and the trigger message explicitly instructed it to call `generate_ideas` now.
  - Isolated live, layer by layer, by replicating the real outer-agent stack directly (bypassing HTTP): the full `createCoachAgent`-wrapped path refused 3/3 times; a bare agent with no middleware called the tool correctly; a bare agent with *only* the "coach" system-prompt middleware refused; a bare agent with only moderation, or only progress, middleware called the tool correctly; the system-prompt middleware with `generate_ideas` as the *only* available tool (no `submit_intake`) called the tool correctly.
  - **Root cause:** the "coach" system prompt (pre-existing, not this story's) combined with `submit_intake` being available alongside `generate_ideas` (always true in production) made the model consistently choose to ask for intake fields conversationally instead of calling `generate_ideas`, despite the explicit instruction. Neither the per-attempt timeout, the ideas-node timeout, the client timeout, nor a validation rejection fired — the tool was simply never invoked, so neither of the two pre-approved fix types (raise a timeout / relax a check) applied.
- **Fix (scope explicitly renegotiated with the user, since neither pre-approved fix type applied):** reworded `generate_ideas`'s own tool description (`generate_ideas.ts`) — removed the conditional "a user who has **already completed intake**" framing (the likely hedge-trigger once `submit_intake`'s params, now including `country`, are also in the model's view) for an unconditional one: always call this tool when asked to generate ideas; it reads intake itself and fails loudly on its own if none exists, which the caller then relays — never the caller's job to guess that in advance. No agent/personality/system-prompt file touched (would have been out of this story's reach regardless).
- **Verified live, after the fix, via the exact production path (`createCoachAgent`, real checkpointer, real retry policy) — not a simplified harness:** a clean run persisted all 5 ideas on the first attempt, zero soft failures, zero degradation, in **82,970ms** (72,166ms inside `generate_ideas` itself) — this is the story's final, honestly-measured generation time.
- **Test:** none added — this is a tool-description string with no new branch of code behavior to cover (consistent with CLAUDE.md's testing policy and this story's own precedent for pure-wording fixes); `204` tests still pass unchanged.
- **DB migration sync:** none.

**Known-bad state avoided (round 3):** a tool description whose own conditional wording ("a user who has already completed intake") gave the outer model an opening to hedge and never call the tool at all — the most severe failure mode this story hit, since nothing downstream (timeouts, validation) ever got a chance to run.

**KEEP (round 3, verified still true):** every round-1/round-2 mechanism (occupation-match check, demand-evidence hard/soft checks, currency-contradiction check, the raised timeouts, the narrowed country enum) is untouched — only `generate_ideas`'s own tool-description string changed.

## Review Triage Log

Three parallel review layers (blind-hunter, edge-case-hunter, verification-gap) ran against the diff since `baseline_commit`.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | `significantWords`'s regex (`[a-zà-öø-ÿ]+`) excludes German `ß` (U+00DF), which falls below both the `à-ö` (U+00E0-U+00F6) and `ø-ÿ` (U+00F8-U+00FF) ranges — splits words like "Straße"/"Fußpflege" at the ß | medium | Blind-hunter. Verified directly in Node: `'fußpflege'.match(/[a-zà-öø-ÿ]+/g)` → `['fu','pflege']`; `0xdf < 0xe0`. Weakens the occupation-match heuristic specifically for German text, which is this story's own stated target market. | patch |
| 2 | `IdeaEvidence` is mounted once per idea card (5x per panel) and each instance independently fetches `GET /api/intake` — 5 duplicate requests per render for the same viewer-country value | low | Blind-hunter + verification-gap (same finding, "other"). Verified real. Rejected: the fix (lift the fetch one level, or a module-level shared cache) either violates this story's own Boundary ("do not touch `IdeasPanel.tsx` beyond the one line") or reintroduces the cross-test-state-pollution risk already reasoned through and deliberately avoided when this component was built (documented in its own Implementation Notes). 5 cheap, fast, indexed-read GETs on one page view is not something a user would notice in everyday use. | reject |
| 3 | `shared/tsconfig.json`'s new `"types": ["node"]` widens the ambient global surface for the *entire* `shared` package (consumed by both Node and the browser) just so `region.ts` can type `URL` | low | Blind-hunter. Verified real: nothing in `shared` uses a Node-only global like `process`/`Buffer` today, so no *active* bug, but it is a real, avoidable type-safety regression for a dual-environment package. Fix is a direct, better-targeted correction than the reviewer's own suggestion (importing `node:url` would literally break the browser bundle, since `URL` is a WHATWG standard this package needs typed for *both* environments, not a Node-only API) — add `"DOM"` to `lib` instead of `"types": ["node"]`. | patch |
| 4 | Demand-evidence verification adds a second mandatory hard web-search check stacked onto the unchanged `MAX_DRAFT_ATTEMPTS = 2` budget — plausibly raises total-batch failure rate, unmeasured | maybe-false (medium/high if true) | Blind-hunter. Could not settle without a live `generate_ideas` run against real Tavily/OpenRouter credentials — this environment has neither (`@langchain/mcp-adapters` isn't even installed). Exactly the kind of risk the epics AC itself mandates accepting ("an idea without sourced evidence is retried, not shown" is a hard requirement, not this implementation's invention) — not a spec deviation, a real open question about *how often* it fires in practice. | defer |
| 5 | `IntakeForm`'s `BLANK_FORM.country` defaults to `countryCodeSchema.options[0]` = `'DE'`, not the neutral `'other'` — a user who never touches the field silently gets Germany asserted as their country, which then drives real region-preference/labeling behavior they never chose | medium | Blind-hunter. Verified real: unlike the other enum defaults in this form (time/budget/risk, where "wrong" just means a slightly-off starting estimate), a wrong country default asserts a specific, possibly-false fact about the user that steers source selection and suppresses the "foreign source" label for a source that actually is foreign to the user's real location. Fix is a trivial one-line default change. | patch |
| 6 | New `intake.country` column (`text NOT NULL DEFAULT 'other'`) has no DB-level CHECK constraint/enum, "unlike the stated project precedent that enum-backed fields stay in lockstep with a DB-level representation" | false | Blind-hunter. Disproven directly: `src/db/schema/intake.ts`'s own existing doc comment states the opposite precedent verbatim — "every enum-shaped column stays plain `text()` ... no `pgEnum`, no DB check constraint" — and every other enum column in this codebase (`status`, `riskLevel`, `ideaType`, `sourceTrustTier`, `failurePattern`, etc.) already follows exactly this pattern. `country` is consistent with established precedent, not a deviation from it. | — |
| 7 | `0003_cloudy_wolfsbane.sql`/`0003_snapshot.json` are missing a trailing newline, "inconsistent with the rest of the migration files" | false | Blind-hunter. Disproven directly: `0002_silly_red_shift.sql`/`0002_snapshot.json` (pre-existing, untouched by this story) end identically with no trailing newline — this is `drizzle-kit`'s own consistent generator output, not an inconsistency this diff introduced. | — |
| 8 | Discovery-search prompt allows sourcing demand evidence "shared across closely related ideas," looser than the baseline-rate instruction (strictly per-idea) — nothing stops two unrelated ideas sharing loosely-relevant, copy-pasted demand evidence beyond the generic occupation-match label | low | Blind-hunter. Verified real but no more than the already-accepted limitation of every other evidence check in this system (none of them "fully validate genuine support," including the pre-existing baseline-rate domain cap, which already tolerates up to 2 ideas sharing one citation). No named harm beyond the inherent approximation every check in this story already accepts; "fixing" it would be a product-policy change (e.g. mandating distinct per-idea searches), not a direct correction. | reject |
| 9 | `DEMAND_EVIDENCE_NOTE_MAX_LENGTH`/`GROWTH_PATH_MAX_LENGTH` are new arbitrary length caps with no near-boundary test | low | Blind-hunter. Verified real but a boundary test here would be testing Zod's own `.max()` mechanics — exactly what CLAUDE.md's testing policy excludes ("Do not test framework or library behaviour"). Adding one would violate this project's own stated testing policy, not satisfy it. | reject |
| 10 | `occupationMatchesIdea`'s bare ≥5-letter-word overlap (no stopword list) can match on a generic word unrelated to occupation (e.g. "online", "weekly", "basic") | medium | Blind-hunter. Verified real and concrete: a title containing "Online tutoring" and an unrelated quote about "online grocery delivery" would match on "online" alone. This is a real gap beyond the deliberately-documented leniency tradeoff (that tradeoff is about *missing* a real match, not about a *false* match on a content-free qualifier) — a small stopword list is a bounded, direct correction, not a new mechanism. | patch |
| 11 | `foreignSourceRegion` returns `undefined` identically for "domain unresolvable" and "`viewerCountry` hasn't loaded yet" — idea cards render immediately with the raw baseline rate while the `/api/intake` fetch is in flight, a brief window with no foreign-source caveat | low | Blind-hunter. Verified real but self-correcting within a fraction of a second on every page load (a fast, same-origin, already-cached-by-the-browser-pattern GET) — unlikely to be met in everyday use, and the fix (a loading/skeleton state for the badge area) is more than a direct correction. | reject |
| 12 | `isDemandEvidenceUnverified` is wired and rendered but never asserted `true` anywhere — swapping its assignment (or dropping the `!`) would not fail any test | medium | Verification-gap (pre-verified). Filed evidence: the one occupation-mismatch integration test leaves `demandEvidenceQuote` at its batch default, which happens to share "freelance" with the overridden title, so it never exercises the mismatch branch on the demand-evidence side; every `IdeasPanel.test.tsx` fixture reaching `IdeaEvidence` hardcodes `isDemandEvidenceUnverified: false`. A silent mis-wire of the exact mechanism this story adds to fix a user-reported bug would ship undetected. | patch |
| 13 | The baseline-rate foreign-source-region label branch (`IdeaEvidence.tsx`'s `baselineRegion`) is dead code as far as verification goes — no test ever pairs a mapped-foreign `baselineRateCitation` with a differing, resolvable `viewerCountry` | medium | Verification-gap (pre-verified). Filed evidence: the one foreign-region-label test uses `demandEvidenceCitation` for its US domain while `baselineRateCitation` stays at `fakeIdea()`'s unmapped default — deleting the baseline-region render branch entirely would not fail anything. This is the spec's own literal motivating scenario (its "Manual checks" section names this exact case) with zero automated coverage. | patch |
| 14 | `IdeaEvidence`'s `useEffect` has an empty dependency array and never refetches `/api/intake` if the viewer's country changes while the component stays mounted | false | Edge-case-hunter. Disproven directly: `web/src/App.tsx`'s rendering is a ternary between `<IntakeForm>` and the `<IdeasPanel>`+`<ChatThread>` fragment (pre-existing structure, not touched by this story) — revisiting/editing intake fully unmounts `IdeasPanel`/`IdeaEvidence`, and finishing that revisit remounts it fresh, which re-runs the empty-dependency effect. There is no code path where `IdeaEvidence` stays mounted across an intake change. | — |

**Patches applied (round 1 of this story's fix-round cap):** findings #1, #3, #5, #10, #12, #13 — see Implementation Notes below for what changed. Findings #2, #8, #9, #11 rejected (documented above). Finding #4 deferred to `deferred-work.md`. Findings #6, #7, #14 disproven.

## Design Notes

- Occupation-match heuristic: significant words (>=5 letters) in the idea title that also appear in the quoted passage; zero significant words in the title => treated as a match (nothing specific to check). Deliberately lenient (minimizes false "unverified" flags) since the AC only requires labeling, not rejection.
- Region labeling is directional only: a resolvable foreign domain gets a label; an unresolvable domain gets none (never a wrong claim).

## Verification

**Commands:**
- `npm test` (shared/src/web, filtered to new/changed files)
- `npm run typecheck` (each workspace)

**Manual checks:**
- Submit intake with a `DE` country, generate ideas, confirm at least one card shows demand evidence + growth path; confirm a US-sourced baseline rate (if any) shows a foreign-region label.
