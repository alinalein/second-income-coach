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

FR2: System generates exactly 3 tailored (one batch-size setting `IDEAS_PER_BATCH`, range 1-5, default 2 during development for cheap test runs and switched to 3 (the product and demo value) shortly before the demo - see the before-demo checklist in build-sessions.md; a batch is that many ideas everywhere) second-income ideas from a completed intake. Each idea includes a rationale citing at least 3 different intake fields and structured info on weekly time required, startup cost, and risk level. No idea exceeds the user's stated time/budget/risk; two intakes differing in at least two fields yield different idea sets.

FR3: User can select one of the shown ideas to work on; the others are retained as "bookmarked" (not discarded); the user can mark any idea "rejected," removing it from the visible list.

FR4: Once an idea is selected, the system generates a draft plan of small concrete steps with an estimated timeline, sized and sequenced according to the user's classified failure pattern. Only the current and immediate-next step are visible at any time.

FR5: A generated draft plan requires explicit human confirmation before becoming active (human-in-the-loop). Confirming activates exactly one plan at a time and pauses (never deletes) any previously active plan. Rejecting produces a revised draft incorporating the user's feedback, updating the same plan row rather than creating a new one. The user can later activate a different bookmarked idea's plan - resuming a paused plan rather than regenerating it from scratch.

FR6: User can check in with the agent on an ongoing basis, either by typed text or by voice. Voice check-ins are recorded client-side, transcribed, and shown back as an editable transcript the user confirms/edits before submission; typed text remains an always-available fallback. A lightweight energy/status input precedes any task-related ask.

FR7: A missed check-in is detected lazily, the next time the app is opened (comparing expected vs. actual last check-in date). It triggers an automatic, non-punitive timeline recalculation and a neutral re-entry message - never shame or streak-break language.

FR8: Starting a step and completing a step each produce their own distinct, specific acknowledgment message (not generic praise, and not a single combined message).

FR9: After each completed step or check-in, the user sees an updated income estimate and the concrete next opportunity it unlocks - computed from their actual logged progress and check-in consistency, not fixed at intake and not silently re-fetched/recomputed later.

FR10: User can request "more ideas" for a further batch (same size as the first) that is added to the existing ones, never repeating anything already bookmarked or rejected.

FR11: User can set the agent's personality (formal/friendly/terse) and choose which LLM answers from a model registry (id, provider, display name, price per 1M input/output tokens, price_as_of); only providers with a configured server-side key are selectable, and the moderation/transcription models are never user-selectable.

FR12: User sees the token count and an estimated cost beneath every agent response, summed across every model call in that turn, persisted per message.

FR13: User can rate any agent response (thumbs up/down, optional comment) without that rating ever blocking the chat input; feedback feeds per-user semantic memory and a LangSmith dataset for offline prompt improvement only.

FR14: User can switch the UI language between German and English in Settings; the choice persists in `user_settings` and defaults to English.

FR15: The agent understands and replies in German or English, matching whichever language the user writes (or speaks, for voice) in per message - independent of the UI language setting. All fixed system texts exist in both languages; personality (formal/friendly/terse) renders correctly in both.

FR16: User can set a currency (EUR or USD, default EUR) in Settings, covering both the token/cost display (FR12) and income projections/idea budgets (FR2/FR9). Changing it re-renders every displayed amount in the newly chosen currency; converted amounts are always labeled as estimates.

FR17: A public, unauthenticated "Quality & Decisions" page presents the latest evaluation results, a summary of key architecture decisions (reason + trade-off), and a reflection (known problems, improvement suggestions, when to use prompt engineering vs. RAG vs. agents) - every fact generated from an existing source, never hand-copied. UI chrome is localized; report/decision content stays English, stated on the page. Contains no user data, secrets, or private LangSmith trace links.

FR18: While an agent turn is in progress, the user sees a short, localized, friendly status label reflecting the agent's real current step (e.g. "Thinking…", "Searching the web…", "Coming up with ideas…") - sourced from the actual step/tool being executed via a fixed step-to-label mapping, never from the model's own generated text and never exposing an internal tool or function name. The final answer is revealed only after it passes output moderation (and, where applicable, the guilt-language check), via a client-side typing effect over the already-safe text.

FR19: Agent responses in the chat render basic Markdown (headings, lists, bold text); no raw HTML is ever rendered from agent- or user-authored content, consistent with the app's XSS defense.

### Additional NonFunctional Requirements

NFR7: Eval tooling is TypeScript-only (`agentevals` + Vitest + LangSmith) - no Python eval packages. A trajectory suite (15-25 cases) plus deterministic unit and guardrail tests run against all 3 model-registry entries plus the eval-only model `anthropic/claude-sonnet-5.5` (never user-selectable), with a report script producing a linked markdown/HTML report (tool-call accuracy, constraint-test results, model x accuracy table, run date).

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

