# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete a structured intake and receive batches of 3 genuinely tailored second-income ideas - grounded in current market/demand data, not generic or guessed - and can curate them (select/bookmark/reject) and request more without losing what they already have. The epic also wires the mechanics around that core loop: a guided step-by-step flow from intake to idea to plan, app-wide navigation, fast direct-call flows for button-triggered actions, and a budget guard that keeps web-search usage small and predictable. Covers FR1, FR2, FR3, FR10, and NFR8 (one discovery thread per user).

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (optional, demo-time-permitting only)
- Story 2.7: Translate Idea Cards on Language Change
- Story 2.8: Guided Flow from Intake to Plan
- Story 2.9: App Navigation Sidebar
- Story 2.10: Direct Paths for Button-Triggered Flows (build before 2.9, 3.3, Epic 4)
- Story 2.11: Search Budget Guard

## Requirements & Constraints

- Intake captures skills/interests (free text), time/budget/risk (preselected ranges), and a "what's stopped you before" free-text answer classified into one of five known failure patterns; all fields including the classification persist to a dedicated Postgres table; a returning user sees their saved intake prefilled, never blank.
- `generate_ideas` always produces exactly 3 ideas per run (the fixed batch-size constant). Each idea's rationale cites >=3 distinct intake fields, includes structured weekly time/startup cost/risk level, and never exceeds the user's stated limits. Two intakes differing in >=2 fields must yield different idea sets.
- The baseline income rate is grounded via `web_search` (never guessed), moderation-screened before caching, and persisted on the idea record as an integer minor-unit amount + sourced currency code + citation.
- "More ideas" and later generations add a further batch of 3, never repeating anything already `suggested`, `bookmarked`, or `rejected`.
- Idea discovery also surfaces current demand/trend evidence (source URL, >=3 distinct source domains) and a translated "how this can grow" note; the intake gains a country field so rates/evidence are country-aware, with out-of-region sources clearly labeled.
- Idea-card translation (on UI language switch) is one batched model call for all visible cards, persisted per idea+language, and must never alter numbers, currency, citations, source URLs, or quoted text.
- Selecting/bookmarking/rejecting an idea is a plain deterministic Postgres update, never an LLM call.
- A shared money helper (minor units, EUR/USD conversion with as-of rate, `Intl.NumberFormat` formatting) is created in Story 2.2 and reused by Stories 4.4, 5.2, 5.5 - not reimplemented per story.
- Button-triggered flows (intake save, "generate ideas", plan creation) call tool handlers directly with no agent loop; only free-form chat keeps the agent loop. Failure-pattern classification is a direct structured-output call run in parallel with moderation of the free text.
- Search budget guard: a thin wrapper forces cheap, fixed `web_search` settings; a per-run hard cap on search count (default 6, tunable); 24h reuse of identical normalized queries (never shared across users, invalidated by intake changes); a "stub" search mode (no network/credits) for dev/test via one documented env var; separate configurable per-user daily generation limit and shared app-wide daily search budget, both with generous dev defaults and lower documented demo values, backed by Postgres counters.
- Story 2.2 introduces the `web_search` provider credential: add to `.env.example` and `src/config/env.ts` startup validation, and report which key the user must fill in. Story 2.11 adds the search-mode env var the same way.

## Technical Decisions

- AD-4 (tool boundary): `generate_ideas` is LLM-backed (one call that generates, validates against the shared Zod schema, then does a deterministic Postgres write in the same tool function - a validation failure is never saved); `set_idea_status` is plain-code. Amendment: UI button flows call these tool handlers directly, bypassing the agent loop.
- AD-5: `web_search` is the only MCP tool, used solely by `generate_ideas` (never by `get_projection`).
- AD-6: the sourced baseline rate is persisted once at generation time; it is never re-fetched or recomputed later.
- AD-7: `web_search` gets a short-TTL `CachePolicy`; moderation (AD-11) must complete before any result is cached - a cache hit never bypasses moderation.
- AD-11: `beforeModel` screens user input; `wrapToolCall` around `web_search` strips/cleans flagged search-result content rather than rejecting the whole search.
- AD-13: idea status flow is `suggested` -> `selected` | `bookmarked` | `rejected`; rejected ideas are removed from the visible list, not deleted.
- AD-16: shared Zod schemas define `failurePattern`/`ideaStatus`; DB enums stay in lockstep, never hand-copied.
- AD-18: exactly one discovery thread per user, used for intake and idea discussion before any plan exists - never a plan-specific thread.
- AD-27: currency is a user setting (EUR/USD, default EUR); money is integer minor units + ISO code, never a float; conversions use one configured as-of rate and are always labeled an estimate.
- AD-30: all Postgres access goes through Drizzle ORM; `express-rate-limit` applies a stricter limit to `generate_ideas` than to plain-code reads.

## UX & Interaction Patterns

- Intake is a visible structured form with standard fields - never a conversational/chat intake; revisiting shows saved values prefilled.
- Ideas render as a card layout; each card shows its rationale, baseline-rate citation, demand/trend evidence with source URL, and growth-path note directly on the card - never behind a detail view.
- Select/bookmark/reject actions live directly on each card, never behind a separate menu or screen.
- Selecting an idea opens a confirmation dialog (this becomes the chosen idea; others stay as bookmarks) before the plan is created; cancel changes nothing.
- A left sidebar (collapsing to an overlay on narrow screens) lists "New ideas," "My plans," "Bookmarked," and a profile entry with Settings/theme/sign-out; the active view/plan persists across reloads.
- Translation shows a localized loading state (no mixed-language flash) and, on failure, keeps the stored language with a neutral notice and retry.
- Limit-reached messages (per-user or app-wide search budget) are worded plainly as a limit, never like an error, with the generate button disabled and existing ideas still usable.

## Cross-Story Dependencies

- 2.2-2.5, 2.11 all extend the same `generate_ideas` path (generation rules, discovery/growth, translation, budget guard) rather than introducing a parallel one.
- 2.7's translation depends on the UI language switch built in Story 5.4 (Epic 5).
- 2.8 depends on Story 3.1 (plan generation) and 3.3 (plan switching) in Epic 3 for what happens after idea selection; it must not change 3.2's activation confirmation.
- 2.9's sidebar depends on Epic 3's plan workspace (3.1/3.3) and Epic 5's settings page (5.1/5.4/5.5).
- 2.10 is scheduled before 2.9, 3.3, and Epic 4 because it changes how every later flow is wired; it must leave Stories 2.1, 2.2, 2.5, and 3.1's acceptance criteria passing unchanged.
- The money helper from 2.2 is reused by Stories 4.4, 5.2, 5.5; `user_settings` (currency default) is created in Story 1.2, so no story here has a forward dependency on Epic 5.
