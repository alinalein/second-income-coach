# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete an intake and receive income ideas genuinely matched to their own skills, time, budget, risk tolerance, and what's stopped them before — not a generic list — grounded in current demand/trend evidence and a sourced baseline rate, and can curate the list by bookmarking or rejecting ideas, request more, and see cards translate on language change. Generation must stay fast enough not to feel broken on first use, without weakening any quality or validation rule.

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (required)
- Story 2.7: Translate Idea Cards on Language Change
- Story 2.8: Guided Flow from Intake to Plan
- Story 2.9: App Navigation Sidebar
- Story 2.10: Direct Paths for Button-Triggered Flows
- Story 2.11: Search Budget Guard
- Story 2.12: Smooth Generation Flow

## Requirements & Constraints

- `generate_ideas` produces exactly `IDEAS_PER_BATCH` ideas per run (2.2); a "more ideas" request appends a further batch of the same size, never repeating any idea already shown (`suggested`/`bookmarked`/`rejected`) (2.4).
- Each idea's rationale cites ≥3 distinct intake fields, with structured weekly time, startup cost, and risk level; an idea never exceeds the user's stated time, budget, or risk level (2.2/2.5).
- A sourced baseline rate (grounded via `web_search`, moderation-screened before caching, persisted with citation as integer minor-unit + currency code) is required per idea (2.2); a discovery search for current trends/demand signals also runs before writing ideas, producing a demand/trend evidence note from ≥3 distinct source domains plus a translated "how this can grow" note (2.5).
- An idea's source (baseline rate or demand evidence) must describe the same activity/occupation as the idea, checked deterministically against the quoted passage; otherwise the card is marked unverified. Login-walled salary sites that mask figures by region are never used as a source (2.5).
- All LLM output is validated against the shared Zod schema before any write; a validation failure is never silently saved.
- `web_search` usage is capped (default 6 searches/run, cheapest settings forced via a thin wrapper) and identical normalized queries are reused from a moderated cache within a configurable window; results are never shared across users and a changed intake invalidates them (2.11). Speed-ups may never reduce search count below this cap, weaken moderation, or weaken validation/source rules.
- Per-user daily generation limits and a shared daily search budget are enforced with clear, localized (DE/EN) messaging, distinct from error states; a run where every search fails stops immediately with no retries/draft writing and no count spent (2.11).
- `WEB_SEARCH_MODE=stub` returns fixed canned results with no network/credit use, for dev and tests (2.11).
- Idea cards translate on UI language change via one batched internal-model call (never the user-selectable registry), persisted per idea+language, with quotes staying in their original language (2.7).
- Story 2.6 (required, raised from optional 2026-11-17): typical generation time is a first-class acceptance criterion, not a nice-to-have. First round target: under ~30s average for the default batch, measured honestly before/after, no timeout increases. Second round (after a measured 100-155s regression): diagnose per-attempt elapsed time and rejection/retry reason first; the fix includes writing each idea in its own parallel model call (wall time ≈ one idea instead of the sum), with cross-idea soft rules (variety, domain spread) checked afterward and hard rules unchanged per idea; target under ~40s typical, never above ~60s; a miss is reported as a miss, not hidden by raising timeouts.
- Any speed-up must be reported with the Story 2.2/2.5 quality checks confirmed still passing unchanged.

## Technical Decisions

- AD-4: Zod-validate all tool/LLM output before any DB write; invalid data is rejected before a write occurs, never silently saved.
- AD-5: `web_search` is used only by `generate_ideas`.
- AD-6: Sourced baseline-rate citations (and demand evidence) persist on the idea's record.
- AD-7/AD-11: Search results are moderation-screened before being cached or used; cached/reused results must already have passed moderation.
- AD-16: Invalid/missing tool input is rejected by Zod before any write.
- AD-18: Intake and idea discussion (pre-plan) happen in a single discovery thread per user.
- AD-25: Chat-triggered generation follows the language the user wrote in; button-triggered generation uses the current UI language (ties to FR15, reply-language behavior).
- AD-27: Money is minor-unit integers with a sourced currency code; conversion uses the configured EUR/USD rate and is labeled an estimate when conversion occurred; a shared money helper (introduced 2.2) is reused by Stories 4.4/5.2/5.5, not reimplemented.
- Ideas list and intake UI layouts are fixed/final decisions (card layout; structured form) — not open for redesign within this epic.

## Cross-Story Dependencies

- 2.6 and 2.4 both modify `generate_ideas` and were built together in one session.
- 2.6's speed-ups must not regress 2.5's demand-evidence/growth-path quality checks or 2.2's rationale/validation checks.
- 2.11's search cap/cache and stub mode are a hard floor for any 2.6 speed-up — never reduced, bypassed, or raised in timeout to compensate.
- 2.5 depends on 2.1 (country field) and 2.2 (shared money helper, `web_search` usage).
- 2.7 depends on 2.2/2.5's full card field set (title, rationale, demand note, growth path, caveat) and FR15/AD-25's reply-language rules.
