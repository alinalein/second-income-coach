# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete a structured intake (skills/interests, time/budget/risk, country, and a free-text answer about what's stopped them before) and receive exactly 5 second-income ideas genuinely matched to that intake - not a generic list - each grounded in a sourced baseline rate and real current demand/trend evidence, with a rationale citing at least 3 intake fields, structured time/cost/risk info, and a translated growth note. Users curate that list by selecting one to pursue, bookmarking the rest, rejecting ones they don't want, and requesting further batches without repeating what they've already triaged. Generation speed may optionally be optimized later without weakening any quality check. This is the first capability-specific epic built on Epic 1's foundation (auth, agent loop, moderation, Postgres, i18n, themed chat shell) and the input every later epic (planning, check-ins, settings) depends on.

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (optional - built only if time remains, never blocks the demo)

## Requirements & Constraints

- Intake captures skills/interests (free text), time/budget/risk (preselected ranges), country, and a free-text "what's stopped you before" answer, classified into exactly one of five known failure patterns: overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes. This classification exists for later plan generation (Epic 3) to size/sequence steps - not used inside Epic 2 itself.
- An existing intake is shown prefilled on revisit, never a blank form or a chat transcript.
- Idea generation always produces exactly 5 ideas; each rationale cites at least 3 different intake fields and includes structured weekly time, startup cost, risk level, a sourced baseline-rate citation, and demand/trend evidence (with source URL) plus a translated "how this can grow" note; no idea may exceed the user's stated time, budget, or risk level; two intakes differing in at least 2 fields must yield different idea sets; where limits allow, a batch includes higher-ceiling ideas.
- A batch's evidence must span at least 3 distinct source domains and is not limited to freelance-rate pages. A source must describe the same activity/occupation as the idea (checked deterministically against the quoted passage) or the card shows it as unverified. Login-walled salary sites that mask figures by region are never used as a source. A source from another region is labeled as such on the card and never presented as a local rate. An idea without sourced evidence is retried, not shown.
- Selecting an idea marks it `selected`, the other 4 default to `bookmarked` (never discarded); rejecting a bookmarked idea hides it from the visible list permanently (server-persisted, not client-side).
- "Generate more" produces a further 5 under the same rules, never repeating anything already bookmarked or rejected; "Generate new ideas" after an intake change replaces the current `suggested` batch under the same rules while keeping already-bookmarked/rejected ideas.
- All user input/output in this epic passes through moderation; `web_search` results (baseline-rate and discovery lookups) are moderation-screened before being cached or used.
- This epic's idea-generation tool is the first to need a `web_search` provider credential - add the placeholder to `.env.example` and the startup check in `src/config/env.ts`; the completion report states which key the user must fill in.
- (Optional, Story 2.6) Generation latency may be reduced, but only by removing waiting - never fewer searches/results, weaker moderation, weaker validation, or fewer retries; any reused cached result is never shared across users, is invalidated by a changed intake, and must already have passed moderation.

## Technical Decisions

- Tool boundary: `generate_ideas` is LLM-backed - one tool invocation doing a nondeterministic LLM call then a deterministic Zod-validated Postgres write (never a separate LLM call for the write). `submit_intake` and `set_idea_status` are plain-code, deterministic, directly read/write Postgres - never an LLM decision. A validation failure against the shared Zod schema is retried or surfaced as an error, never silently saved as a draft.
- `submit_intake`'s `failurePattern` argument is classified by the top-level agent as part of its own normal reasoning when constructing the call - this is not a third LLM-backed tool.
- `web_search` is the one MCP tool (via `@langchain/mcp-adapters`), used only by `generate_ideas` - for both the baseline income rate and the discovery search for current trends/demand signals; it is never called by projection logic. It gets a short-TTL cache at the LangGraph node level; moderation must finish screening a result before it is ever written to that cache. The discovery step reuses this same provider key (no new external service, no new variable) and stays inside the ideas path's existing timeout, with Story 1.5's progress feedback covering it.
- The sourced baseline rate and demand evidence (value/note + citation) are persisted once on the idea's record at generation time and are never re-fetched or recomputed later in that idea/plan's lifetime.
- Money handling (first introduced here, reused by later Stories 4.4, 5.2, 5.5): amounts are integer minor units plus an ISO currency code, never a float; conversion uses one configured EUR/USD rate with an as-of date (no live FX call); any converted amount is labeled an estimate; formatting uses `Intl.NumberFormat` with locale driven by active UI language. Build this as one shared money helper, not per-story logic. The currency read here comes from the `user_settings` row already created in Story 1.2 (EUR default) - this epic has no dependency on Epic 5's currency-switch UI existing yet.
- The growth note renders in the user's reply language (chat reply-language matching, not the UI-language setting), consistent with how the rest of the agent's output is language-matched.
- Country is a new intake field extending Story 2.1's form/table; it drives which country's sources are preferred for rates/evidence. Adding it and the demand-evidence fields to `ideas` needs a column or JSON field, no new table, and both are validated against the shared Zod schema before saving.
- Idea lifecycle: `suggested` -> `selected` | `bookmarked` | `rejected`. Rejected ideas disappear from the visible list but the row persists (status change only, not a delete).
- Shared Zod schemas (one location, backend+frontend) define `failurePattern` and `ideaStatus` enums; DB enum/check-constraint representations must stay in lockstep with them, never hand-copied.
- Thread topology: intake and all idea discussion before any plan exists happens in exactly one discovery thread per user - distinct from, and never blended with, the per-plan thread Epic 3 introduces.
- Any Story 2.6 speed-up only removes waiting (e.g. a small internal fast helper model for query planning, or reusing moderated/cached search results) and must report measured before/after timing plus which Story 2.2/2.5 quality checks still pass unchanged.

## UX & Interaction Patterns

Screens build on Epic 1's established shell (light-default theme with dark toggle, shadcn-glass-ui glass style, teal accent, verified 4.5:1 contrast) - no new visual-system decisions are needed in this epic. Intake is a visible structured form with standard fields (not conversational). Ideas render as a card layout: each of the 5 cards shows its rationale, sourced baseline-rate citation, and demand/trend evidence with source URL directly on the card - never behind a detail view. Select/bookmark/reject actions live directly on each card, never behind a separate menu or screen.

## Cross-Story Dependencies

- Story 2.2 cannot run until Story 2.1's intake exists; it reads intake fields directly.
- Story 2.3's status changes (bookmarked/rejected) constrain Story 2.4's exclusion set when generating further batches.
- Story 2.5 extends Story 2.2's `generate_ideas` and Story 2.1's intake/`ideas` schema (adds country field, demand-evidence fields) rather than introducing a new tool or table.
- Story 2.6 (optional) measures and optimizes the generation path Stories 2.2 and 2.5 already built; it must not run, or ship, before they exist, and never blocks the demo.
- The shared money helper and the sourced-rate persistence pattern built in Story 2.2 are reused as-is by Epic 4 (Story 4.4) and Epic 5 (Stories 5.2, 5.5) - don't reimplement elsewhere.
- Epic 3's plan creation depends on an idea already being `selected` here, and on the persisted `failurePattern` from Story 2.1 to size/sequence plan steps.
