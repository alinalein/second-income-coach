---
status: final
stepsCompleted: [1, 2, 3, 4]
inputDocumentsNote: SPEC.md/stack.md/evals.md/ARCHITECTURE-SPINE.md amended post-Epic-6/7 approval - see their memlogs
inputDocuments: [_bmad-output/specs/spec-second-income-coach/SPEC.md, _bmad-output/specs/spec-second-income-coach/stack.md, _bmad-output/specs/spec-second-income-coach/engagement-mechanics.md, _bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md]
---

# Second Income Coach - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Second Income Coach, decomposing the requirements from SPEC.md (+ companions) and ARCHITECTURE-SPINE.md into implementable stories. No UX design contract exists (not run for this project) - visual design is not a fixed requirement here.

## Requirements Inventory

### Functional Requirements

FR1: User can complete a structured intake capturing skills, interests, available time, risk tolerance, and starting budget, plus a free-text answer about what has stopped them from starting/following through before; that free-text answer is classified into one of five known failure patterns (overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes) and persisted alongside the rest of the intake.

FR2: System generates exactly 5 tailored second-income ideas from a completed intake. Each idea includes a rationale citing at least 3 different intake fields and structured info on weekly time required, startup cost, and risk level. No idea exceeds the user's stated time/budget/risk; two intakes differing in at least two fields yield different idea sets.

FR3: User can select one of the 5 ideas to work on; the other 4 are retained as "bookmarked" (not discarded); the user can mark any idea "rejected," removing it from the visible list.

FR4: Once an idea is selected, the system generates a draft plan of small concrete steps with an estimated timeline, sized and sequenced according to the user's classified failure pattern. Only the current and immediate-next step are visible at any time.

FR5: A generated draft plan requires explicit human confirmation before becoming active (human-in-the-loop). Confirming activates exactly one plan at a time and pauses (never deletes) any previously active plan. Rejecting produces a revised draft incorporating the user's feedback, updating the same plan row rather than creating a new one. The user can later activate a different bookmarked idea's plan - resuming a paused plan rather than regenerating it from scratch.

FR6: User can check in with the agent on an ongoing basis, either by typed text or by voice. Voice check-ins are recorded client-side, transcribed, and shown back as an editable transcript the user confirms/edits before submission; typed text remains an always-available fallback. A lightweight energy/status input precedes any task-related ask.

FR7: A missed check-in is detected lazily, the next time the app is opened (comparing expected vs. actual last check-in date). It triggers an automatic, non-punitive timeline recalculation and a neutral re-entry message - never shame or streak-break language.

FR8: Starting a step and completing a step each produce their own distinct, specific acknowledgment message (not generic praise, and not a single combined message).

FR9: After each completed step or check-in, the user sees an updated income estimate and the concrete next opportunity it unlocks - computed from their actual logged progress and check-in consistency, not fixed at intake and not silently re-fetched/recomputed later.

FR10: User can request "more ideas" for a further batch of 5, never repeating anything already bookmarked or rejected.

FR11: User can set the agent's personality (formal/friendly/terse) and choose which LLM answers from a model registry (id, provider, display name, price per 1M input/output tokens, price_as_of); only providers with a configured server-side key are selectable, and the moderation/transcription models are never user-selectable.

FR12: User sees the token count and an estimated cost beneath every agent response, summed across every model call in that turn, persisted per message.

FR13: User can rate any agent response (thumbs up/down, optional comment) without that rating ever blocking the chat input; feedback feeds per-user semantic memory and a LangSmith dataset for offline prompt improvement only.

FR14: User can switch the UI language between German and English in Settings; the choice persists in `user_settings` and defaults to English.

FR15: The agent understands and replies in German or English, matching whichever language the user writes (or speaks, for voice) in per message - independent of the UI language setting. All fixed system texts exist in both languages; personality (formal/friendly/terse) renders correctly in both.

FR16: User can set a currency (EUR or USD, default EUR) in Settings, covering both the token/cost display (FR12) and income projections/idea budgets (FR2/FR9). Changing it re-renders every displayed amount in the newly chosen currency; converted amounts are always labeled as estimates.

FR17: A public, unauthenticated "Quality & Decisions" page presents the latest evaluation results, a summary of key architecture decisions (reason + trade-off), and a reflection (known problems, improvement suggestions, when to use prompt engineering vs. RAG vs. agents) - every fact generated from an existing source, never hand-copied. UI chrome is localized; report/decision content stays English, stated on the page. Contains no user data, secrets, or private LangSmith trace links.

### Additional NonFunctional Requirements

NFR7: Eval tooling is TypeScript-only (`agentevals` + Vitest + LangSmith) - no Python eval packages. A trajectory suite (15-25 cases) plus deterministic unit and guardrail tests run against all 4 model-registry entries, with a report script producing a linked markdown/HTML report (tool-call accuracy, constraint-test results, model x accuracy table, run date).

NFR8: Chat topology is one discovery thread per user plus one thread per plan - never a single thread blending pre-plan discovery with plan-specific work.

NFR9: A positive feedback rating (CAP-9) never overrides a hard constraint - the guilt-language check (AD-12) and all moderation (AD-11) still apply regardless of how a response was rated.

### NonFunctional Requirements

NFR1: No streak counters or escalating guilt-based nudges anywhere in the check-in system.

NFR2: Voice is a first-class interaction channel for check-ins, not a bolt-on to a text-only flow.

NFR3: No raw audio is retained beyond what's needed to produce the transcript.

NFR4: All user input and all agent output pass through a moderation check (Mistral Moderation 2) before being processed or shown - mandatory, not optional, with per-category response (reject input/output on jailbreak or unsafe content; clean up/redact on PII; clean up/strip on flagged search results).

NFR5: The "no streak-shaming/guilt language" rule must be mechanically verifiable via a dedicated output check, never left to the model's own judgment, and bounded (capped regeneration attempts with a neutral fallback).

NFR6: The full intake -> idea generation -> initial plan path must run reliably end-to-end live, for a real user's actual constraints, within a live class demo's time window; the check-in loop must demonstrably handle at least one real check-in and one simulated missed check-in live.

### Additional Requirements (from Architecture)

