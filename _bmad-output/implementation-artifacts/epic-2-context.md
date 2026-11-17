# Epic 2 Context: Tailored Idea Discovery

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users complete an intake and receive 3 second-income ideas matched to their own skills, time, budget, and risk tolerance - not a generic list - and can curate that list by bookmarking or rejecting ideas. The ideas must be genuinely differentiated by the user's inputs, grounded in real market/demand data rather than guessed, and presented in a way that guides the user from intake through to a chosen idea without dead ends or extra clicks.

## Stories

- Story 2.1: Structured Intake with Failure-Pattern Classification
- Story 2.2: Tailored Idea Generation
- Story 2.3: Bookmark and Reject Ideas
- Story 2.4: Generate More Ideas
- Story 2.5: Opportunity Discovery & Growth Path
- Story 2.6: Faster Idea Generation (optional, demo-only, never blocks the demo)
- Story 2.7: Translate Idea Cards on Language Change
- Story 2.8: Guided Flow from Intake to Plan
- Story 2.9: App Navigation Sidebar
- Story 2.10: Direct Paths for Button-Triggered Flows (required; must be built before 2.9, 3.3, and Epic 4)

## Requirements & Constraints

- Intake captures skills, interests, available time, risk tolerance, starting budget, and a free-text "what's stopped you before" answer, classified into exactly one of five failure patterns (overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes) and persisted with the rest of the intake. Invalid/missing data is rejected by schema before any write. A returning user sees their saved intake prefilled, never a blank form.
- Idea generation always produces exactly 3 ideas per batch (the fixed batch-size constant, used everywhere). Each idea's rationale cites at least 3 different intake fields and includes structured weekly time, startup cost, and risk level. No idea may exceed the user's stated time, budget, or risk. Two intakes differing in at least two fields must yield different idea sets.
- "Generate more ideas" adds a further batch of 3 to the existing set, never repeating or removing anything already suggested, bookmarked, or rejected.
- Selecting an idea marks it `selected` and the rest default to `bookmarked`; rejecting a bookmarked idea hides it permanently (persisted, not client-side). Status changes are deterministic, no LLM involved.
- Each idea's baseline income rate must come from a grounded web search (never guessed), moderation-screened before caching/use, persisted on the idea record with its source/citation, and never re-fetched later. Each idea also needs a demand/trend evidence note with a source URL, sourced from at least 3 distinct source domains per batch; an idea without sourced evidence is retried, not shown. Evidence and rate sources must describe the same activity/occupation as the idea (checked deterministically) or the card shows it as unverified.
- Country affects sourcing: the intake gains a country field, rates/evidence prefer country-specific sources, a source from another region is labeled as such, and a figure in another currency is never presented as local.
- Idea cards must re-render in the user's current UI language when it changes, without a new search and without altering any number, currency, source, URL, citation, or trust label; source quotes stay in their original language. Translation is one batched call per language switch, cached per idea+language, moderated, with a localized loading state and a non-blocking failure fallback.
- The guided flow auto-starts idea generation right after first intake submission (no extra click); a returning user with ideas goes straight to them. Selecting an idea requires an explicit confirmation dialog before the idea's status changes and its plan is (lazily) created; only the selected idea's card ever links to a plan.
- Performance: button-triggered flows (intake save, idea generation, plan creation) must feel fast and avoid needless waiting/cost. Targets: intake "saved" within 1s, failure-pattern classification within ~3s, idea generation within ~45s for a batch of 3. Misses must be reported honestly, never hidden by raising timeouts.
- Money/currency: idea startup costs are stored as integer minor-unit amounts with their sourced currency code (never floats), displayed via the user's configured currency setting (default EUR) with conversion labeled as an estimate when applied.
- This epic introduces the `web_search` provider credential (Story 2.2): add the placeholder to `.env.example` and the startup check in `src/config/env.ts`; the story's report must list which key the user must fill in.

## Technical Decisions

