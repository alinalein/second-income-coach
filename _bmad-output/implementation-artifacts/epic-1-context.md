# Epic 1 Context: Sign In & First Contact

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Prove the whole stack works together end to end, as thinly as possible, before any capability-specific feature is built on top of it: a user can sign in with Google and exchange at least one safe, moderated message with the agent. This epic also lays every foundation later epics build on rather than re-building: the themed UI shell (shadcn/ui + glass style, light/dark mode, teal accent, contrast-verified), the i18n layer (German/English), the auth/session model, the core agent loop with moderation and observability, and the README skeleton every later epic appends to.

## Stories

- Story 1.1: Project Scaffolding & Themed UI Shell
- Story 1.2: Google Sign-In
- Story 1.3: Core Agent Loop with Moderation & Observability
- Story 1.4: Internationalization Foundation & Bilingual Replies

## Requirements & Constraints

- Greenfield custom build (no starter/scaffold template): TypeScript, Node, Express backend + React frontend, with shared Zod schemas imported by both sides and TypeScript types derived via `z.infer` (never hand-written separately).
- Light mode is the default theme; dark mode is available via a toggle whose choice persists across sessions; text contrast must be at least 4.5:1 (WCAG AA) in both themes.
- All user input and all agent output must pass through a moderation check (Mistral Moderation 2) before being processed or shown — mandatory, not optional.
- Auth gates the entire session from first use — there is no unauthenticated capability, including the first agent message.
- Standard request/response delivery only — no streaming — for every user-facing interaction.
- Every user-facing string goes through the i18n layer from this epic onward; no hardcoded text ships in either language, ever.
- A LangSmith trace is recorded for every agent interaction (observability baseline).
- Web/API security baseline applies to every route from this epic forward: parameterized DB access, security headers, same-origin CORS, rate limiting, request/message size limits, CSRF defense, and log hygiene (no raw user message text in any log).
- README must exist with at least a basic project description and setup skeleton, to be appended to by every later epic.

## Technical Decisions

- **Agent runtime:** one LLM agent (no multi-agent/orchestrator) via LangChain's `createAgent` on the LangGraph.js runtime. Its built-in hooks (`beforeModel`/`wrapToolCall`/`afterModel`, etc.) are the only cross-cutting mechanism.
- **Moderation hook placement:** Mistral Moderation 2 runs at `beforeModel` (jailbreak → reject turn with a safe generic response + log; PII → clean/redact, log, don't reject) and `afterModel` (unsafe output → replace with a safe fallback + log). The `wrapToolCall` hook around `web_search` is introduced later with Epic 2, not this epic.
- **Resilience:** retries/timeouts/caching live at the LangGraph node level via `setNodeDefaults`, never duplicated in middleware; a failed call after retries shows the user a clear error without crashing.
- **Threads/checkpointing:** one LangGraph thread per conversation, derived from the authenticated session; thread state is checkpointed to Postgres via `PostgresSaver`. A new conversation gets a new thread (the discovery-thread-per-user vs. plan-thread-per-plan distinction is exercised starting in Epic 2/3).
- **Message schema:** the shared Zod schema for a user message enforces a maximum length, rejected at the schema boundary before reaching the model — never silently truncated.
- **Auth:** Google OAuth (`google-auth-library`); first sign-in creates a Postgres user row keyed to the Google identity. Session is a server-side `HttpOnly`/`Secure`/`SameSite=Lax` cookie — never a bearer token or anything exposed to client JS.
- **CSRF:** `SameSite=Lax` plus an Origin-header check on every state-changing request is the full CSRF defense — no separate CSRF-token mechanism.
- **Postgres access:** all reads/writes from plain-code tools go through Drizzle ORM (parameterized by construction, no raw SQL).
- **Express hardening:** `helmet` for security headers; `cors` restricted to the app's own origin (frontend served same-origin from the same Express service; Vite dev proxy locally) — never a wildcard; `express-rate-limit` on every route, stricter on the (later) LLM-backed tools than on plain reads; a configured max request-body size enforced before further processing.
- **Frontend XSS defense:** no `dangerouslySetInnerHTML` anywhere; enforced by an ESLint `react/no-danger` rule that fails the build.
- **i18n:** `react-i18next`, translation keys under `src/locales/<language-code>/<namespace>.json`, one namespace per feature area. Fixed system texts introduced in this epic (jailbreak-rejection message, model-failure error, unsafe-response fallback) must ship with both German and English keys from the start.
- **Reply-language matching:** the agent's reply language is derived per message from what the user wrote, independent of the UI language setting (not configurable yet — that control arrives in Epic 5); re-evaluated every message, not locked to the thread's first message.
- **Personality rendering:** tone (formal/friendly/terse, configured later in Epic 5) and reply-language are handled by the same prompt-construction step, not separate per-language personality definitions — relevant here because Story 1.4 is where that single-step pattern is established.
- **UI visual system:** shadcn/ui + shadcn-glass-ui glass aesthetic; teal accent (final choice after a contrast-verified emerald/teal/amber/ocean comparison) — light `--primary:#0f766e`/`--primary-foreground:#ffffff`, dark `--primary:#2dd4bf`/near-black foreground; neutral background/card/foreground/border tokens are shared regardless of accent. Accent color is applied only to buttons, badges, progress fill, focus rings, and banners — never whole surfaces. Muted badge labels use `--foreground`, not `--muted-foreground`, to keep contrast passing.

## UX & Interaction Patterns

- Theme toggle (light default, dark via explicit toggle) with the choice persisted across reloads/sessions.
- No fixed UI layout is mandated for this epic beyond the shell itself — the card, form, and unified-screen layout decisions documented for later epics (intake, ideas, plan workspace) don't apply here.

## Cross-Story Dependencies

- Story 1.1 (UI shell, i18n plumbing scaffolding, Drizzle/Express/security baseline) must exist before 1.2 and 1.3 can be wired into a working app shell.
- Story 1.2 (auth/session) must exist before 1.3, since the agent loop is only reachable by a signed-in user and the thread id is derived from the authenticated session.
- Story 1.3 produces the fixed system texts (jailbreak-rejection, model-failure, unsafe-fallback messages) that Story 1.4 must retrofit with German/English translation keys — 1.4 depends on 1.3's text existing first.
- Everything in this epic is a foundation dependency for Epics 2-5: the UI shell, i18n layer, auth/session model, and moderated agent loop are reused, not rebuilt, by every later epic's own screens and capabilities.