- **No starter/scaffold template** - this is a custom greenfield build (TypeScript 7.0.2, Node 26, Express, React 19.3.1), not based on a starter kit.
- Single LLM agent via LangChain's `createAgent` on the LangGraph.js runtime (`langchain@1.6.5`, `@langchain/core@1.3.6`, `@langchain/langgraph@1.7.3`) - not multi-agent.
- Tool boundary: LLM-backed (`generate_ideas`, `create_plan`, each validating output via Zod before a deterministic Postgres write) vs. plain-code (`submit_intake`, `set_idea_status`, `get_current_step`, `start_step`, `complete_step`, `record_check_in`, `get_projection`, `activate_plan`) vs. one MCP tool (`web_search`, via `@langchain/mcp-adapters`' `MCPAdapter`, used only by `generate_ideas`).
- Persistence: hard/structured state in dedicated Postgres tables (Neon); `@langchain/langgraph-checkpoint-postgres`'s `PostgresSaver` for thread/checkpoint state and `PostgresStore`+pgvector for semantic memory - reserved for conversational context only, never hard facts.
- Resilience: LangGraph node-level `setNodeDefaults` (retry/timeout/`CachePolicy`) as the baseline, not middleware; moderation must complete before any `web_search` result is cached.
- Moderation hooks: Mistral Moderation 2 at `beforeModel` (input), `wrapToolCall` around `web_search` (search results), and `afterModel` (final output) - three distinct hook points, each with its own trigger policy; final adoption of the model itself is pending the user's own eval-set testing.
- Voice sits behind one interface contract so v1 (MediaRecorder -> `gpt-transcribe` -> editable transcript) can be swapped for v2 (`gpt-audio-mini` speech-to-speech, deferred) without touching check-in logic.
- "Exactly one active plan" enforced via a database-level partial unique constraint inside a single transaction, not application-level checks alone.
- Shared Zod schemas (including domain enums `failurePattern`/`ideaStatus`/`planStatus`) in one location imported by backend and frontend; DB enum/check-constraint representations kept in lockstep with them, never hand-copied.
- Auth: Google OAuth (`google-auth-library`) gates the entire session from first use, including intake submission. The session itself is a server-side `HttpOnly`/`Secure`/`SameSite=Lax` cookie, never a bearer token; the built frontend is served from the same Express service (same-origin), with CSRF defended by `SameSite` plus an Origin-header check on state-changing requests (AD-17/AD-30).
- **Web/API security baseline (AD-30)**: Postgres access via Drizzle ORM (parameterized, no raw SQL); `helmet` security headers; `cors` same-origin policy; `express-rate-limit` on every route (stricter on `generate_ideas`/`create_plan`); an Express request-body size limit; a max-length constraint on the shared Zod user-message schema; a log-hygiene rule (no raw user message text in any log); and an ESLint `react/no-danger` rule enforcing React's default escaping against XSS.
- One LangGraph thread per conversation, derived from the authenticated session.
- Standard request/response delivery - no streaming.
- Observability: LangSmith tracing/evals.
- Deployment: local-only first (build + live class demo), then Cloud Run (app) + Neon (Postgres); secrets via local `.env` now, Google Cloud Secret Manager after deploy.
- **Documentation**: a README (setup/usage), documented example use cases, and a written rationale for the key technical decisions (can draw directly from the architecture spine's ADs and the spec/architecture memlogs rather than re-deriving reasoning from scratch).
- **Internationalization**: `react-i18next`, translation keys under `src/locales/<language-code>/<namespace>.json`, established from Story 1.1 onward - no hardcoded user-facing string in either language. German and English are the only two supported languages for both the UI and the chat.

**Deferred items (from the architecture spine) and where they land:** exact Postgres schema column-level detail, exact preselected intake range boundaries, exact retry/backoff/timeout numbers, the voice interface's exact method signature, the audio-retention deletion endpoint, and the step-pointer semantics in the start/complete gap window are all implementation-level decisions to make *while building the story that owns them* - they'll be called out on the relevant story below, not as separate tickets. **Out of scope for this epic breakdown entirely** (v2/non-goals, no ticket anywhere): v2 voice (`gpt-audio-mini`), the gamified visual/plant companion, and background-job missed-check-in detection with push/email notifications.

### UX Design Requirements

No formal UX design contract exists for this project, but the user specified these UI requirements directly:

UX-DR1: Light mode is the default theme.

UX-DR2: Dark mode is available via a toggle; the user's choice is persisted/remembered across sessions.

UX-DR3: Visual style uses shadcn/ui with shadcn-glass-ui (a glass/frosted-glass aesthetic).

UX-DR4: Text contrast meets at least 4.5:1 (WCAG AA for normal text) in both light and dark themes.

### FR Coverage Map

(see the Epic List section below, which contains the full coverage map)

## Epic List

### Epic 1: Sign In & First Contact
Users can sign in with Google and exchange at least one safe, moderated message with the agent - the thinnest possible end-to-end slice proving the whole stack (auth, agent loop, Postgres, moderation, resilience, Zod schemas, LangSmith, and the themed UI shell) actually works together before any capability-specific feature is built on top of it. This epic establishes the UI foundation every later epic's screens build on: shadcn/ui + shadcn-glass-ui, a theme provider defaulting to light mode with a dark-mode toggle (choice persisted), a glass visual style, a teal accent scheme (chosen final, after an emerald/teal/amber/ocean contrast-verified comparison), and verified text contrast (>=4.5:1) in both themes. This epic also establishes the i18n foundation (German + English) every user-facing string goes through from here on, and creates the README skeleton, which every later epic appends its own section to. Epics 2-5 deliver their own screens on top of this foundation rather than building any of it themselves.
**Covers:** NFR4, UX-DR1-4, and the Additional Requirements (stack wiring, auth, persistence plumbing, moderation baseline, observability, Express/React shell, i18n foundation, web/API security baseline per AD-30).

### Epic 2: Tailored Idea Discovery
Users complete an intake and receive 5 second-income ideas matched to their own skills, time, budget, and risk tolerance - not a generic list - and can curate that list by bookmarking or rejecting ideas.
**FRs covered:** FR1, FR2, FR3.

### Epic 3: Plan Creation & Activation
Users turn a chosen idea into a concrete, timed plan and explicitly confirm it before it goes live; they can later switch to a different bookmarked idea's plan without losing progress.
**FRs covered:** FR4, FR5.

### Epic 4: Check-Ins, Accountability & Payoff
Users can check in via text or voice on their own terms - never guilt-tripped for a missed day - and see tangible proof their effort matters: specific acknowledgments and a live income/opportunity projection that grows with real progress. Within this epic, the text check-in path is built and working before the voice path - voice remains a mandatory requirement (NFR2), just sequenced second so the core check-in logic (start/finish acknowledgment, missed-check-in handling, projection) is proven on the simpler channel first.
**FRs covered:** FR6, FR7, FR8, FR9.

### Epic 5: Settings, Cost Transparency & Feedback
Users can set the agent's personality, choose which LLM answers from a transparent never-hardcoded price list, switch the UI between German and English, choose a currency (EUR/USD) for every displayed amount, see what every response actually costs, and rate responses without that rating ever blocking them. The agent itself replies in whichever language (German or English) the user writes or speaks in, independent of the UI language choice.
**FRs covered:** FR11, FR12, FR13, FR14, FR15, FR16.

### Epic 6: Automated Evaluation & Quality Report
A grader/collaborator/future-you can see objective proof the agent's tool-calling actually works - across every selectable model, not just one - via an automated test suite and a generated report, not just a claim in the README.
**Covers:** NFR7, NFR9.

### Epic 7: Documentation & Deployment Handoff
A new reader (grader, collaborator, or future-you) can understand why this was built, run it from a README alone, see it deployed beyond the local demo, and - without signing in - browse a live "Quality & Decisions" page showing evaluation results, key decisions, and reflection. The README itself isn't written from scratch here - it was started as a skeleton in Epic 1 and extended by every epic along the way, including Epics 5 and 6; this epic finalizes it (adds example use cases and the technical-decision rationale) and handles deployment. Placed last since it depends on every other epic's output to document and ship.
**Covers:** the Documentation additional requirement (README, example use cases, technical rationale), the deployment additional requirement (Cloud Run + Neon, secrets via Secret Manager), and FR17 (the public Quality & Decisions page).

### FR Coverage Map

FR1: Epic 2 - structured intake with failure-pattern classification
FR2: Epic 2 - 5 tailored ideas with rationale and structured info
FR3: Epic 2 - bookmark/reject idea curation
FR4: Epic 3 - draft plan generation with timeline, current+next step visibility
FR5: Epic 3 - human-confirmed activation, revision, and switching
FR6: Epic 4 - text + voice check-ins with transcript review
FR7: Epic 4 - lazy missed-check-in detection and timeline recalculation
FR8: Epic 4 - distinct start/finish acknowledgments
FR9: Epic 4 - live income/opportunity projection
FR10: Epic 2 - "more ideas" batching, excluding bookmarked/rejected
FR11: Epic 5 - personality & model registry selection
FR12: Epic 5 - token/cost display and persistence
FR13: Epic 5 - response feedback (rating + comment)
FR14: Epic 5 (Story 5.4) - UI language switch (DE/EN), persisted, defaults to English
FR15: Epic 1 (Story 1.4, i18n foundation) + Epic 4 (voice, Story 4.3 amendment) - agent replies in whichever language the user writes/speaks in
FR16: Epic 5 (Story 5.5) - currency switch (EUR/USD), persisted, defaults to EUR; Stories 2.2/4.4/5.2 amended to be currency-aware
FR17: Epic 7 (Story 7.5) - public Quality & Decisions page, depends on Story 6.3's eval report (Epic 6) and Stories 7.2/7.4's rationale/weaknesses content (Epic 7) - placed last so it has no forward dependencies
NFR1-3, NFR5: Epic 4 - non-punitive design, voice-first-class, no audio retention, verifiable tone
NFR4: Epic 1 (baseline hooks) + enforced across Epics 2-5 wherever input/output occurs
NFR6: cross-cutting demo-reliability bar, verified across Epics 1-4
NFR7: Epic 6 - TypeScript-only eval tooling, per-model trajectory suite, report, now also covering German cases and both currencies/locales
NFR8: Epic 2/Epic 3 (discovery thread in Story 2.1, plan thread in Story 3.1)
NFR9: Epic 5 (Story 5.3) + Epic 6 (guardrail tests re-verify it)
UX-DR1-4: Epic 1 (theme/UI shell foundation incl. shadcn-glass-ui, teal accent scheme, contrast check); Epics 2-5 build their own screens on top of it
Additional Requirements (stack/paradigm/persistence/resilience/auth/deployment/i18n): Epic 1 (foundation incl. i18n) and Epic 7 (deployment); README skeleton starts in Epic 1, every epic appends its section, Epic 7 finalizes
AD-30 (web/API security baseline - Drizzle, helmet, CORS, rate limiting, body/message-length limits, log hygiene, ESLint react/no-danger): Epic 1 (Stories 1.1-1.3); session cookie + CSRF Origin-check (AD-17/AD-30): Epic 1 (Story 1.2)

## Epic 1: Sign In & First Contact

Users can sign in with Google and exchange at least one safe, moderated message with the agent - the thinnest possible end-to-end slice proving the whole stack works together before any capability-specific feature is built on top of it. Establishes the UI foundation every later epic's screens build on, the i18n foundation every user-facing string goes through from here on, and the README skeleton every later epic appends to.

### Story 1.1: Project Scaffolding & Themed UI Shell

As a user,
I want a clean, accessible, theme-aware interface,
So that the app feels polished and comfortable to use in either light or dark mode.

**Acceptance Criteria:**

**Given** a fresh checkout of the repo
**When** the developer runs the setup command
**Then** the Express backend and React frontend start successfully with TypeScript, Zod, and the shared schema package wired

**Given** the app loads for the first time with no stored theme preference
**When** it renders
**Then** light mode is shown by default, using shadcn/ui + shadcn-glass-ui's glass style with the teal accent scheme (see `stack.md` for the exact verified token values)

**Given** a user toggles dark mode
**When** they reload the app or return later
**Then** their dark-mode choice persists

**Given** any text in either theme
**When** checked against contrast requirements
**Then** contrast is at least 4.5:1

**And** `README.md` exists with a basic project description and setup skeleton

**Given** the backend's Postgres access layer
**When** any plain-code tool reads or writes data
**Then** it goes through **Drizzle ORM** (AD-30) - parameterized by construction, no raw string-built SQL anywhere

**Given** the Express app
**When** it starts
**Then** `helmet` is applied for baseline security headers, and `cors` is configured so the built React app is served from this same Express service (same-origin in production; the Vite dev proxy reaches the same effective origin locally) - never a wildcard origin (AD-30)

**Given** any API route
**When** a request arrives
**Then** `express-rate-limit` applies, with a stricter limit on `generate_ideas`/`create_plan` than on plain-code reads (AD-30)

**Given** any API route
**When** a request body is received
**Then** it is rejected if it exceeds a configured maximum size, before any further processing (AD-30)

**Given** the frontend codebase
**When** linted
**Then** an ESLint rule (`react/no-danger`) fails the build on any use of `dangerouslySetInnerHTML` (AD-30)

### Story 1.2: Google Sign-In

As a user,
I want to sign in with my Google account,
So that my data is private to me and persists across sessions.

**Acceptance Criteria:**

**Given** an unauthenticated user visits the app
**When** they are prompted to sign in
**Then** they can complete Google OAuth and land on an authenticated view

**Given** a successful first-time sign-in
**When** no user record exists yet
**Then** a new user row is created in Postgres, keyed to their Google identity

**Given** an authenticated session
**When** the user closes and reopens the app
**Then** they remain signed in without re-authenticating (within the session's validity)

**Given** an unauthenticated request to any capability
**When** it reaches the backend
**Then** it is rejected - auth gates the entire session from first use (AD-17)

**Given** a user completes Google OAuth
**When** the backend verifies their identity
**Then** it sets a server-side session in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie - no session token is ever exposed to client-side JavaScript or carried as a bearer token (AD-17/AD-30)

**Given** a state-changing request (any mutation)
**When** it reaches the backend
**Then** it is rejected unless its `Origin` header matches the app's own origin - this, together with `SameSite=Lax`, is the CSRF defense (AD-30), with no separate CSRF-token mechanism needed

### Story 1.3: Core Agent Loop with Moderation & Observability

As a signed-in user,
I want to send a message and get a safe, real response back from the agent,
So that I know the underlying system actually works before any specific feature is built on it.

**Acceptance Criteria:**

**Given** a signed-in user sends a text message
**When** it reaches the backend
**Then** it is routed through a LangChain `createAgent` instance running on the LangGraph.js runtime, and a response is returned via standard request/response (no streaming, AD-19)

**Given** a message is sent
**When** it is processed
**Then** it passes through the `beforeModel` Mistral Moderation 2 hook before reaching the model, and the `afterModel` hook before the response is shown

**Given** a message flagged as a jailbreak attempt
**When** `beforeModel` runs
**Then** the turn is rejected with a safe generic response and the incident is logged

**Given** any agent response
**When** it is logged
**Then** a LangSmith trace is recorded for the interaction

**Given** the conversation continues
**When** a new message arrives in the same conversation
**Then** it uses the same LangGraph thread, derived from the authenticated session (AD-18), with Postgres-backed checkpointing (AD-2); a new conversation gets a new thread

**Given** the resilience configuration
**When** any node in the graph is invoked
**Then** it has the `setNodeDefaults` resilience baseline applied (retry/timeout) per AD-7, with no duplicate retry logic in middleware

**Given** a model call still fails after its configured retries
**When** that happens
**Then** the user sees a clear error message and the app continues running, rather than crashing or hanging

**Given** `afterModel` flags a response as unsafe
**When** that happens
**Then** the unsafe response is replaced with a safe default response before being shown, and the incident is logged

**Given** the shared Zod schema for a user message
**When** a message is submitted
**Then** it enforces a maximum length - an over-length message is rejected at the schema boundary before it ever reaches the model, never silently truncated (AD-30)

**Given** any log entry written for this story (incident logs, LangSmith trace metadata, error logs)
**When** it is written
**Then** it never contains the raw text of a user message - only metadata (flags, categories, ids, lengths) is logged (AD-30)

### Story 1.4: Internationalization (i18n) Foundation & Bilingual Replies

As a user,
I want the app available in German or English and the agent replying in whichever language I actually use,
So that I can use it comfortably in my own language, not just English.

**Acceptance Criteria:**

**Given** any user-facing string in the app
**When** it is added
**Then** it goes through the i18n layer (`react-i18next`, translation keys under `src/locales/<language-code>/<namespace>.json`) - no hardcoded user-facing string ships in either language (AD-24)

**Given** Story 1.3's fixed system texts (the jailbreak-rejection message, the model-failure error message, the unsafe-response fallback message)
**When** this story completes
**Then** each has both a German and an English translation key - none defaults to English-only or is missing a German version

**Given** a user's message
**When** the agent replies
**Then** the reply language is determined from what the user actually wrote in that message - independent of the UI language setting (AD-25) - a German message gets a German reply, an English message gets an English reply, re-evaluated per message rather than locked to the thread's first message

**Given** the personality setting (CAP-7, configured in Epic 5)
**When** a response is generated in either language
**Then** the chosen tone (formal/friendly/terse) renders correctly in both languages - personality and reply-language are handled by the same prompt-construction step, not separate per-language personality definitions

## Epic 2: Tailored Idea Discovery

Users complete an intake and receive 5 second-income ideas matched to their own skills, time, budget, and risk tolerance - not a generic list - and can curate that list by bookmarking or rejecting ideas.

### Story 2.1: Structured Intake with Failure-Pattern Classification

As a signed-in user,
I want to complete a short intake about my skills, time, budget, risk tolerance, and what's stopped me before,
So that the ideas I get are actually matched to me.

**Acceptance Criteria:**

**Given** a signed-in user with no intake yet
**When** they open the app
**Then** they are prompted with the intake form (skills/interests free text; time/budget/risk preselected ranges; "what's stopped you before" free text)

**Given** the user submits the intake
**When** `submit_intake` is called
**Then** the agent classifies the free-text "stopped you before" answer into one of the five known failure patterns as part of its own reasoning, passed as the `failurePattern` argument

**Given** that call
**When** it executes
**Then** all intake fields, including `failurePattern`, are persisted to a dedicated Postgres table under that user

**Given** invalid or missing data
**When** `submit_intake` is called
**Then** the Zod schema rejects it before any write occurs (AD-16)

**Given** intake already submitted
**When** the user revisits
**Then** they see their saved intake, not an empty form

**Given** intake and idea discussion before any plan exists
**When** the user interacts
**Then** it happens in a single discovery thread per user (AD-18) - never a plan-specific thread

**Given** the intake UI (layout decision, final)
**When** built
**Then** it is a visible structured form with standard form fields (option A) - not a conversational/chat-based intake flow; revisiting with an existing intake shows those values prefilled in the form, not a blank form or a chat transcript to scroll through

### Story 2.2: Tailored Idea Generation

As a user who's completed intake,
I want to receive 5 income ideas genuinely matched to my situation,
So that I'm not stuck with a generic list.

**Acceptance Criteria:**

**Given** a completed intake
**When** the user requests ideas
**Then** `generate_ideas` produces exactly 5

**Given** each idea
**When** displayed
**Then** its rationale cites at least 3 different intake fields, with structured weekly time, startup cost, and risk level

**Given** `generate_ideas` needs a baseline income rate
**When** it runs
**Then** it uses the `web_search` MCP tool (grounded, not guessed), moderation-screened before caching (AD-7/AD-11), and persists the sourced rate + citation on the idea's record (AD-6) as an integer minor-unit amount plus its sourced currency code (AD-27) - never a float

**Given** an idea's startup cost
**When** displayed
**Then** it reads the currency value in `user_settings` (EUR by default - Story 5.5 later adds the UI control to change it, this story doesn't depend on that control existing yet), converted from the sourced currency using the configured rate and labeled an estimate if a conversion occurred (AD-27)

**Given** the LLM's output
**When** about to be saved
**Then** it is validated against the shared Zod schema first; a validation failure is never silently saved (AD-4)

**Given** two intakes differing in at least two fields
**When** ideas are generated for each
**Then** the resulting sets differ

**Given** any idea
**When** checked
**Then** it never exceeds the user's stated time, budget, or risk level

**Given** the ideas list UI (layout decision, final)
**When** displayed
**Then** it is a card layout (option A) - each of the 5 cards shows its rationale and its sourced baseline-rate citation (AD-6) directly on the card, not hidden behind a detail view or expansion

### Story 2.3: Bookmark and Reject Ideas

As a user viewing my 5 ideas,
I want to select one to pursue and manage the rest,
So that I keep useful alternatives without clutter.

**Acceptance Criteria:**

**Given** 5 generated ideas
**When** the user selects one
**Then** `set_idea_status` marks it `selected` and the rest default to `bookmarked`

**Given** each idea card (layout decision, final)
**When** rendered
**Then** select/bookmark/reject actions are all present directly on that card - never behind a separate menu or a different screen

**Given** a bookmarked idea
**When** the user marks it `rejected`
**Then** it disappears from the visible list; remaining bookmarked ideas stay visible

**Given** a status change
**When** `set_idea_status` runs
**Then** it is a plain deterministic Postgres update - no LLM call (AD-4)

**Given** a rejected idea
**When** the user reloads
**Then** it stays hidden (persisted, not just client-side)

### Story 2.4: Generate More Ideas

As a user who isn't satisfied with the current 5 ideas,
I want to request another batch,
So that I have more options without re-entering my intake.

**Acceptance Criteria:**

**Given** 5 existing ideas with some bookmarked/rejected
**When** the user requests "more ideas"
**Then** `generate_ideas` returns a further 5, never repeating anything already `bookmarked` or `rejected`

**Given** the new batch
**When** generated
**Then** it follows the same rules as the original batch (rationale citing >=3 intake fields, structured time/cost/risk, grounded baseline rate via `web_search`)

## Epic 3: Plan Creation & Activation

Users turn a chosen idea into a concrete, timed plan and explicitly confirm it before it goes live; they can later switch to a different bookmarked idea's plan without losing progress.

### Story 3.1: Draft Plan Generation with Failure-Pattern-Aware Steps

As a user who selected an idea,
I want a concrete plan broken into small steps with a timeline,
So that I know exactly what to do first instead of facing a vague goal.

**Acceptance Criteria:**

**Given** a selected idea with no existing plan
**When** `create_plan` runs
**Then** it produces ordered steps with a timeline, saved with status `draft` (not active)

**Given** the user's classified `failurePattern`
**When** steps are sized/sequenced
**Then** granularity reflects that pattern (e.g. smaller milestones for overwhelm, pre-staged next steps for "gets stuck")

**Given** a draft plan
**When** the user views it
**Then** only the current and immediate-next step are visible - `get_current_step` is the sole path enforcing this (AD-4)

**Given** the LLM's plan output
**When** about to be saved
**Then** it is validated against the shared Zod schema before the write (AD-4/AD-16)

**Given** `create_plan` is invoked
**When** that happens
**Then** it runs lazily - only on first selection or re-selection with no existing plan, never eagerly for all 5 ideas (AD-13)

**Given** a plan is created for the first time
**When** that happens
**Then** a dedicated plan thread is created for it (AD-18) - distinct from the discovery thread and from any other plan's thread

**Given** the plan workspace UI (layout decision, final — applies here and to every Epic 4/Story 5.2/5.3 screen touching this same plan)
**When** built
**Then** it is a single unified screen (option A) - a status sidebar/header (current+next step, timeline) and a projection card alongside one chat thread for check-ins, follow-up questions, and messages with their token/cost line and thumbs - never split into separate "Overview" and "Chat" tabs

**Given** that same unified layout
**When** viewed on a narrow/mobile screen
**Then** the status sidebar collapses into a compact header above the chat rather than disappearing or requiring a separate screen

**Given** an existing plan thread
**When** the user asks a free-form follow-up question (not a structured check-in action)
**Then** the agent answers it in context within that same plan thread, rather than only supporting fixed check-in flows

### Story 3.2: Human-Confirmed Plan Activation

As a user with a draft plan,
I want to review and explicitly approve it before it becomes active,
So that I'm never stuck with a plan I didn't actually agree to.

**Acceptance Criteria:**

**Given** a draft plan
**When** the user triggers activation
**Then** `activate_plan` pauses (LangGraph `interrupt`, AD-14) and surfaces the draft for confirm/modify/reject

**Given** confirmation
**When** `activate_plan` resumes
**Then** the plan becomes `active`, enforced via a DB transaction + partial unique constraint so exactly one plan is active per user (AD-14)

**Given** the user chooses to modify the draft
**When** they submit changes
**Then** the modification is validated against the Zod schema and saved to the draft (status remains `draft`); the user can then confirm it separately to make it active

**Given** rejection with feedback
**When** `activate_plan` resumes
**Then** `create_plan` runs again, updating the same plan row in place with a revised draft - never a new row (AD-13)

**Given** no plan is active yet
**When** checked
**Then** the system correctly reflects zero active plans rather than erroring

### Story 3.3: Switching Between Plans

As a user with multiple bookmarked ideas,
I want to switch which plan is active without losing other progress,
So that I can change direction without starting over.

**Acceptance Criteria:**

**Given** an active plan and a different bookmarked idea
**When** the user switches
**Then** the current plan becomes `paused` (never deleted) as part of activating the new one

**Given** a bookmarked idea with an existing paused plan
**When** reactivated
**Then** that same plan resumes with its existing steps/progress intact - `create_plan` does not run again

**Given** a bookmarked idea with no plan yet
**When** selected
**Then** `create_plan` runs for the first time for it (lazy, consistent with 3.1)

**Given** a newly created plan from switching to an idea with no existing plan
**When** it is generated
**Then** it starts as a `draft` and must go through the same human-confirmation gate (Story 3.2) before becoming active - switching never bypasses that gate

**Given** the switch completes
**When** checked
**Then** still exactly one plan is `active` (same constraint as 3.2)

## Epic 4: Check-Ins, Accountability & Payoff

Users can check in via text or voice on their own terms - never guilt-tripped for a missed day - and see tangible proof their effort matters: specific acknowledgments and a live income/opportunity projection that grows with real progress. The text check-in path is built and working before the voice path - voice remains mandatory (NFR2), just sequenced second.

### Story 4.1: Text Check-In with Start/Finish Acknowledgment

As an active-plan user,
I want to check in via text about my current step,
So that I get specific encouragement without empty praise.

**Acceptance Criteria:**

**Given** an active plan
**When** the user checks in
**Then** a lightweight energy/status input is requested before any task-related ask (`record_check_in`)

**Given** the user starts a step
**When** `start_step` is called
**Then** a distinct start-of-action acknowledgment fires, separate from completion

**Given** the user completes a step
**When** `complete_step` fires
**Then** a distinctly warm completion confirmation names the specific action taken - no streaks, points, or levels anywhere in it

**Given** `complete_step` succeeds
**When** that happens
**Then** the next step immediately becomes current and the step after it becomes visible (maintaining the current+next visibility rule)

**Given** `start_step` or `complete_step` is called on a step that is not the plan's current step
**When** that happens
**Then** the tool itself rejects the call (not just a UI-level guard)

**Given** `complete_step` is called on the plan's final step
**When** it succeeds
**Then** the plan's status becomes `completed`, with its own completion acknowledgment distinct from a per-step one

**Given** `record_check_in`/`start_step`/`complete_step`
**When** called
**Then** they are plain deterministic Postgres writes (AD-4) - no LLM call mutates this state

**Given** the check-in
**When** processed
**Then** it passes through the same moderation/resilience hooks as any other turn (AD-11/AD-7)

### Story 4.2: Non-Punitive Missed Check-In Handling

As a user who missed a check-in,
I want to be welcomed back without guilt,
So that a bad day doesn't spiral into abandoning the plan.

**Acceptance Criteria:**

**Given** a missed check-in
**When** the user next opens the app
**Then** `get_current_step` detects the gap (lazy, AD-15) and triggers automatic timeline recalculation

**Given** a detected gap
**When** the user is greeted
**Then** the message is neutral - no streak-break or shame language (NFR1)

**Given** the agent's response
**When** generated
**Then** it passes the dedicated `afterModel` guilt-language check (AD-12), capped at a bounded regeneration count with a neutral fallback

**Given** multiple missed check-ins in a row
**When** detected
**Then** the same non-punitive behavior applies regardless of count

**Given** the neutral re-entry message
**When** shown in either German or English
**Then** it reads naturally and non-punitively in both - not a literal/awkward translation (FR15, Story 1.4's i18n foundation)

### Story 4.3: Voice Check-In with Editable Transcript

As a user who'd rather speak than type,
I want to record a voice check-in and review the transcript before it's submitted,
So that I stay in control of what gets recorded.

**Acceptance Criteria:**

**Given** the user chooses voice
**When** recorded via the browser's `MediaRecorder` API
**Then** audio is sent to the backend and transcribed via `gpt-transcribe` (AD-9)

**Given** a transcript
**When** shown to the user
**Then** they can review and edit it before submission

**Given** confirmation
**When** submitted
**Then** it is processed identically to a typed check-in (same tools, same moderation)

**Given** transcription completes
**When** the raw audio is no longer needed
**Then** it is not retained (NFR3)

**Given** a voice recording in German or English
**When** sent to `gpt-transcribe`
**Then** it is called with `languages: ["de", "en"]` as a hint (AD-26) - narrowing detection to the app's two supported languages without forcing either

**Given** the detected language from that call
**When** the transcript is confirmed and submitted
**Then** the detected language is passed downstream so the agent's reply uses that same language (AD-25)

**Given** voice fails or is unavailable
**When** that happens
**Then** typed text remains available - the check-in is never blocked (NFR2)

### Story 4.4: Live Income & Opportunity Projection

As a user making progress,
I want to see a concrete payoff - estimated income and what I unlock next,
So that checking in feels tangibly worth it.

**Acceptance Criteria:**

**Given** a completed step or check-in
**When** `get_projection` is called
**Then** it returns an updated income estimate and the specific unlocked opportunity

**Given** the projection
**When** computed
**Then** it uses the baseline rate persisted at idea-generation (never re-fetched, AD-6) combined with actual logged hours and consistency

**Given** two check-ins with different actual progress
**When** compared
**Then** the projection value changes between them

**Given** `get_projection`
**When** called
**Then** it is a plain deterministic tool (AD-4) - no LLM computes the projection math

**Given** the projection
**When** displayed
**Then** the income estimate reads the currency value in `user_settings` (EUR by default; not dependent on Story 5.5's UI control existing yet) - converted from the baseline rate's sourced currency using the configured rate and labeled an estimate if a conversion occurred (AD-27), formatted via `Intl.NumberFormat` under the active UI language's locale

## Epic 5: Settings, Cost Transparency & Feedback

Users can set the agent's personality and choose which LLM answers from a transparent, never-hardcoded price list, see what every response actually costs, and rate responses without that rating ever blocking them.

### Story 5.1: Personality & Model Selection

As a user,
I want to pick the agent's tone and which LLM answers me,
So that I can tune the experience without needing a developer to change code.

**Acceptance Criteria:**

**Given** the settings screen
**When** the user picks a personality (formal/friendly/terse)
**Then** `set_personality` persists the choice, and subsequent responses reflect that tone

**Given** any personality
**When** a response is generated
**Then** the guilt-language check (AD-12) and all moderation (AD-11) apply identically - no personality weakens or bypasses them

**Given** the model registry
**When** the settings screen lists selectable models
**Then** only providers with a configured server-side key appear, and the moderation/transcription models never appear as options

**Given** a model selection
**When** `set_model` is called
**Then** it is a plain deterministic Postgres write (AD-4/AD-20) - not an LLM decision - and subsequent turns are answered by the newly selected model

**Given** the registry's pricing data
**When** displayed anywhere in the app
**Then** it is read from the registry, never a hardcoded value in application code

**Given** a user's settings
**When** saved
**Then** they persist per user in a dedicated `user_settings` table, surfaced through an actual settings screen - not just a backend default

**Given** the selected provider's key is missing, or a call to the selected model fails
**When** that happens
**Then** the system falls back to the default model and shows a neutral notice to the user - never a hard error

**Given** `set_model`/`set_personality`
**When** invoked
**Then** they are only ever called via the settings UI's API calls - the agent itself never autonomously decides to change its own personality or model

### Story 5.2: Token & Cost Display

As a user,
I want to see the token count and estimated cost under each response,
So that I understand what I'm actually spending.

**Acceptance Criteria:**

**Given** an agent turn completes
**When** the cost is computed
**Then** it sums every model call made during that turn's full agent-loop execution, not just the final response

**Given** the computed cost
**When** displayed
**Then** it is visibly labeled "estimate" and shown beneath the response

**Given** the cost
**When** displayed
**Then** it reads the currency value in `user_settings` (EUR by default; this story doesn't depend on Story 5.5's UI control existing yet) - the registry price itself is natively USD (AD-21/AD-27), converted to EUR using the configured rate (and labeled an estimate) only when the stored currency is EUR; USD needs no conversion

**Given** the turn
**When** it completes
**Then** the token count, the model id actually used, and a snapshot of that model's price at the time are all persisted per message in Postgres as an integer minor-unit amount plus currency code - not a float, not just a final dollar figure

**Given** a model with no price in the registry
**When** cost would be computed
**Then** the display shows the token count only, with no cost figure - it never guesses or shows a misleading $0

**Given** a persisted cost/token value
**When** the user reloads the page
**Then** the same values are shown, unchanged

### Story 5.3: Response Feedback

As a user,
I want to rate any response and optionally comment, without that ever blocking me,
So that I can give signal without friction.

**Acceptance Criteria:**

**Given** any agent response
**When** the user rates it thumbs up/down with an optional comment
**Then** `record_feedback` persists it as a plain deterministic write (AD-4/AD-22)

**Given** no rating has been given
**When** the user keeps using the app
**Then** the chat input is never disabled or gated on a missing rating (test this explicitly)

**Given** a comment is submitted
**When** it is processed
**Then** it passes through the same moderation as any other user input before being stored (AD-11/AD-22)

**Given** a rated trace
**When** stored
**Then** it feeds per-user semantic memory and a LangSmith dataset of rated traces, used only for offline prompt improvement - never model training; user content in that dataset is anonymized (PII stripped) before storage, documented as a security/privacy consideration

**Given** a positive rating on a response that actually violated a hard constraint
**When** that happens
**Then** the constraint violation is still logged and the check (e.g. AD-12) still applies going forward - the rating never excuses it

**Given** feedback stored from an earlier turn
**When** a later turn touches the same topic
**Then** semantic-memory retrieval surfaces it, with a test demonstrating an observable behavior change (not just that the write succeeded)

**Given** an existing rating
**When** the user changes or removes it
**Then** the stored feedback updates or is deleted accordingly - ratings are not permanent once given

### Story 5.4: UI Language Selection

As a user,
I want to switch the app's interface between German and English,
So that I can use the app comfortably regardless of which language I prefer for the UI itself.

**Acceptance Criteria:**

**Given** the settings screen
**When** the user picks German or English
**Then** `set_ui_language` persists the choice in `user_settings`, and the whole UI (via the i18n layer, Story 1.4) switches immediately

**Given** a first-time visit with no stored preference
**When** the app loads
**Then** it defaults to English

**Given** a stored UI language preference
**When** the user returns later
**Then** it persists across sessions

**Given** the UI language setting
**When** the user is chatting with the agent
**Then** the UI language has no effect on which language the agent replies in (FR15/AD-25) - the two are independent

### Story 5.5: Currency Selection

As a user,
I want to choose whether amounts show in EUR or USD,
So that the numbers I see are in the currency that's meaningful to me.

**Acceptance Criteria:**

**Given** the settings screen
**When** the user picks EUR or USD
**Then** `set_currency` persists the choice in `user_settings` (AD-27), and every displayed amount re-renders in the newly chosen currency immediately

**Given** a first-time visit with no stored preference
**When** the app loads
**Then** it defaults to EUR

**Given** any monetary value anywhere in the app (idea budgets, income projections, per-message cost)
**When** stored
**Then** it is stored as integer minor units plus a currency code - never a float

**Given** a value that needs converting to the user's chosen currency
**When** displayed
**Then** the conversion uses one configured EUR/USD rate with an as-of date (no live FX API call), and the displayed value is visibly labeled as an estimate

**Given** `generate_ideas`' sourced baseline rate (AD-6) persisted in its originally-sourced currency with its citation
**When** the user's currency setting changes
**Then** only the displayed/converted value changes - the stored source value and citation are never altered

**Given** the currency setting
**When** amounts are formatted
**Then** formatting uses `Intl.NumberFormat` with a locale driven by the active UI language (Story 5.4), independent of which currency is selected - e.g. German-locale grouping with a `$` symbol is valid if the UI is German and currency is USD

## Epic 6: Automated Evaluation & Quality Report

A grader/collaborator/future-you can see objective proof the agent's tool-calling actually works - across every selectable model, not just one - via an automated test suite and a generated report, not just a claim in the README.

### Story 6.1: Deterministic Tool & Guardrail Tests

As a grader/collaborator,
I want deterministic tests proving the critical tools behave correctly,
So that correctness doesn't rest on a claim alone.

**Acceptance Criteria:**

**Given** the plain-code tools
**When** Vitest unit tests run
**Then** `activate_plan`, `complete_step`, the exactly-one-active-plan rule, and timeline recalculation are each covered

**Given** guardrail concerns
**When** tested
**Then** guilt/streak-language triggering (AD-12), moderation triggering (AD-11), and a simulated prompt-injection via a `web_search` result are each covered

**Given** direct prompt injection attempted in a user message - "ignore/disregard your instructions", "output your system prompt", "list your tools", and an injected instruction embedded inside an otherwise normal check-in message - each case run in both German and English
**When** tested
**Then** this is a distinct guardrail case from the jailbreak/moderation trigger above, not folded into it; the assertion is on the **outcome**, not which layer caught it - no tool call outside the Zod-validated schemas is ever made, no plan reaches `active` without passing through the approval pause (AD-14), and the system prompt or tool list is never disclosed in the response

**Given** the same four direct-prompt-injection cases
**When** the report is generated
**Then** it separately records, as a non-gating metric that never affects pass/fail, how often Mistral Moderation's own jailbreak category flagged each input on its own - visibility only, keeping the open question over Mistral Moderation 2's own pending validation visible rather than hidden behind a pass/fail result

**Given** each of the 3 personalities (CAP-7)
**When** the guilt/streak-language guardrail test runs
**Then** it is run once per personality, not just the default one

**Given** the exactly-one-active-plan rule (AD-14)
**When** tested
**Then** an integration test runs against a real Postgres instance (not a mock) to exercise the actual partial unique constraint

**Given** currency handling (AD-27)
**When** unit tested
**Then** both EUR and USD are covered, each formatted under both the `de-DE` and `en-US` locales - confirming integer-minor-units storage (never floats), correct conversion via the configured rate with the estimate label applied, and that changing currency never alters a stored sourced-baseline-rate value or its citation

**Given** `activate_plan`
**When** tested
**Then** a negative test confirms a plan can never become `active` without going through the HITL pause/approval step - there is no code path that skips it

**Given** the guilt/streak-language, moderation, HITL-bypass, `web_search` prompt-injection, and direct prompt-injection outcome tests above
**When** the suite runs
**Then** they must all pass at a hard 100% bar, zero tolerance - a single failure here fails the suite, unlike the 80% trajectory-accuracy target in Story 6.2

**Given** the guilt/streak-language and moderation guardrail tests
**When** run
**Then** each runs in both German and English - not just English - still at the same 100% bar in both languages (FR15/CAP-10); German example patterns are added specifically for the bespoke guilt/streak-language check, since Mistral Moderation's own multilingual training doesn't cover that check

**Given** these tests
**When** run
**Then** no Python eval package is used anywhere (AD-23) - TypeScript/Vitest only

### Story 6.2: Trajectory Eval Suite Across All Models

As a grader/collaborator,
I want to see tool-calling accuracy measured consistently across every selectable model,
So that model choice isn't just a guess.

**Acceptance Criteria:**

**Given** `agentevals`
**When** the trajectory suite runs
**Then** it covers 15-25 cases, including a "no tool call on smalltalk" case, versioned as fixture files committed in the repo, with both German and English cases represented within that range (not a separate suite per language, FR15/CAP-10)

**Given** `createTrajectoryMatchEvaluator` cases
**When** comparing an actual trajectory to the expected one
**Then** they check tool arguments via `toolArgsMatchMode` (not only tool names) and run fully deterministically - no judge model is involved in these

**Given** `createTrajectoryLLMAsJudge` quality cases only
**When** judging any of the 4 registry models' trajectories
**Then** they always use one fixed judge model, `gpt-6-sol` (OpenAI, pinned by exact id in config, verified current and priced at $2/$10 per 1M), never one of the 4 registry entries, and never exposed in the user-facing model list

**Given** the judge model
**When** disclosed in the report (Story 6.3)
**Then** it is noted as a known limitation that the judge shares a provider (OpenAI) with one evaluated registry model (`gpt-6-luna`)

**Given** the suite's trajectory-accuracy results
**When** scored
**Then** an explicit 80% tool-call-accuracy target applies **per model** (not an aggregate average) as a single tunable constant, and the report always shows the actual measured number per model, even below 80% - never suppressed or rounded up

**Given** the 4 model-registry entries (AD-20)
**When** the suite runs
**Then** it runs at least once against each of them, not just whichever model is active during development

**Given** the suite
**When** triggered
**Then** it runs on demand via `npm run eval` - it is not wired into CI to run on every commit

**Given** the suite's results
**When** produced
**Then** they are linked to LangSmith

### Story 6.3: Evaluation Report Generation

As a grader/collaborator,
I want a single generated report summarizing eval results,
So that I don't have to re-run anything myself to see the evidence.

**Acceptance Criteria:**

**Given** a completed eval run (Stories 6.1-6.2)
**When** the report script runs
**Then** it produces a markdown/HTML report containing tool-call accuracy per model (actual numbers, never hidden even below the 80% target), whether the 100%-bar safety/guardrail tests passed, a model x accuracy table, and the run date

**Given** the report
**When** generated
**Then** a single command produces it end to end (e.g. `npm run eval:report`) - no manual assembly step

**Given** the report's content
**When** written
**Then** it also includes known limitations (cross-referencing Epic 7's Story 7.4, plus the judge-model/`gpt-6-luna` shared-provider note from Story 6.2) and the eval run's own estimated cost (using the CAP-8 token/cost mechanism against the actual calls the eval run itself made)

**Given** the generated report
**When** published
**Then** it is linked from the README (Epic 7)

**Given** the same report run
**When** the script completes
**Then** it also emits a machine-readable JSON summary with the same facts (per-model accuracy, safety pass/fail, run date, judge model, run cost, limitations) - this is the source the public Quality & Decisions page (Story 7.5) reads, so that page's content is generated, not hand-copied

## Epic 7: Documentation & Deployment Handoff

A new reader (grader, collaborator, or future-you) can understand why this was built, run it from a README alone, and see it deployed beyond the local demo. The README itself isn't written from scratch here - it was started as a skeleton in Epic 1 and extended by every epic along the way, including Epics 5 and 6; this epic finalizes it and handles deployment. Explicitly scoped to cover the course's grading criteria, not just general-purpose documentation.

### Story 7.1: Finalize README with Purpose, Audience, and Example Use Cases

As a new reader,
I want a complete README explaining the app's purpose, who it's for, and how to try it,
So that I understand what was built and why before digging into the code.

**Acceptance Criteria:**

**Given** the README skeleton (Epic 1) plus each epic's appended section
**When** this story runs
**Then** it is consolidated into one coherent document covering setup, each capability, and how to run locally

**Given** the README
**When** read from the top
**Then** it contains explicit sections on Purpose (what the agent is for), Usefulness (why it's useful and what problem it solves), and Target Audience (who it's for)

**Given** a new reader
**When** they read the "Example Use Cases" section
**Then** it walks through at least one full user journey end to end (intake -> 5 ideas -> select -> activate plan -> check in -> see projection)

**Given** the README
**When** checked
**Then** it is accurate against the actually-built app - no stale or aspirational claims

### Story 7.2: Document Technical Decision Rationale

As a grader/collaborator,
I want a clear technical rationale document,
So that I can evaluate the technical implementation and understand the reasoning behind it, not just read the code.

**Acceptance Criteria:**

**Given** the architecture spine's ADs and the spec/architecture memlogs
**When** the rationale doc is written
**Then** it explains how the agent works end to end (the createAgent/LangGraph tool-calling loop) without re-deriving reasoning from scratch

**Given** the single-agent paradigm
**When** explained
**Then** the doc states why a single agent was chosen over a multi-agent/orchestrator setup

**Given** the tool boundary
**When** explained
**Then** the doc covers how function calling works in this system - LLM-backed tools (`generate_ideas`, `create_plan`) versus deterministic plain-code tools (`submit_intake`, `set_idea_status`, `get_current_step`, `start_step`, `complete_step`, `record_check_in`, `get_projection`, `activate_plan`, `set_personality`, `set_model`, `record_feedback`) - and why that split exists

**Given** the codebase
**When** described
**Then** the doc includes the code structure (the source tree from the architecture spine, annotated with what lives where)

**Given** real-world usage
**When** described
**Then** the doc covers error and edge-case handling (retries/timeouts/fallbacks, out-of-order step calls being rejected, moderation rejections, voice fallback to text, missing-key/failed-model-call fallback)

**Given** security
**When** described
**Then** the doc covers: Google login/auth gating the whole session, the three moderation hook points and their per-category policy, server-side-only API keys (nothing sensitive reaching the browser), secrets via local `.env` then Google Secret Manager, Zod validation at every tool/API boundary, no raw audio retention, and the anonymization rule for feedback content entering the LangSmith dataset

**Given** the architectural approach
**When** justified
**Then** the doc explains why an agent with tool-calling was chosen over plain prompt engineering or a RAG pipeline, and why there is no curated/pre-built knowledge base - the system instead combines the model's own reasoning with live `web_search` results, each sourced rate persisted with its citation rather than pulled from a static corpus

**Given** the rationale doc
**When** linked from the README
**Then** a reader can find it easily

### Story 7.3: Deploy to Cloud Run + Neon

As the developer,
I want the app running beyond my laptop,
So that it's accessible without my machine running.

**Acceptance Criteria:**

**Given** the local app works end-to-end
**When** deployed
**Then** the backend+agent run on Cloud Run and Postgres runs on Neon

**Given** deployment
**When** configured
**Then** secrets move from local `.env` to Google Cloud Secret Manager

**Given** the deployed app
**When** exercised
**Then** the full Epic 1-6 journey works identically to local

**Given** Cloud Run's scale-to-zero
**When** a request arrives after idle
**Then** it responds correctly after cold start, with no manual intervention - consistent with Neon's auto-wake

### Story 7.4: Known Weaknesses, Improvement Suggestions, and Grading Traceability

As a grader/collaborator,
I want a clear-eyed account of the project's known weaknesses and a table mapping each grading criterion to its evidence,
So that I can assess the work fairly without having to hunt through the codebase myself.

**Acceptance Criteria:**

**Given** the finished build
**When** the "Known Weaknesses & Improvement Suggestions" section is written
**Then** it honestly lists real limitations (e.g. CAP-4's best-effort v1 scope, voice v1's transcript-review step vs. deferred speech-to-speech, lazy-only missed-check-in detection with no proactive notifications, Mistral Moderation 2's adoption still pending the user's own eval-set testing, the eval judge sharing a provider with `gpt-6-luna`, and the `mistral-large-4` id/pricing still unverified) and what would improve each

**Given** the course's grading criteria (Agent Purpose, Core Functionality, User Interface, Technical Implementation, Documentation)
**When** the traceability table is written
**Then** each criterion links to the specific README section, rationale-doc section, or code location that demonstrates it - no criterion left unmapped

**Given** this table
**When** placed
**Then** it lives in the README or is linked prominently from it, not buried

**Given** the "Known Weaknesses & Improvement Suggestions" content and the traceability table
**When** written
**Then** both are captured as structured data (not only prose in the README) - a later story may reuse this same content rather than a separately hand-written copy

### Story 7.5: Quality & Decisions Page

As a grader/collaborator/future-you,
I want a public page showing evaluation results, key decisions, and an honest reflection - without needing to sign in,
So that I can see this evidence directly, generated from what already exists, without hunting through the repo.

**Acceptance Criteria:**

**Given** the page
**When** accessed by anyone, signed in or not
**Then** it loads with no sign-in required - a deliberate, narrowly-scoped exception to the app's otherwise-universal auth requirement (AD-28); every other route/capability remains gated exactly as before

**Given** the Evaluation Results section
**When** rendered
**Then** it reads the JSON summary Story 6.3's report script emits (tool-call accuracy per model, safety pass/fail against the 100% bar, run date, judge model, run cost, limitations) - not a hand-copied snapshot

**Given** the Key Decisions section
**When** rendered
**Then** it reads a curated decisions-summary data file maintained alongside the architecture spine, each entry citing its `AD-n` id with a short reason and trade-off - covering at minimum agent shape (why an agent instead of prompt engineering or RAG), the tool boundary, the HITL gate, the persistence split, guardrails, model choice, i18n, and money handling

**Given** the Reflection section
**When** rendered
**Then** it reuses the same structured "Known Weaknesses & Improvement Suggestions" content from Story 7.4, plus guidance on when to use prompt engineering vs. RAG vs. agents - not a separately hand-written copy

**Given** the page's content as a whole
**When** tested
**Then** a dedicated test confirms it contains no user-specific data, no secrets, and no private LangSmith trace links - verified, not just asserted

**Given** the page's UI chrome (navigation, labels, section headers)
**When** rendered
**Then** it goes through the same i18n layer as the rest of the app (German/English); the report/decision content itself stays English, with that choice stated visibly on the page

**Given** Story 7.4's traceability table
**When** this story completes
**Then** it adds this page as evidence for the Documentation/reflection grading criterion, alongside the README and rationale doc (an addition to 7.4's existing table, not a rewrite of it)