- **Tool boundary (AD-4), amended for speed (2026-11-17), directly relevant to Story 2.10:** UI button flows - intake save, idea generation, plan creation - call their tool handlers directly from the API route, with no agent loop wrapped around them. The full agent loop (moderate → model decides → tool → model narrates → moderate) is reserved for free-form chat turns, which still call the identical tools, so tool-calling behavior and the Story 6.2 evals are unaffected. Intake's free-text classification into `failurePattern` becomes one direct structured-output call to a fast internal model (never user-selectable), run in parallel with a single AD-11 moderation pass on that text; saving the rest of the intake never waits on either. Server-authored trigger text is never moderated; all user-written text still is.
- `generate_ideas` and `create_plan` remain LLM-backed tools, each a single invocation with two internal sub-steps (nondeterministic LLM call, then a deterministic Postgres write of the validated output) performed by the same function - no separate plain-code persistence tool. `set_idea_status` is plain-code (deterministic Postgres update, no LLM). Output must pass the shared Zod schema (AD-16) before the write; a validation failure is retried or surfaced as an error, never saved malformed.
- **AD-11 (moderation):** three hook points - `beforeModel` on user input (jailbreak → reject; PII → redact), `wrapToolCall` around `web_search` (strip flagged portions of search results before they re-enter model context or any cache), `afterModel` on the final response (reject + regenerate on trigger). Story 2.10's direct-handler calls still must run the applicable moderation steps even without the full agent loop around them (e.g. the parallel moderation of the free-text intake answer).
- **AD-12 (guilt-language check)** is scoped to CAP-4 (check-ins) only - not relevant to Epic 2's idea-generation flows, but Story 2.10 calls it out explicitly as still applying wherever it binds, to avoid speed changes accidentally weakening it.
- **AD-7 (resilience fabric):** retries/timeouts/caching live at the LangGraph node level via `setNodeDefaults`, never duplicated in middleware. `generate_ideas`/`create_plan` get longer timeouts and no caching (personalized per user); `web_search` gets a short-TTL cache - but only ever caches already-moderated content, never raw results.
- **AD-6:** the baseline income rate sourced via `web_search` at generation time is persisted (value + citation) on the idea record and never re-fetched or recomputed later.
- **AD-13 (lifecycle statuses):** idea status flow is `suggested` → `selected` | `bookmarked` | `rejected`; rejected ideas leave the visible list, bookmarked ones stay available to activate later. `create_plan` runs lazily, only on first selection (or re-selection of a bookmarked idea with no plan yet) - never eagerly for all ideas at generation time.
- **AD-16:** shared Zod schemas (single location, `z.infer` types) define `failurePattern` and `ideaStatus`; the DB's enum/constraint representation is generated from or kept in lockstep with them.
- **AD-18 (thread topology):** exactly one discovery thread per user covers intake and idea discussion (CAP-1/CAP-2) before any plan exists - never a plan-specific thread, and never shared across users.
- **AD-25:** when idea generation is triggered from a button click, ideas are written in the current UI language (a click is not a "written message"); chat-triggered generation instead follows the language the user wrote in.
- **AD-27 (currency):** money is integer minor units + ISO currency code, never float; conversion uses one configured EUR/USD rate with an as-of date, no live FX call, and every converted figure is labeled an estimate. The shared money helper is created in Story 2.2 and reused by later stories (4.4, 5.2, 5.5) rather than reimplemented.
- **AD-31 (progress display):** each tool-introducing story in this epic registers its own fixed step-to-label key (both DE and EN) in the step-to-label registry: an unmapped tool falls back to one generic label, never a blank state or raw tool name.
- **AD-5/MCP scope:** `web_search` is used only by `generate_ideas` (including the discovery-search step added by Story 2.5); it is not called by plan, check-in, or projection logic.

## UX & Interaction Patterns

- Intake UI is a visible structured form with standard fields (final layout decision) - not a conversational/chat intake. Idea cards use a card layout (final decision), with rationale and the sourced baseline-rate citation shown directly on the card, never behind a detail view. Select/bookmark/reject actions live directly on each card, never behind a separate menu or screen.
- Demand/trend evidence and its source URL, plus a short translated "how this can grow" note, are shown directly on each card alongside the rate citation.
- Under the ideas heading, a short localized explanation tells the user what to do next (choose, reject, or generate more); this space shows that text or nothing - never a blank reserved band.
- Selecting an idea opens a confirmation dialog explaining that it becomes the chosen idea and the rest remain bookmarks; only confirming changes status and (lazily) creates the plan, which then opens the plan workspace with its chat. Cancel changes nothing.
- A left sidebar (Story 2.9) lists the product name, "New ideas," "My plans," "Bookmarked," and a profile entry (Settings/theme/sign-out); it collapses to an overlay menu on narrow screens, with the active view/plan persisted across reloads.
- No waiting hints (e.g. "this can take up to half a minute") appear anywhere in the intake flow; only the standard real-step progress display is shown for any remaining wait.

## Cross-Story Dependencies

- Story 2.10 is scheduled before Stories 2.9 and 3.3 and before Epic 4, because it changes how every later flow's routes are wired (direct handler calls vs. agent loop).
- Story 2.10 requires all existing acceptance criteria of Stories 2.1, 2.2, 2.5, and 3.1 to keep passing unchanged after the routes are rewired to direct handler calls.
- Story 2.2 creates the shared money helper that Stories 4.4, 5.2, and 5.5 reuse; it also introduces the `user_settings`-driven currency display that Story 5.5 later adds a UI control for (this story doesn't depend on that control existing).
- Story 2.4's "more ideas" batching behavior is implemented as part of Story 2.2's generation rules but exercised/extended by Story 2.5's discovery step.
- Story 2.5 extends Story 2.1's intake form/table with a country field and extends `ideas` with new columns/JSON fields (no new table).
- Story 2.7's translation applies to cards produced by Stories 2.2/2.5 and must not alter any value those stories persisted (numbers, currency, source, URL, citation, trust label).
- Story 2.8 depends on Story 2.3 (status-change behavior) and Story 3.1 (plan generation, invoked lazily on confirm); it leaves Stories 3.2 and 3.3's own confirmation/switching behavior unchanged.
- Story 2.9's "Bookmarked" and "My plans" lists reuse Story 2.8's select-and-confirm dialog and Story 3.1/3.3's lazy plan creation/switching - the 3.2 activation gate is never bypassed.
- Story 2.6 is optional and demo-scoped: it may reduce latency further but must never reduce search count/results, moderation strength, validation, or retry behavior, and never blocks the live demo.
