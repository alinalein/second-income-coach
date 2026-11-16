# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete a structured intake (skills/interests, available time, budget, risk tolerance, and a free-text answer about what's stopped them before) and receive exactly 5 second-income ideas genuinely matched to that intake - not a generic list - each with a rationale citing at least 3 intake fields and structured time/cost/risk info. Users then curate that list by selecting one to pursue, bookmarking the rest, rejecting ones they don't want, and requesting further batches without repeating what they've already triaged. This is the first capability-specific epic built on Epic 1's foundation (auth, agent loop, moderation, Postgres, i18n, themed chat shell) and the input every later epic (planning, check-ins, settings) depends on.

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas

## Requirements & Constraints

- Intake captures skills/interests (free text), time/budget/risk (preselected ranges), and a free-text "what's stopped you before" answer, classified into exactly one of five known failure patterns: overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes. This classification exists to let later plan generation (Epic 3) size and sequence steps against the user's specific failure mode - not used for anything inside Epic 2 itself.
- An existing intake is shown prefilled on revisit, never a blank form or a chat transcript.
- Idea generation always produces exactly 5 ideas; each rationale must cite at least 3 different intake fields and include structured weekly time, startup cost, and risk level; no idea may exceed the user's stated time, budget, or risk level; two intakes differing in at least 2 fields must yield different idea sets.
- Selecting an idea marks it `selected` and the other 4 default to `bookmarked` (never discarded); rejecting a bookmarked idea hides it from the visible list permanently (server-persisted, not client-side).
- "Generate more" produces a further 5 under the same rules, never repeating anything already bookmarked or rejected.
- All user input/output in this epic passes through moderation; nothing here overrides that.
- This epic's idea-generation tool is the first to need a `web_search` provider credential - add the placeholder to `.env.example` and the startup check in `src/config/env.ts`, and state in the completion report which key the user must fill in.

## Technical Decisions

- Tool boundary: `generate_ideas` is LLM-backed (one tool invocation internally doing a nondeterministic LLM call then a deterministic Zod-validated Postgres write - never a separate LLM call for the write). `submit_intake` and `set_idea_status` are plain-code, deterministic, directly read/write Postgres - never an LLM decision. A validation failure against the shared Zod schema is retried or surfaced as an error, never silently saved as a draft.
- `submit_intake`'s `failurePattern` argument is classified by the top-level agent as part of its own normal reasoning when constructing the call - this is not a third LLM-backed tool.
- `web_search` is the one MCP tool (via `@langchain/mcp-adapters`), used only by `generate_ideas` to source a baseline income rate; it is never called by projection logic. It gets a short-TTL cache at the LangGraph node level; moderation must finish screening a search result before it is ever written to that cache.
- The sourced baseline rate (value + citation) is persisted once on the idea's record at generation time and is never re-fetched or recomputed later in that idea/plan's lifetime.
- Money handling (first introduced here, reused by later stories 4.4, 5.2, 5.5): amounts are integer minor units plus an ISO currency code, never a float; conversion uses one configured EUR/USD rate with an as-of date (no live FX call); any converted amount is labeled an estimate; formatting uses `Intl.NumberFormat` with locale driven by active UI language. Build this as one shared money helper, not per-story logic. The currency read here comes from the `user_settings` row already created in Story 1.2 (EUR default) - this epic has no dependency on Epic 5's currency-switch UI existing yet.
- Idea lifecycle: `suggested` -> `selected` | `bookmarked` | `rejected`. Rejected ideas disappear from the visible list but the row persists (status change only, not a delete).
- Shared Zod schemas (one location, backend+frontend) define `failurePattern` and `ideaStatus` enums; DB enum/check-constraint representations must stay in lockstep with them, never hand-copied.
- Thread topology: intake and all idea discussion before any plan exists happens in exactly one discovery thread per user - distinct from, and never blended with, the per-plan thread Epic 3 introduces.

## UX & Interaction Patterns

Screens build on Epic 1's established shell (light-default theme with dark toggle, shadcn-glass-ui glass style, teal accent, verified 4.5:1 contrast) - no new visual-system decisions are needed in this epic, only new screens using it.

## Cross-Story Dependencies

- Story 2.2 cannot run until Story 2.1's intake exists; it reads intake fields directly.
- Story 2.3's status changes (bookmarked/rejected) constrain Story 2.4's exclusion set when generating further batches.
- The shared money helper and the sourced-rate persistence pattern built in Story 2.2 are reused as-is by Epic 4 (Story 4.4) and Epic 5 (Stories 5.2, 5.5) - don't reimplement elsewhere.
- Epic 3's plan creation depends on an idea already being `selected` here, and on the persisted `failurePattern` from Story 2.1 to size/sequence plan steps.
