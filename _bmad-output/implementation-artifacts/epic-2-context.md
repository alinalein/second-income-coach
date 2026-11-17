# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete a short intake (skills, time, budget, risk tolerance, what's stopped them before) and receive 5 second-income ideas genuinely matched to their own situation — not a generic list — each grounded in a sourced baseline rate and current demand evidence, with a short growth path. Users curate the batch by selecting, bookmarking, or rejecting ideas, can request further batches, and are guided step by step from intake through idea selection into plan creation (Epic 3).

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (optional; only if time remains, never blocks the demo)
- Story 2.7: Translate Idea Cards on Language Change
- Story 2.8: Guided Flow from Intake to Plan

## Requirements & Constraints

- Intake fields: skills/interests (free text), time/budget/risk (preselected ranges), "what's stopped you before" (free text), plus a country field (added in 2.5). Revisiting a submitted intake always shows saved values prefilled, never a blank form.
- Idea generation always produces exactly 5 ideas; each must cite at least 3 distinct intake fields in its rationale and carry structured weekly time, startup cost, and risk level; none may exceed the user's stated time, budget, or risk limit.
- Each idea needs a grounded baseline income rate (via web search, never guessed) and current demand/trend evidence with a source URL from at least 3 distinct source domains per batch — an idea without sourced evidence is retried, never shown. Evidence must describe the same activity/occupation as the idea; otherwise the card shows it as unverified.
- Baseline rates and demand evidence should prefer sources from the user's country; out-of-region sources are labeled as such, and a figure in another currency is never presented as local.
- Idea statuses: `suggested` → `selected` | `bookmarked` | `rejected`. Selecting one marks it `selected` and the rest `bookmarked`; rejecting hides it (persisted); these status changes are plain deterministic writes, never LLM-decided.
- "Generate new ideas" replaces the current `suggested` batch (keeping bookmarked/rejected); "more ideas" (2.4) adds a further 5 without repeating anything already bookmarked or rejected.
- Money is always integer minor units + ISO currency code, never a float; displayed in the user's configured currency (EUR default), converted and labeled an estimate when a conversion occurs. The money helper built here (minor units, conversion, `Intl.NumberFormat`) is reused by later stories (4.4, 5.2, 5.5) rather than reimplemented.
- All generated/structured output is validated against shared Zod schemas before any write; a validation failure is never silently saved.
- Idea cards must translate into the active UI language on demand (title, rationale, demand note, growth path, caveat) without re-searching or changing any number/currency/source/URL/citation/trust label; source quotes stay in their original language. Translation is one batched model call per language, persisted per idea+language, moderation-screened.
- The guided flow (2.8) auto-starts idea generation right after first intake submission (no extra click); returning users with ideas go straight to them. Selecting an idea requires a confirmation dialog before status changes and a plan is lazily created; only the selected idea's card ever links to a plan.

## Technical Decisions

- One LLM-backed tool, `generate_ideas` (nondeterministic generation + deterministic Postgres write inside the same tool call); `set_idea_status` is plain-code (deterministic Postgres update, no LLM call).
- `web_search` (MCP, via `@langchain/mcp-adapters`) is used only by `generate_ideas` — for baseline rate sourcing and the discovery/demand-trend search — never by projection or other tools. Results are moderation-screened (Mistral Moderation 2, `wrapToolCall` hook) before being cached or used; the cache (short-TTL `CachePolicy` at the node level) only ever holds already-moderated content.
- The sourced baseline rate (value + citation) is persisted once on the idea's record at generation time and never re-fetched or recomputed later.
- Intake and idea/plan hard state live in dedicated Postgres tables, read/written directly by tools — never reconstructed from the LangGraph checkpointer or semantic memory, and never cached as graph state across turns.
- Intake and idea discussion before any plan exists happens in exactly one discovery thread per user (derived from the authenticated session) — distinct from the per-plan thread created later in Epic 3.
- Shared Zod schemas (one location, `z.infer` for types) define `failurePattern`, `ideaStatus`, and other enums; Postgres enum/check constraints are generated from, or kept in lockstep with, the same definitions.
- Idea generation's progress display uses real agent-loop step/tool-call boundaries mapped to fixed, enumerated status labels over SSE (never the model's own text, never raw internal tool/hook names) — each tool-introducing story here registers its own label key.
- This epic introduces the `web_search` provider credential: add it to `.env.example` as a placeholder and to the startup check in `src/config/env.ts` (Story 2.2); report which key the user must fill in.

## UX & Interaction Patterns

- Intake is a visible structured form with standard fields — not a conversational/chat intake — and prefills from saved data on revisit.
- Ideas render as a 5-card grid; each card shows its rationale, structured time/cost/risk, baseline-rate citation, demand/trend evidence with source URL, and growth-path note directly on the card — never behind a detail view or expansion.
- Select/bookmark/reject actions live directly on each idea card, never behind a separate menu or screen.
- Under the ideas heading, a short localized explanation tells the user what to do next (choose, reject, or generate more); this space is never left as a blank reserved band.
- Pressing "Select" opens a confirmation dialog stating the idea becomes the chosen one and the rest remain as bookmarks; only confirming changes status and (lazily) creates the plan.
- During translation or generation, cards show a localized loading state (no mixed-language flash); on translation failure, cards stay in their last stored language with a neutral notice and retry, never blank.

## Cross-Story Dependencies

- Depends on Story 1.2's `user_settings` row (currency default) for displaying idea startup costs, though not on Story 5.5's currency-switch UI existing yet.
- Depends on Story 1.5's progress-display pattern, which this epic's tools extend with their own status labels.
- Story 2.5 extends Story 2.1's intake form/table (adds country) and Story 2.2's `ideas` schema (adds evidence fields via a column/JSON field, no new table) and reuses Story 2.2's `web_search` key and AD-7 cache.
- Story 2.7 depends on Story 5.4 (UI language switch) and reuses AD-25's reply-language rule for chat-triggered generation.
- Story 2.8 hands off into Story 3.1 (draft plan generation, created lazily on confirmed idea selection) and explicitly leaves Story 3.2 (plan activation) and Story 3.3 (switching plans) unchanged, reusing this story's select-and-confirm dialog.
- Story 2.6 (optional) only touches latency of the existing 2.2/2.5 generation path and must not weaken any of their quality checks.
