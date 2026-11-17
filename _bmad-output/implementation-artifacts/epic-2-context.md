# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete a structured intake (skills/interests, available time, budget, risk tolerance, country, and a free-text answer about what's stopped them before) and receive exactly 5 second-income ideas genuinely matched to that intake and grounded in real, current demand - not a generic or guessed list. Each idea carries a rationale citing at least 3 intake fields, structured time/cost/risk info, a sourced baseline income rate, and sourced demand/trend evidence with a "how this can grow" note. Users curate the list by selecting one to pursue, bookmarking the rest, rejecting ones they don't want, and requesting further batches without repeating what they've already triaged. An optional, time-boxed story may later speed up generation without weakening any of these guarantees. This is the first capability-specific epic built on Epic 1's foundation (auth, agent loop, moderation, Postgres, i18n, themed chat shell) and the input every later epic (planning, check-ins, settings) depends on.

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (optional)

## Requirements & Constraints

- Intake captures skills/interests (free text), time/budget/risk (preselected ranges), a country field, and a free-text "what's stopped you before" answer, classified into exactly one of five known failure patterns: overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes. This classification exists to let later plan generation (Epic 3) size and sequence steps against the user's specific failure mode - not used for anything inside Epic 2 itself.
- An existing intake is shown prefilled on revisit, never a blank form or a chat transcript.
- Idea generation always produces exactly 5 ideas; each rationale must cite at least 3 different intake fields and include structured weekly time, startup cost, and risk level; no idea may exceed the user's stated time, budget, or risk level; two intakes differing in at least 2 fields must yield different idea sets.
- Each idea also carries a demand/trend evidence note with its source URL and a short translated "how this can grow" note; evidence must come from at least 3 distinct source domains per batch and is never invented - an idea without sourced evidence is retried, not shown. Where the user's limits allow it, a batch includes some higher-earning-ceiling ideas.
- Baseline rates and demand evidence are sourced for the user's stated country when available; a source from another region is labeled as such on the card, and a figure in another currency region is never presented as a local rate. A source must describe the same activity/occupation as the idea (checked deterministically against the quoted passage) or the card shows it as unverified; login-walled salary sites that mask figures by region are never used.
- Selecting an idea marks it `selected` and the other 4 default to `bookmarked` (never discarded); rejecting a bookmarked idea hides it from the visible list permanently (server-persisted, not client-side).
- "Generate more" produces a further 5 under the same rules (including the evidence/growth-note rules), never repeating anything already bookmarked or rejected.
- All user input/output in this epic passes through moderation; nothing here overrides that.
- This epic's idea-generation tool is the first to need a `web_search` provider credential - add the placeholder to `.env.example` and the startup check in `src/config/env.ts`, and state in the completion report which key the user must fill in. The later discovery step (demand/trend search) reuses this same key and cache - no new external service or variable.
- The optional speed-up story (2.6) is scheduled only if time remains after every required story and never blocks the live demo; it must not reduce searches/results/moderation/validation/retries - only remove waiting - and must report honest before/after timing against a ~25s target for a normal run.

## Technical Decisions

- Tool boundary: `generate_ideas` is LLM-backed (one tool invocation internally doing a nondeterministic LLM call then a deterministic Zod-validated Postgres write - never a separate LLM call for the write). `submit_intake` and `set_idea_status` are plain-code, deterministic, directly read/write Postgres - never an LLM decision. A validation failure against the shared Zod schema is retried or surfaced as an error, never silently saved as a draft.
- `submit_intake`'s `failurePattern` argument is classified by the top-level agent as part of its own normal reasoning when constructing the call - this is not a third LLM-backed tool.
- `web_search` is the one MCP tool (via `@langchain/mcp-adapters`), used only by `generate_ideas` - both to source a baseline income rate and to run the demand/trend discovery search - never called by projection logic. It gets a short-TTL cache at the LangGraph node level; moderation must finish screening a search result before it is ever written to that cache.
- The sourced baseline rate (value + citation) and the sourced demand/trend evidence (note + source URL) are persisted once on the idea's record at generation time and are never re-fetched or recomputed later in that idea/plan's lifetime. The evidence/growth-note/country fields extend the existing `ideas` table via a column or JSON field - no new table.
- Money handling (first introduced here, reused by later stories 4.4, 5.2, 5.5): amounts are integer minor units plus an ISO currency code, never a float; conversion uses one configured EUR/USD rate with an as-of date (no live FX call); any converted amount is labeled an estimate; formatting uses `Intl.NumberFormat` with locale driven by active UI language. Build this as one shared money helper, not per-story logic. The currency read here comes from the `user_settings` row already created in Story 1.2 (EUR default) - this epic has no dependency on Epic 5's currency-switch UI existing yet.
- Idea lifecycle: `suggested` -> `selected` | `bookmarked` | `rejected`. Rejected ideas disappear from the visible list but the row persists (status change only, not a delete).
- Shared Zod schemas (one location, backend+frontend) define `failurePattern` and `ideaStatus` enums; DB enum/check-constraint representations must stay in lockstep with them, never hand-copied. New Story 2.5 fields go through the same schema validation before save.
- Thread topology: intake and all idea discussion before any plan exists happens in exactly one discovery thread per user - distinct from, and never blended with, the per-plan thread Epic 3 introduces.
- Story 2.6 (if built): measure the real run first (query planning, each search, moderation, writing call, validation, DB write) before changing anything; approved speed-up levers are a small fast helper model (internal only, never user-selectable) for query planning, or reusing already-moderated cached search results - cache reuse is never shared across users, is invalidated by a changed intake, and only ever serves content that already passed moderation.

## UX & Interaction Patterns

Screens build on Epic 1's established shell (light-default theme with dark toggle, shadcn-glass-ui glass style, teal accent, verified 4.5:1 contrast) - no new visual-system decisions are needed in this epic. Two layout decisions are final for this epic: the intake is a visible structured form (not a conversational flow), and the ideas list is a 5-card grid layout, with select/bookmark/reject actions and the rationale, baseline-rate citation, and demand/trend evidence all shown directly on each card - never behind a separate menu, detail view, or expansion.

## Cross-Story Dependencies

- Story 2.2 cannot run until Story 2.1's intake exists; it reads intake fields directly.
- Story 2.3's status changes (bookmarked/rejected) constrain Story 2.4's exclusion set when generating further batches.
- Story 2.5 extends Story 2.2's `generate_ideas` and the `ideas` table in place; Story 2.4's "more ideas" batches must also satisfy Story 2.5's evidence/growth-note rules once it's built.
- Story 2.6 (optional) instruments and speeds up the exact path built by Stories 2.2 and 2.5; it must not weaken any of their quality checks and is reported against, not substituted for, them.
- The shared money helper and the sourced-rate persistence pattern built in Story 2.2 are reused as-is by Epic 4 (Story 4.4) and Epic 5 (Stories 5.2, 5.5) - don't reimplement elsewhere.
- Epic 3's plan creation depends on an idea already being `selected` here, and on the persisted `failurePattern` from Story 2.1 to size/sequence plan steps.