- **No starter/scaffold template** - this is a custom greenfield build (TypeScript 6.0.3 - typescript-eslint hard-errors on TS 7 today, revisit once fixed; Node 26, Express, React 19.3.1), not based on a starter kit.
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
- **Environment variables and keys (project rule)**: every story that introduces an external service adds its variable(s) to `.env.example` (placeholder values only - never a real key, token or secret, in that file or anywhere in the repo) and to the startup check in `src/config/env.ts` (which names a missing variable without ever printing a value), and its completion report states exactly which keys the user must fill in. Stories that introduce keys: **1.2** (Google OAuth client id/secret, session secret), **1.3** (model provider key(s), Mistral Moderation key, LangSmith key/project), **2.2** (`web_search` provider key), **4.3** (voice transcription key), **7.3** (deployment secrets: Neon connection string, production OAuth settings, Secret Manager). Stories 5.1 (additional registry providers) and 5.3 (embeddings for semantic memory) add a variable too if they introduce a provider not already covered. Whether a variable is required at startup or optional (its feature degrades per that story's own ACs, e.g. an unconfigured registry provider is simply not selectable) is stated per variable in `src/config/env.ts`.
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
Users can sign in with Google and exchange at least one safe, moderated message with the agent - the thinnest possible end-to-end slice proving the whole stack (auth, agent loop, Postgres, moderation, resilience, Zod schemas, LangSmith, and the themed UI shell) actually works together before any capability-specific feature is built on top of it. This epic establishes the UI foundation every later epic's screens build on: shadcn/ui + shadcn-glass-ui, a theme provider defaulting to light mode with a dark-mode toggle (choice persisted), a glass visual style, a teal accent scheme (chosen final, after an emerald/teal/amber/ocean contrast-verified comparison), and verified text contrast (>=4.5:1) in both themes. This epic also establishes the i18n foundation (German + English) every user-facing string goes through from here on, creates the README skeleton (which every later epic appends its own section to), and finishes the shared chat UI with real-step progress display and Markdown rendering. Epics 2-5 deliver their own screens on top of this foundation rather than building any of it themselves.
**Covers:** FR18, FR19, NFR4, UX-DR1-4, and the Additional Requirements (stack wiring, auth, persistence plumbing, moderation baseline, observability, Express/React shell, i18n foundation, web/API security baseline per AD-30).

### Epic 2: Tailored Idea Discovery
Users complete an intake and receive 3 second-income ideas matched to their own skills, time, budget, and risk tolerance - not a generic list - and can curate that list by bookmarking or rejecting ideas.
**FRs covered:** FR1, FR2, FR3.

### Epic 3: Plan Creation & Activation
Users turn a chosen idea into a concrete, timed plan and explicitly confirm it before it goes live; they can later switch to a different bookmarked idea's plan without losing progress.
**FRs covered:** FR4, FR5.

### Epic 4: Check-Ins, Accountability & Payoff
Users can check in via text or voice on their own terms - never guilt-tripped for a missed day - and see tangible proof their effort matters: specific acknowledgments and a live income/opportunity projection that grows with real progress. Within this epic, the text check-in path is built and working before the voice path - voice remains a mandatory requirement (NFR2), just sequenced second so the core check-in logic (start/finish acknowledgment, missed-check-in handling, projection) is proven on the simpler channel first.
**FRs covered:** FR6, FR7, FR8, FR9.

#### Story 4.5: Plan Completion View

As a user who has finished every step of a plan,
I want to see a clear, warm finish instead of an empty panel,
So that completing a plan feels like an actual result.

**Acceptance Criteria:**

**Given** a plan whose status is `completed` (Story 4.1)
**When** its workspace is opened or the last step is just completed
**Then** the status column shows a "Plan completed" card (completion date, number of completed steps) instead of "No current step yet", with no points, streaks, levels or badges (non-goal), and no Start/Mark-as-done controls; the energy pop-up is not shown for it

**Given** the completed plan
**When** the projection card renders
**Then** it shows the final income estimate (Story 4.4 data) in the completed state, labelled as the result of the finished plan

**Given** the last step was just completed
**When** the acknowledgment is produced
**Then** the plan chat receives one personal, warm, non-punitive completion message from one direct model call (AD-4 amendment; AD-12 guilt check; user's language, AD-25) that names what the user achieved in plain words and neutrally points to "New ideas" in the sidebar as an option, never as pressure; failure of the model call leaves the existing fixed completion hint and never blocks completion

**Given** a completed plan
**When** the user opens its chat
**Then** the chat stays fully usable (read history, ask about completed steps, follow-up questions); only step state changes are blocked at the tool level (`start_step`/`complete_step` reject, as for any non-current step)

**Given** the plan list in the sidebar
**When** a plan is completed
**Then** it shows a neutral "Completed" label (not paused/dimmed like a paused plan) and stays selectable

## Epic 5: Settings, Cost Transparency & Feedback
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
FR16: Epic 5 (Story 5.5) - currency switch (EUR/USD), persisted, defaults to EUR; Stories 2.2/4.4/5.2 amended to be currency-aware; the `user_settings` table (currency, personality, model, ui_language) is created in Story 1.2 so none of them has a forward dependency on Epic 5; the shared money helper is created in Story 2.2
FR17: Epic 7 (Story 7.5) - public Quality & Decisions page, depends on Story 6.3's eval report (Epic 6) and Stories 7.2/7.4's rationale/weaknesses content (Epic 7) - placed last so it has no forward dependencies
FR18: Epic 1 (Story 1.5) - real-step progress display (SSE transport, AD-31), i18n-backed friendly labels, reveal gated behind output moderation/guilt-language check; each later tool-introducing story (2.2, 3.1, 4.1, etc.) adds that tool's own label key, same pattern as the env-variable rule
FR19: Epic 1 (Story 1.5) - Markdown rendering in the shared `ChatMessage` component, no raw HTML (AD-30 amended, AD-32)
NFR1-3, NFR5: Epic 4 - non-punitive design, voice-first-class, no audio retention, verifiable tone
NFR4: Epic 1 (baseline hooks) + enforced across Epics 2-5 wherever input/output occurs
NFR6: cross-cutting demo-reliability bar, verified across Epics 1-4
NFR7: Epic 6 - TypeScript-only eval tooling, per-model trajectory suite, report, now also covering German cases and both currencies/locales
NFR8: Epic 2/Epic 3 (discovery thread in Story 2.1, plan thread in Story 3.1)
NFR9: Epic 5 (Story 5.3) + Epic 6 (guardrail tests re-verify it)
UX-DR1-4: Epic 1 (theme/UI shell foundation incl. shadcn-glass-ui, teal accent scheme, contrast check); Epics 2-5 build their own screens on top of it
Additional Requirements (stack/paradigm/persistence/resilience/auth/deployment/i18n): Epic 1 (foundation incl. i18n) and Epic 7 (deployment); README skeleton starts in Epic 1, every epic appends its section, Epic 7 finalizes
AD-30 (web/API security baseline - Drizzle, helmet, CORS, rate limiting, body/message-length limits, log hygiene, ESLint react/no-danger): Epic 1 (Stories 1.1-1.3, amended in Story 1.5 for safe Markdown rendering); session cookie + CSRF Origin-check (AD-17/AD-30): Epic 1 (Story 1.2)

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

**Given** that first-time sign-in
**When** the user row is created
**Then** a `user_settings` row for that user is created in the same transaction, in a dedicated `user_settings` table (AD-20/AD-27) holding `currency` (EUR by default), `personality`, `model`, and `ui_language` (English by default); the personality and model columns hold the configured default (the model column may hold "use the default model" until Story 5.1 introduces the registry) - a user row never exists without its settings row
**And** the table and its Drizzle schema are created here, not in a later story: Stories 2.2, 4.4 and 5.2 read `currency` from it, and Stories 5.1, 5.4 and 5.5 add the settings screen, the `set_*` tools and validation on top of it without creating or migrating the table

**Given** an existing user who has no `user_settings` row (e.g. created before this story shipped)
**When** they next sign in
**Then** the missing row is created with the same defaults - sign-in never fails or returns empty settings because the row is absent

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

**Given** this story introduces external credentials (the Google OAuth client id and secret, and the session secret)
**When** it is built
**Then** the project's environment-variable rule applies (see Additional Requirements): the variables are added to `.env.example` as placeholders and to the startup check in `src/config/env.ts`, and the completion report lists which keys the user must fill in

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

**Given** the chat UI this story needs to show a message exchange
**When** it is built
**Then** it builds the shared `ChatThread`/`ChatMessage` component directly (message list, text input, error and neutral-notice rendering) - Story 3.1 later extends it additively with extension points and the plan workspace around it, rather than replacing it

**Given** this story introduces external credentials (the model provider key(s), the Mistral Moderation key, and the LangSmith key and project settings)
**When** it is built
**Then** the project's environment-variable rule applies (see Additional Requirements): each variable is added to `.env.example` as a placeholder and to the startup check in `src/config/env.ts`, and the completion report lists which keys the user must fill in

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

### Story 1.5: Agent Progress Display & Markdown Rendering

As a signed-in user,
I want to see what the agent is actually doing while it works, and read its replies with basic formatting,
So that a longer turn doesn't feel like a frozen screen, and longer answers stay easy to read.

(Depends on Story 1.3's `ChatThread`/`ChatMessage` component and Story 1.4's i18n layer for the status labels below - sequenced after both.)

**Acceptance Criteria:**

**Given** an agent turn in progress
**When** it moves through a real step (checking the message, generating a response, calling a tool, checking the answer)
**Then** the chat shows a short, friendly, localized status label for that exact step (e.g. "Checking your message…", "Thinking…", "Checking the answer…") - sourced from a fixed step-to-label mapping keyed by the real internal step/tool identifier, never by interpolating or exposing that identifier itself, and never derived from the model's own generated text (AD-31)

**Given** a tool call occurs during a turn (from Epic 2 onward - this epic has no tools of its own)
**When** its status label is shown
**Then** it is the friendly label its own introducing story registers for that tool (e.g. Story 2.2 registers "Searching the web…" for `web_search` and "Coming up with ideas…" for `generate_ideas`; Story 3.1 registers "Working on your plan…" for `create_plan`; Story 4.1 registers "Saving your check-in…" for `record_check_in`) - an unmapped tool (introduced later, label not yet added) falls back to one fixed generic label, never a blank state or the raw tool name

**Given** every status label text
**When** it is added
**Then** it goes through the i18n layer (AD-24) with both a German and an English key from the moment it is introduced - no status label ships English-only

**Given** the agent's final answer
**When** it becomes available
**Then** it is only revealed to the user after it has passed `afterModel` output moderation (AD-11) and, for any capability AD-12 binds, the guilt-language check - never shown, partially or fully, before both have run

**Given** the fully-moderated final answer
**When** it is revealed
**Then** it is revealed via a client-side typing effect applied to the complete, already-safe text - a cosmetic reveal only, never a mechanism that streams partial, not-yet-moderated model output to the user (AD-19 amended)

**Given** progress-status events for a single turn
**When** they are delivered to the client
**Then** they arrive over one Server-Sent Events (SSE) connection scoped to that turn's own request/response cycle - not polling, and not a general streaming API for model output (AD-19 amended)

**Given** an agent response containing Markdown (headings, lists, bold)
**When** it is rendered in `ChatMessage`
**Then** it renders as formatted content via a safe Markdown renderer that never passes raw HTML through and never uses `dangerouslySetInnerHTML` - the existing ESLint `react/no-danger` rule still enforces this (AD-30 amended, AD-32)

**Given** any text shown in the chat message list - user messages, agent answers (including Markdown-rendered ones), and system notices (the jailbreak-rejection message, the error fallback, the unsafe-response fallback)
**When** it is rendered
**Then** all of it uses the same font size, taken from one shared style value in `ChatMessage` - not set per message type; Markdown structure (headings, bold, lists) is distinguished by weight and spacing, never by a different font size

### Story 1.6: Glass Style & Contrast Re-verification

As a user,
I want the frosted-glass look the design specifies,
So that the app matches UX-DR3 and Story 1.1's acceptance criterion, which was accepted without it.

**Acceptance Criteria:**

**Given** the web app
**When** built
**Then** `shadcn-glass-ui` is a dependency again and its glass style is applied through the shared components (cards, buttons, inputs/selects/textareas, chat bubbles, header) with the pinned teal tokens from `stack.md` - defined once, never per screen

**Given** any text in light and dark mode on the glass surfaces
**When** checked
**Then** contrast is at least 4.5:1 (UX-DR4), re-verified with the translucent surfaces, and the measured values are in the story report

**Given** the glass pass
**When** complete
**Then** it is visual only: no change to behaviour, ARIA, i18n keys or existing tests, and the intake, chat, ideas and settings screens all render with it

**Given** any later review or cleanup
**When** it flags `shadcn-glass-ui` or its style import as unused
**Then** it stays (UX-DR3); removal needs the user's approval

## Epic 2: Tailored Idea Discovery

Users complete an intake and receive 3 second-income ideas matched to their own skills, time, budget, and risk tolerance - not a generic list - and can curate that list by bookmarking or rejecting ideas.

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
**Then** `generate_ideas` produces exactly `IDEAS_PER_BATCH` ideas (default 2 in development, 3 for the demo)

**Given** each idea
**When** displayed
**Then** its rationale cites at least 3 different intake fields, with structured weekly time, startup cost, and risk level

**Given** `generate_ideas` needs a baseline income rate
**When** it runs
**Then** it uses the `web_search` MCP tool (grounded, not guessed), moderation-screened before caching (AD-7/AD-11), and persists the sourced rate + citation on the idea's record (AD-6) as an integer minor-unit amount plus its sourced currency code (AD-27) - never a float

**Given** an idea's startup cost
**When** displayed
**Then** it reads the currency value from the `user_settings` row created in Story 1.2 (EUR by default - Story 5.5 later adds the UI control to change it, this story doesn't depend on that control existing yet), converted from the sourced currency using the configured rate and labeled an estimate if a conversion occurred (AD-27)

**Given** the money handling this story is the first to need (minor-unit amounts, conversion with the configured EUR/USD rate and its as-of date, `Intl.NumberFormat` formatting)
**When** it is built
**Then** it lives in one shared money helper created here and reused by Stories 4.4, 5.2 and 5.5 - not re-implemented per story

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

**Given** ideas already exist and the user has changed their intake answers
**When** they request new ideas from the ideas panel
**Then** a visible "Generate new ideas" action runs `generate_ideas` again for the current intake; it adds a further batch (same size as the first) to the existing ideas (nothing the user has bookmarked, rejected or already been shown is removed or repeated) - the batch-adding behaviour is Story 2.4

**Given** this story introduces the `web_search` provider's credential
**When** it is built
**Then** the project's environment-variable rule applies (see Additional Requirements): the variable is added to `.env.example` as a placeholder and to the startup check in `src/config/env.ts`, and the completion report lists which key the user must fill in

### Story 2.3: Bookmark and Reject Ideas

As a user viewing my ideas,
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

As a user who isn't satisfied with the current ideas,
I want to request another batch,
So that I have more options without re-entering my intake.

**Acceptance Criteria:**

**Given** existing ideas, some of them bookmarked/rejected
**When** the user requests "more ideas"
**Then** `generate_ideas` returns a further batch of the same size, added to the existing ones, never repeating anything already shown (`suggested`, `bookmarked` or `rejected`)

**Given** the new batch
**When** generated
**Then** it follows the same rules as the original batch (rationale citing >=3 intake fields, structured time/cost/risk, grounded baseline rate via `web_search`)

### Story 2.5: Opportunity Discovery & Growth Path

As a user,
I want ideas based on what is actually in demand right now, with a path for how each can grow,
So that the suggestions are current and worth acting on, not generic.

**Acceptance Criteria:**

**Given** a generate request (first batch or "more ideas")
**When** `generate_ideas` runs
**Then** before writing ideas it runs a discovery search with `web_search` (still used only by `generate_ideas`, AD-5) for current trends, niches and demand signals relevant to the intake's skills and interests, and the results are moderation-screened before they are cached or used (AD-7/AD-11)

**Given** each idea
**When** displayed
**Then** it shows a demand/trend evidence note with its source URL, in addition to the baseline-rate citation (AD-6), directly on the card; the evidence is persisted on the idea's record and is never invented - an idea without sourced evidence is retried, not shown

**Given** a batch
**When** validated
**Then** its evidence comes from at least 3 distinct source domains, and the discovery step is not limited to freelance rate pages

**Given** each idea
**When** displayed
**Then** it shows a short translated "how this can grow" note (reply language, FR15/AD-25); where the user's time, budget and risk limits allow it, the batch includes ideas with a higher earning ceiling

**Given** any idea
**When** checked
**Then** it still never exceeds the user's stated time, budget or risk level

**Given** the user's country
**When** ideas are generated
**Then** the intake form gains a country field (extending Story 2.1's form and `intake` table), and baseline rates and demand evidence come from sources for that country when available; a source for another region is labeled on the card (e.g. "US data") and a figure in another currency region is never presented as a local rate

**Given** a baseline rate or demand evidence
**When** shown for an idea
**Then** its source describes the same activity or occupation as the idea (checked deterministically against the quoted passage), otherwise the card shows it as unverified; login-walled salary sites that mask figures by region are never used as a source

**Given** the new fields
**When** saved
**Then** they are validated against the shared Zod schema first (AD-4/AD-16) and a validation failure is never silently saved; adding them needs a column or JSON field on `ideas`, no new table

**Given** the discovery step
**When** it runs
**Then** it reuses the same `web_search` provider key (no new external service, no new variable), uses the AD-7 cache, and keeps generation inside the ideas path's own timeout with the progress feedback from Story 2.2

### Story 2.7: Translate Idea Cards on Language Change

As a user,
I want the text on my idea cards to switch language when I switch the UI language,
So that the cards never show a language I didn't choose.

**Acceptance Criteria:**

**Given** idea cards stored in one language
**When** the UI language changes (Story 5.4) to the other one
**Then** the generated text of every visible card (title, rationale bullets, demand note, growth path, caveat) is shown in the new language without a new search and without changing any number, currency, source, URL, citation quote or trust label

**Given** a translation
**When** it is produced
**Then** one batched model call translates all visible cards together (internal model, never in the user-selectable registry), the result passes output moderation (AD-11), and it is persisted per idea and language so switching back and forth is instant and never calls the model twice for the same text

**Given** the translation is running
**When** the user waits
**Then** the cards show a localized loading state (no flash of mixed languages); on failure the cards stay in their stored language with a neutral notice and a retry, never blank

**Given** "Generate new ideas" or any later generation
**When** it runs from a button
**Then** the ideas are written in the current UI language (a button click is not a written message); chat-triggered generation keeps following the language the user wrote in (AD-25)

**Given** a source quote
**When** the card is translated
**Then** the quote stays in its original language and is shown as such; only the surrounding card text is translated

### Story 2.8: Guided Flow from Intake to Plan

As a user,
I want the app to walk me from my answers to my ideas to my plan in clear steps,
So that I always know what to do next and never see actions that don't apply yet.

**Acceptance Criteria:**

**Given** a user who submits the intake form for the first time
**When** the submission succeeds
**Then** idea generation starts automatically, with the same real-step progress display as today (no extra click); a returning user with ideas goes straight to their ideas

**Given** the ideas are shown
**When** the user looks under the "Your tailored income ideas" heading
**Then** a short localized explanation tells them what to do: choose the idea they like most, reject the ones they don't want, and press "Generate new ideas" to see more

**Given** the user presses "Select" on an idea
**When** the action is triggered
**Then** a confirmation dialog states that this idea becomes their chosen one and the remaining ideas are kept as bookmarks they can view later; only on confirm does the status change (Story 2.3 behaviour) and the plan get created (Story 3.1, lazily); cancel changes nothing

**Given** the user confirms the selection
**When** the plan has been generated
**Then** the plan workspace (Story 3.1) opens with the draft plan and the plan chat

**Given** the idea cards
**When** an idea has no plan (every idea except the selected one)
**Then** the card shows no "View plan" action; only the selected idea's card links to its plan

**Given** the empty space under the ideas heading and any reserved-height placeholders
**When** the ideas are loaded
**Then** no blank bands remain; the explanation text or nothing occupies that space

**Given** Story 3.2 (draft plan review and activation) and Story 3.3 (switching plans)
**When** this flow is built
**Then** they stay unchanged: the idea-selection dialog here confirms the choice of idea, activation in 3.2 still confirms the plan itself, and switching in 3.3 reuses the same select-and-confirm dialog

### Story 2.9: App Navigation Sidebar

As a signed-in user,
I want a left sidebar that lists my plans and bookmarked ideas and takes me to my ideas and settings,
So that I can move between the things I'm working on without hunting through the page.

**Acceptance Criteria:**

**Given** a signed-in user with an intake
**When** any main screen is shown
**Then** a left sidebar shows, top to bottom: the product name, a "New ideas" entry (the ideas view of Stories 2.2/2.3/2.8, unchanged), a "My plans" list, a "Bookmarked" list, and at the bottom the user's profile entry with Settings, the theme toggle and sign-out; the active entry is visibly marked and every entry is keyboard-reachable with an accessible name (DE + EN, AD-24)

**Given** the "My plans" list
**When** the user has plans
**Then** each entry is one idea with a plan, titled with the idea, sorted by last activity; the active plan is marked, paused plans are dimmed; selecting an entry opens that plan's workspace (Story 3.1) with that plan's own chat thread (AD-18); with no plans the list shows a short localized note, never an error or blank area

**Given** the "Bookmarked" list
**When** the user has bookmarked ideas without a plan
**Then** each entry is one such idea; selecting it opens the confirmation dialog of Story 2.8, and confirming runs the select-and-plan flow (lazy `create_plan`, Story 3.1/3.3) after which the idea moves to "My plans"; switching which plan is active, pausing and resuming stay Story 3.3's behaviour and the 3.2 confirmation gate is never bypassed

**Given** the profile entry
**When** opened
**Then** it offers Settings (the existing settings page, Stories 5.1/5.4/5.5, shown as its own view and no longer as a card on the main page), the theme toggle and sign-out

**Given** the plan workspace of Story 3.1
**When** shown next to this sidebar on a desktop width
**Then** it keeps the layout of layout-preview.html: the status panel (current and next step, timeline) is a column beside the chat, side by side, never stacked above it; only on a narrow screen does the status panel become the compact header above the chat that Story 3.1 defines; the workspace and the chat card fill the full height of the window (the chat card is not shorter than the viewport)

**Given** the sidebar
**When** the user is on any view
**Then** every navigation and global action lives in it and nowhere else: "New ideas", "Generate new ideas" (with its disabled/limit states from Story 2.11), "Review your intake answers", the plan and bookmarked lists, Settings; there is no "Back to ideas" button or floating link in the page content, and the ideas view no longer has its own generate button or intake link (the progress bar and messages of a running generation stay in the ideas view)

**Given** a normal desktop screen
**When** the app is shown
**Then** the sidebar is a fixed, docked column that the user can collapse and expand with a toggle (collapsed = a slim rail or hidden, the choice is remembered across reloads), and opening it never blurs, dims or covers the page content

**Given** a narrow/mobile screen
**When** the sidebar is shown
**Then** it collapses to a menu button that opens the sidebar as an overlay over the content with a light, non-blurring backdrop and a close control, with no horizontal page scroll

**Given** the page is reloaded
**When** a view or plan was active
**Then** the same view or plan is shown again (kept in the URL or stored locally; never lost on reload)

### Story 2.10: Direct Paths for Button-Triggered Flows

As a user,
I want saving my answers, generating ideas and creating a plan to feel fast,
So that the app is pleasant to use and does not waste time or money on steps it doesn't need.

**Scheduling:** required, built before Stories 2.9, 3.3 and Epic 4, because it changes how every later flow is wired.

**Acceptance Criteria:**

**Given** the intake form, the "Generate new ideas" action and the plan creation after a selection
**When** the user triggers them
**Then** each API route calls its tool handler directly (the same handler the agent's tool wraps) with no agent loop around it (AD-4 amendment); free-form chat turns keep the agent loop and still call the same tools, so tool-calling behaviour and the Story 6.2 evals are unchanged

**Given** an intake submit
**When** it is saved
**Then** the fields are stored immediately and the user sees "saved" without waiting for a model; the failure pattern is classified by one direct structured-output call to a fast internal model (never in the user-selectable registry), in parallel with one AD-11 moderation of the free-text answer; ideas are never generated before the classification has finished; a flagged answer is rejected with the existing neutral message; no waiting hint such as "this can take up to half a minute" is shown anywhere in the intake flow - the user sees "saved" immediately, and any short remaining wait (the classification before ideas start) shows only the normal progress display

**Given** server-authored trigger text (the messages the routes used to send to the agent)
**When** the flows run
**Then** no moderation call is made on it, while every piece of user-written text is still moderated (AD-11) and every model-written text shown to the user is still output-moderated and guilt-language checked where AD-12 applies

**Given** each flow
**When** measured on one real run before and after
**Then** the report shows both numbers per step honestly, with targets of: intake "saved" within 1 s, classification within about 3 s, plan creation within about 20 s, idea generation within about 45 s for the default batch; a miss is reported as a miss, never hidden by raising timeouts

**Given** the change
**When** done
**Then** all existing acceptance criteria of Stories 2.1, 2.2, 2.5, 3.1 still pass unchanged, and the ones touching `agent.invoke` in the routes are updated to the direct handler calls

### Story 2.11: Search Budget Guard

As the app owner,
I want web-search usage kept small and predictable,
So that the free search credits last through development and the demo.

**Acceptance Criteria:**

**Given** the `web_search` tool (AD-5)
**When** it is called
**Then** a thin wrapper forces the cheapest search settings (basic depth, no raw page content, a small fixed number of results per search) regardless of what the nested model asks for, and the settings live in one config constant

**Given** one `generate_ideas` run
**When** it searches
**Then** a hard cap on the number of searches per run applies (one tunable constant, default 6), the run continues with what it has once the cap is reached, and the cap hit is logged; no quality rule (Stories 2.2/2.5) is weakened to compensate

**Given** an identical normalized query by the same user within a configurable window (default 24 h)
**When** it is searched again
**Then** the stored, already moderated result is reused; results are never shared across users, a changed intake invalidates them, and every reused result has passed moderation (AD-7/AD-11)

**Given** development and tests
**When** the environment sets the search mode to "stub"
**Then** `web_search` returns fixed canned results with no network call and no credit use; "live" (the default in production and the demo) behaves as normal; the mode is one env variable documented in `.env.example`, validated at startup (CLAUDE.md)

**Given** a user who has used up their idea generations for the day
**When** they press a generate action
**Then** the app shows a clear, localized (DE/EN) message that says what happened, for example "You've reached today's limit of N idea generations. It resets tomorrow at HH:MM." - plainly a limit, never worded like an error or an outage - and the button is disabled with that explanation instead of failing after a click; the existing ideas stay fully usable

**Given** the app's total daily search budget is used up
**When** any user presses a generate action
**Then** the message says so honestly and differently ("Today's shared search budget of the app is used up. New ideas are available again tomorrow."), the existing ideas stay usable, and nothing is charged beyond the budget

**Given** the limits
**When** configured
**Then** the per-user generations per day and the shared daily search budget are separate env constants with generous defaults for development (so normal testing never hits them) and documented lower values for the live demo; the counters live in Postgres and reset at a fixed time; and a developer can lower them to see the messages on purpose (documented in the README, Story 7.1)

**Given** a generation in which every web search fails (service unreachable, key or quota rejected)
**When** the first round of searches comes back with only errors
**Then** the run stops at once, without retries or draft writing, and the user sees a clear localized message that the search service is unavailable or its limit is reached; existing ideas stay usable and no count is spent against the user's daily generations

**Given** the guard
**When** a live run is measured before and after
**Then** the report shows searches per run and credits used for both, honestly

### Story 2.12: Smooth Generation Flow

As a user,
I want the move from my answers to my ideas, my plan and a translated page to feel continuous,
So that I never see a button flicker, a second wait or an abrupt text swap.

**Acceptance Criteria:**

**Given** the user presses Save on the intake form for the FIRST time (no intake stored yet, e.g. right after the first sign-in)
**When** the save is accepted
**Then** the ideas view opens at once with generation already in progress: the generate button is shown in its disabled/transparent state and the progress bar is visible from the first frame (never an enabled green button that is then pressed by code); saving, classifying and generating are one continuous progress (stage text changes, the bar never restarts), and generation starts as soon as the intake is stored, without the user waiting on a separate save screen

**Given** an intake already exists and the user edits it via "Review your intake answers"
**When** they press Save
**Then** it only saves (with a short confirmation): no redirect to the ideas view, no idea generation, no progress bar, and the "Review your intake answers" entry stays active in the sidebar as before

**Given** the plan is being created after the user confirms a selection (Stories 2.8/3.1)
**When** it is generated
**Then** the workspace shows the same determinate progress bar and stage text as idea generation, from the first frame

**Given** the UI language is switched and cards need translating
**When** the translation runs
**Then** no "is being translated" text appears; the translated text parts of the cards (title, rationale, demand note, growth path) show a soft blur/shimmer placeholder for the duration, then crossfade to the new language; the card layout does not jump; the effect respects reduced-motion settings and the cards stay accessible (`aria-busy` while translating)

**Given** the draft plan is ready for review (Story 3.2 modify/reject/confirm panel)
**When** it is shown
**Then** it opens as a modal card over the page, the same dialog pattern as the "select this idea" confirmation (Story 2.8), with a backdrop; it does not expand inline and does not push the status column and chat down; confirm, edit and regenerate stay inside it, and closing it by confirm or regenerate returns to the workspace; step descriptions render as one bullet each (no doubled bullet marker); Escape/backdrop behaviour and focus handling match the existing dialog

**Given** any of the transitions above
**When** a request fails
**Then** the existing neutral error and retry behaviours stay unchanged

### Story 2.13: Chat Scroll Behaviour

As a user,
I want a long chat to scroll the way Claude's does,
So that I can read the whole answer to my question without scrolling by hand.

**Acceptance Criteria:**

**Given** a chat (discovery or plan thread) whose messages still fit comfortably in the visible area (the content is less than about 70% of the visible height before the new message)
**When** the user sends a message
**Then** the chat behaves normally: the new message and the reply are appended and the view only follows the newest content as needed; the user's message is NOT pushed to the top

**Given** a chat (discovery or plan thread) that is almost full (the new message plus room for its reply would no longer fit without scrolling)
**When** the user sends a message
**Then** the view scrolls so the user's new message sits at the top of the visible area and the assistant's reply appears below it, fully visible as it arrives, with spare room after it (a bottom spacer of about one viewport so the reply is never cut off by the input)

**Given** the assistant's reply is longer than the visible area
**When** it arrives
**Then** the user's message stays at the top, the start of the reply is what the user sees first, and the user scrolls down to read the rest; the view never jumps to the end of the reply on its own

**Given** the user has scrolled up manually to read earlier messages
**When** a reply arrives
**Then** the view is not moved against their will

**Given** reduced-motion settings
**When** the scroll happens
**Then** it is instant instead of animated; the chat input is never covered and keeps working as before (Story 1.3/5.3)

### Story 2.6: Faster Idea Generation (optional)

As a user,
I want idea generation to finish noticeably faster,
So that the first-use wait is short without lowering the quality of the ideas.

**Scheduling:** required (raised from optional on 2026-11-17 after measured runs of 35-60 s for 2 ideas, 6 s per card translation and 10-11 s per plan); built together with Story 2.4 in one session because both work in `generate_ideas`.

**Acceptance Criteria:**

**Given** the current generation path
**When** this story starts
**Then** one real run is instrumented first and the time per step (query planning, each search, moderation, the writing call, validation, DB write) is reported before anything is changed

**Given** the measured steps
**When** latency is reduced
**Then** only waiting is removed: no fewer searches, no fewer results per search, no weaker moderation, no weaker validation or source rules, no fewer retries for transient errors

**Given** the query-planning step
**When** it is sped up
**Then** options such as a small fast helper model (internal, never in the user-selectable registry) or reusing moderated, cached search results are evaluated against the measurement, and the chosen one is documented with its before/after timing

**Given** any speed-up that reuses cached results
**When** a request runs
**Then** results are never shared across users, a changed intake invalidates them, and every reused result has already passed moderation (AD-7/AD-11)

**Given** a typical successful run
**When** measured before and after
**Then** the report shows both numbers honestly, with a target of under about 30 s on average for the default batch, and a run that misses the target is reported as such, not tuned by raising timeouts

**Given** the three sequential nested-agent model calls measured at 15-18 s each, the per-card translation (about 6 s) and the plan creation (about 10-11 s)
**When** the step timings are reviewed
**Then** each is examined for shorter model output (fewer or tighter fields, fewer steps in a first plan draft), merging sequential calls, a faster internal model for translation, and not running the translation call for a language the user has not switched to unless it is cheap; the chosen changes are listed with before/after timing, no hard rule is weakened, and each card fetching `/api/intake` separately is replaced by one shared value

**Given** a measured real run of 100-155 s for a 2-idea batch after the first speed round (user runs, 2026-11-18), against a 35-60 s earlier baseline
**When** the second speed round starts
**Then** it first logs, per attempt, the elapsed time and the reason an attempt was rejected or retried, and reports which of "retries" or "one long writing call" explains the extra time before changing anything; then it removes that cause, including writing each idea in its own parallel model call (wall time about one idea's time instead of all ideas' sum) with the cross-idea soft rules (variety, domain spread) checked afterwards and the hard rules unchanged per idea; the target is a typical run under about 40 s and never above about 60 s; a miss is reported as a miss

**Given** the speed-up
**When** done
**Then** the story's report lists the quality checks (Story 2.2 and 2.5 ACs) that still pass unchanged

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
**Then** it runs lazily - only on first selection or re-selection with no existing plan, never eagerly for every idea (AD-13)

**Given** a plan is created for the first time
**When** that happens
**Then** a dedicated plan thread is created for it (AD-18) - distinct from the discovery thread and from any other plan's thread

**Given** the plan workspace UI (layout decision, final - one workspace component shared by this story, Epic 4, and Stories 5.2/5.3)
**When** built
**Then** it is a single unified screen (option A) - a status sidebar/header (current+next step, timeline) and a projection card alongside one chat thread for check-ins, follow-up questions, and messages with their token/cost line and thumbs - never split into separate "Overview" and "Chat" tabs

**Given** that same unified layout
**When** viewed on a narrow/mobile screen
**Then** the status sidebar collapses into a compact header above the chat rather than disappearing or requiring a separate screen

**Given** the workspace is a shared component built across several stories
**When** this story builds it
**Then** this story owns the workspace **shell and its extension points**, and later stories fill the extension points without restructuring the shell. Ownership (proposed paths under `web/src/features/plan-workspace/`, to be confirmed against the scaffold from Story 1.1):

| Part of the workspace | Built by | Notes |
|---|---|---|
| `PlanWorkspace` layout (sidebar/header + chat column), narrow-screen collapse, route | **3.1** | Only 3.1 edits the layout file; no later story changes the layout |
| `StatusPanel` (current + next step via `get_current_step`, timeline) | **3.1** | 4.1 adds the start/complete step actions and the energy/status check-in control as its own components rendered by `StatusPanel`/the chat input, not by editing the panel's layout |
| `ChatThread` / `ChatMessage` (message list, text input, error/neutral-notice rendering) | **1.3** | Built directly in Story 1.3 as the shared component; 3.1 extends it and never replaces it. Also used by the discovery thread |
| Free-form follow-up questions in the plan thread, bound to the plan's own thread | **3.1** | Wiring on top of 1.3's `ChatThread`, not a new chat component |
| `ChatMessage` footer extension point (an ordered list of footer items rendered beneath each agent message) | **3.1** (empty by default; an additive extension of 1.3's component) | Items below are registered into it; none require editing `ChatMessage` itself |
| Footer item: token count + estimated cost line | **5.2** | Own component `MessageCost`; persistence and cost math in `api/` |
| Footer item: thumbs up/down + optional comment | **5.3** | Own component `MessageFeedback`; must never disable `ChatInput` |
| Chat input extension point (extra input modes beside the text field) | **3.1** (empty by default) | |
| Input mode: voice record + editable transcript | **4.3** | Own component; typed text stays available |
| Projection card extension point (a slot in the sidebar/header) | **3.1** (renders nothing until 4.4) | |
| Projection card content | **4.4** | Own component, filled via `get_projection` |
| Draft review / confirm / modify / reject panel (shown while the plan is `draft`) | **3.2** | Own component, rendered in the workspace's main area for a draft plan; 3.1 renders the draft read-only |
| Plan switcher (activate a different bookmarked idea's plan) | **3.3** | Own component, outside the layout file |

**Given** the shared `ChatMessage` component built in Story 1.3
**When** this story needs a footer extension point, a chat-input extension point and the workspace around it
**Then** it extends 1.3's component additively (new props/slots, no replaced or duplicated message component) and keeps every Story 1.3 behavior working

**Given** Stories 5.2 and 5.3 attach to chat messages
**When** they are built
**Then** they depend on this story's `ChatMessage` footer extension point (UI) in addition to their own backend work - they never create a second message component or a parallel chat screen

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
**Then** a lightweight energy/status input is requested before any task-related ask (`record_check_in`); the energy question is asked at most once per calendar day per user across ALL plans (not per plan, not again on a plan switch), as a small dismissible pop-up over the window (not a permanent control in the plan's status column); dismissing it counts as answered for the day with no energy stored and no nagging; the answer is stored against the plan open at that moment, and "already answered today" is computed from the user's check-ins across plans

**Given** the user starts a step
**When** `start_step` is called
**Then** a distinct start-of-action acknowledgment fires, separate from completion; it appears as a short, motivating, non-punitive assistant message in the plan chat (written in the user's language, no streaks/points, AD-12 guilt check applies), produced by one direct model call from the start route (AD-4 amendment), not just a hidden button, and consecutive start messages must not repeat each other (no repeated opener such as "You've started ... that's a meaningful step ... keep going at your own pace"): vary wording and length, sometimes just one short sentence; the status panel shows the day label above the current step's title (not below its description), and the following step is labelled "Next step" (DE/EN), not "Next (locked)"

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

**Given** the check-in UI
**When** built
**Then** the energy/status control and the start/complete step actions are their own components plugged into the workspace built in Story 3.1 (status panel and chat input) - this story does not edit the workspace layout

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

**Given** the voice recorder and transcript-review UI
**When** built
**Then** they are an input mode registered into the chat input extension point from Story 3.1, in their own component - the workspace layout and the text input are not edited by this story

**Given** this story introduces the voice transcription credential (`gpt-transcribe`)
**When** it is built
**Then** the project's environment-variable rule applies (see Additional Requirements): the variable is added to `.env.example` as a placeholder (even if it is the same provider key as an existing variable, the story says so explicitly) and to the startup check in `src/config/env.ts`, and the completion report lists which key the user must fill in

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

**Given** the projection card
**When** shown for a plan with a next step
**Then** it always shows the line "at this pace · unlocks: <the specific unlocked opportunity>" (DE equivalent) under the estimate; it is a required part of the card and is never removed as a duplicate of the status column's next-step region (only omitted when there is no next step, i.e. on the last step or a completed plan)

**Given** the projection card
**When** built
**Then** it fills the projection-card extension point of the workspace from Story 3.1 as its own component - the workspace layout is not edited by this story

**Given** the projection
**When** displayed
**Then** the income estimate reads the currency value from the `user_settings` row created in Story 1.2 (EUR by default; not dependent on Story 5.5's UI control existing yet), using Story 2.2's shared money helper - converted from the baseline rate's sourced currency using the configured rate and labeled an estimate if a conversion occurred (AD-27), formatted via `Intl.NumberFormat` under the active UI language's locale

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

**Given** the registry's contents
**When** seeded
**Then** it holds exactly three user-selectable chat entries, all routed via OpenRouter: `openai/gpt-6-luna` (default), `google/gemini-3.8-flash` and `anthropic/claude-haiku-4.5` (`mistralai/mistral-large-4-0` was removed: too slow, it repeatedly hit the fallback timeout); no other model is selectable (not the eval-only `anthropic/claude-sonnet-5.5`, not the `deepseek/deepseek-v4.1-flash` judge, not the moderation or transcription models)

**Given** the registry's pricing data
**When** displayed anywhere in the app
**Then** it is read from the registry, never a hardcoded value in application code

**Given** a user's settings
**When** saved
**Then** they persist per user in the `user_settings` table created in Story 1.2 (this story adds no table and no migration for it), surfaced through an actual settings screen - not just a backend default

**Given** the `model` column created in Story 1.2 (which until now means "use the default model")
**When** this story completes
**Then** it holds a model-registry id validated against the registry introduced here, and an unknown or no-longer-selectable id resolves to the default model rather than erroring

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
**Then** it reads the currency value from the `user_settings` row created in Story 1.2 (EUR by default; this story doesn't depend on Story 5.5's UI control existing yet), using Story 2.2's shared money helper - the registry price itself is natively USD (AD-21/AD-27), converted to EUR using the configured rate (and labeled an estimate) only when the stored currency is EUR; USD needs no conversion

**Given** the turn
**When** it completes
**Then** the token count, the model id actually used, and a snapshot of that model's price at the time are all persisted per message in Postgres as an integer minor-unit amount plus currency code - not a float, not just a final dollar figure

**Given** a typical chat turn that costs a fraction of a cent
**When** the cost is stored and displayed
**Then** it is never rounded to a misleading "0.00": the amount is stored as an integer in micro-units (millionths of the currency unit, still an integer, never a float, AD-27) and the shared money helper formats it with enough decimals to be meaningful (for example "€0.0014 (est.)"; an amount of exactly zero tokens of cost shows nothing special); the registry price and conversion rate stay the single source

**Given** a model with no price in the registry
**When** cost would be computed
**Then** the display shows the token count only, with no cost figure - it never guesses or shows a misleading $0

**Given** a persisted cost/token value
**When** the user reloads the page
**Then** the same values are shown, unchanged

**Given** the cost line UI
**When** built
**Then** it is a `MessageCost` footer item registered into the `ChatMessage` footer extension point built in Story 3.1 - this story builds the cost computation, persistence and that one component, and does not create or restructure the message or workspace components

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

**Given** the thumbs/comment UI
**When** built
**Then** it is a `MessageFeedback` footer item registered into the `ChatMessage` footer extension point built in Story 3.1, alongside (not inside) Story 5.2's `MessageCost` - this story does not create or restructure the message or workspace components

### Story 5.4: UI Language Selection

As a user,
I want to switch the app's interface between German and English,
So that I can use the app comfortably regardless of which language I prefer for the UI itself.

**Acceptance Criteria:**

**Given** the settings screen
**When** the user picks German or English
**Then** `set_ui_language` persists the choice in the `ui_language` column of `user_settings` (created in Story 1.2), and the whole UI (via the i18n layer, Story 1.4) switches immediately

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
**Then** `set_currency` persists the choice in the `currency` column of `user_settings` (created in Story 1.2, AD-27), and every displayed amount re-renders in the newly chosen currency immediately

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
**When** judging any of the 4 evaluated models' trajectories (the 3 registry entries plus the eval-only model)
**Then** they use two fixed judge models, `google/gemini-3.8-flash` and `deepseek/deepseek-v4.1-flash`, each pinned by exact id in config; `deepseek/deepseek-v4.1-flash` is a judge only and never appears in the user-facing model list, while `google/gemini-3.8-flash` is also a user-selectable registry entry (a user's selection never affects which models judge)

**Given** the judge models
**When** disclosed in the report (Story 6.3)
**Then** it is noted as a known limitation that `google/gemini-3.8-flash` is both a judge and an evaluated registry entry (a judge scoring its own model's trajectories), and the report states which judge scored which model

**Given** the suite's trajectory-accuracy results
**When** scored
**Then** an explicit 80% tool-call-accuracy target applies **per model** (not an aggregate average) as a single tunable constant, and the report always shows the actual measured number per model, even below 80% - never suppressed or rounded up

**Given** the 3 model-registry entries (AD-20) and the eval-only model `anthropic/claude-sonnet-5.5`
**When** the suite runs
**Then** it runs at least once against each of the four, not just whichever model is active during development

**Given** `anthropic/claude-sonnet-5.5`
**When** configured
**Then** it exists only in the eval configuration, is not in the user-selectable model registry, never appears in the settings dropdown, and is used only by on-demand evals

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
**Then** it also includes known limitations (cross-referencing Epic 7's Story 7.4, plus the judge/registry-overlap note (`google/gemini-3.8-flash` as both judge and registry entry) from Story 6.2) and the eval run's own estimated cost (using the CAP-8 token/cost mechanism against the actual calls the eval run itself made)

**Given** the generated report
**When** published
**Then** it is linked from the README (Epic 7)

**Given** the same report run
**When** the script completes
**Then** it also emits a machine-readable JSON summary with the same facts (per-model accuracy, safety pass/fail, run date, judge models, run cost, limitations) - this is the source the public Quality & Decisions page (Story 7.5) reads, so that page's content is generated, not hand-copied

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
**Then** it walks through at least one full user journey end to end (intake -> ideas -> select -> activate plan -> check in -> see projection)

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

**Scheduling: optional for the live demo on 2026-11-20; always sequenced last.** The demo runs local-only (NFR6 and the "local-only first" decision are unchanged). All ACs below stay as written and apply whenever this story is built; nothing is removed or downgraded, it simply does not gate the demo, and no other story waits on it.

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

**Given** this story introduces deployment secrets (the Neon connection string, the production OAuth redirect/origin settings, and moving every existing key into Secret Manager)
**When** it is built
**Then** the project's environment-variable rule applies (see Additional Requirements): any new variable is added to `.env.example` as a placeholder and to the startup check in `src/config/env.ts`, the startup check works the same against Secret Manager-provided values, and the completion report lists which secrets the user must create or fill in

### Story 7.4: Known Weaknesses, Improvement Suggestions, and Grading Traceability

As a grader/collaborator,
I want a clear-eyed account of the project's known weaknesses and a table mapping each grading criterion to its evidence,
So that I can assess the work fairly without having to hunt through the codebase myself.

**Acceptance Criteria:**

**Given** the finished build
**When** the "Known Weaknesses & Improvement Suggestions" section is written
**Then** it honestly lists real limitations (e.g. CAP-4's best-effort v1 scope, voice v1's transcript-review step vs. deferred speech-to-speech, lazy-only missed-check-in detection with no proactive notifications, Mistral Moderation 2's adoption still pending the user's own eval-set testing, and `google/gemini-3.8-flash` serving as both an eval judge and a selectable registry entry) and what would improve each

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
**Then** it reads the JSON summary Story 6.3's report script emits (tool-call accuracy per model, safety pass/fail against the 100% bar, run date, judge models, run cost, limitations) - not a hand-copied snapshot

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
