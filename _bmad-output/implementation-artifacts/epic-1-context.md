# Epic 1 Context: Sign In & First Contact

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Prove the whole stack works together end to end, as thinly as possible, before any capability-specific feature is built on top of it: a user can sign in with Google and exchange at least one safe, moderated message with the agent. This epic also lays every foundation later epics build on rather than re-building: the themed UI shell (shadcn/ui + glass style, light/dark mode, teal accent, contrast-verified), the i18n layer (German/English), the auth/session model (including the `user_settings` row every later settings feature extends), the core agent loop with moderation and observability, and the README skeleton every later epic appends to.

## Stories

- Story 1.1: Project Scaffolding & Themed UI Shell
- Story 1.2: Google Sign-In
- Story 1.3: Core Agent Loop with Moderation & Observability
- Story 1.4: Internationalization Foundation & Bilingual Replies
- Story 1.5: Agent Progress Display & Markdown Rendering
- Story 1.6: Glass Style & Contrast Re-verification

## Requirements & Constraints

- Custom greenfield build, no starter/scaffold template: TypeScript 6.0.3 (deliberately not 7.x — typescript-eslint currently hard-errors on TS 7, revisit later), Node 26, Express backend + React 19.3.1 frontend, with shared Zod schemas imported by both sides and TypeScript types derived via `z.infer` (never hand-written separately).
- Light mode is the default theme; dark mode is available via a toggle whose choice persists across sessions; text contrast must be at least 4.5:1 (WCAG AA) in both themes.
- All user input and all agent output must pass through a moderation check (Mistral Moderation 2) before being processed or shown — mandatory, not optional.
- Auth gates the entire session from first use — there is no unauthenticated capability, including the first agent message or intake.
- Standard request/response delivery for the final answer — never streamed. The only exception (Story 1.5) is one narrow, turn-scoped SSE channel for progress-status events, never partial answer text.
- Every user-facing string goes through the i18n layer from this epic onward; no hardcoded text ships in either language, ever.
- A LangSmith trace is recorded for every agent interaction (observability baseline).
- Web/API security baseline applies to every route from this epic forward: parameterized DB access, security headers, same-origin CORS, rate limiting, request/message size limits, CSRF defense, and log hygiene (no raw user message text in any log).
- README must exist with at least a basic project description and setup skeleton, to be appended to by every later epic.
- Story 1.6 requirement: the glass style (UX-DR3) that Story 1.1 was accepted without must actually be applied, matching `layout-preview.html`, with contrast (UX-DR4) re-verified on the real translucent surfaces and the measured values recorded in that story's report.
- This epic introduces external credentials in two stories: Story 1.2 adds the Google OAuth client id/secret and the session secret; Story 1.3 adds the model provider key(s), the Mistral Moderation key, and the LangSmith key/project. Each is a placeholder in `.env.example` plus a named check in `src/config/env.ts`; each story's report must list exactly which keys the user needs to fill in.

## Technical Decisions

- **Agent runtime:** one LLM agent (no multi-agent/orchestrator) via LangChain's `createAgent` on the LangGraph.js runtime. Its built-in hooks (`beforeModel`/`wrapToolCall`/`afterModel`, etc.) are the only cross-cutting mechanism.
- **Moderation hook placement:** Mistral Moderation 2 runs at `beforeModel` (jailbreak → reject turn with a safe generic response + log; PII → clean/redact, log, don't reject) and `afterModel` (unsafe output → replace with a safe fallback + log). The `wrapToolCall` hook around `web_search` arrives with Epic 2, not this epic.
- **Resilience:** retries/timeouts/caching live at the LangGraph node level via `setNodeDefaults`, never duplicated in middleware; a failed call after retries shows the user a clear error without crashing.
- **Threads/checkpointing:** one LangGraph thread per conversation, derived from the authenticated session; thread state is checkpointed to Postgres via `PostgresSaver`. A new conversation gets a new thread (the discovery-thread-per-user vs. plan-thread-per-plan distinction is exercised starting in Epic 2/3).
- **Message schema:** the shared Zod schema for a user message enforces a maximum length, rejected at the schema boundary before reaching the model — never silently truncated.
- **Auth:** Google OAuth (`google-auth-library`); first sign-in creates a Postgres user row keyed to the Google identity, plus a `user_settings` row in the same transaction — a user row never exists without its settings row, and a pre-existing user missing one gets it created with defaults on next sign-in. Session is a server-side `HttpOnly`/`Secure`/`SameSite=Lax` cookie — never a bearer token or anything exposed to client JS.
- **`user_settings` table (created here, not later):** holds `currency` (EUR default), `personality`, `model`, and `ui_language` (English default). This story only creates the table/schema and seeds defaults; Stories 2.2, 4.4, and 5.2 read `currency` from it, and Stories 5.1, 5.4, and 5.5 add the settings screen and `set_*` tools on top of it — none of them creates or migrates this table.
- **CSRF:** `SameSite=Lax` plus an Origin-header check on every state-changing request is the full CSRF defense — no separate CSRF-token mechanism.
- **Postgres access:** all reads/writes from plain-code tools go through Drizzle ORM (parameterized by construction, no raw SQL).
- **Express hardening:** `helmet` for security headers; `cors` restricted to the app's own origin (frontend served same-origin from the same Express service; Vite dev proxy locally) — never a wildcard; `express-rate-limit` on every route, stricter on the (later) LLM-backed tools than on plain reads; a configured max request-body size enforced before further processing.
- **Frontend XSS defense:** no `dangerouslySetInnerHTML` anywhere; enforced by an ESLint `react/no-danger` rule that fails the build.
- **i18n:** `react-i18next`, translation keys under `src/locales/<language-code>/<namespace>.json`, one namespace per feature area. Fixed system texts introduced in this epic (jailbreak-rejection message, model-failure error, unsafe-response fallback) must ship with both German and English keys from the start.
- **Reply-language matching:** the agent's reply language is derived per message from what the user wrote, independent of the UI language setting (not user-configurable yet — that control arrives in Epic 5); re-evaluated every message, not locked to the thread's first message.
- **Personality rendering:** tone (formal/friendly/terse, configured later in Epic 5) and reply-language are handled by the same prompt-construction step, not separate per-language personality definitions — established here in Story 1.4.
- **Progress display (Story 1.5):** every status label comes from a real agent-loop transition (hook or tool-call boundary) via a fixed step-to-label registry — never from model text, never exposing an internal tool/hook name; unmapped steps fall back to one generic label. Delivered over one turn-scoped SSE connection. The final answer is released only after output moderation (and the guilt-language check where AD-12 applies), then revealed client-side with a typing effect over the already-safe text.
- **Markdown rendering (Story 1.5):** `ChatMessage` renders via a renderer that builds a React element tree with no raw-HTML passthrough — never `dangerouslySetInnerHTML`; the `react/no-danger` ESLint rule still applies.
- **Chat UI component:** the shared `ChatThread`/`ChatMessage` component (message list, text input, error/neutral-notice rendering) is built directly in Story 1.3; Story 3.1 later extends it additively (footer/input extension points) rather than replacing or duplicating it.
- **UI visual system:** shadcn/ui + shadcn-glass-ui glass aesthetic; teal accent (final choice after a contrast-verified emerald/teal/amber/ocean comparison) — light `--primary:#0f766e`/`--primary-foreground:#ffffff`, dark `--primary:#2dd4bf`/near-black foreground; neutral background/card/foreground/border tokens are shared regardless of accent. Accent color is applied only to buttons, badges, progress fill, focus rings, and banners — never whole surfaces. Muted badge labels use `--foreground`, not `--muted-foreground`, to keep contrast passing.

## UX & Interaction Patterns

- Theme toggle (light default, dark via explicit toggle) with the choice persisted across reloads/sessions.
- Story 1.5: during a turn the chat shows short, friendly, localized status labels (e.g. "Thinking…"); agent answers render a constrained Markdown subset (headings, lists, bold); all chat text (user messages, agent answers, system notices) uses one shared font size, with Markdown structure distinguished by weight and spacing only.
- No fixed UI layout is mandated for this epic beyond the shell itself — the card, form, and unified-screen layout decisions documented for later epics (intake, ideas, plan workspace) don't apply here.

## Cross-Story Dependencies

- Story 1.1 (UI shell, i18n plumbing scaffolding, Drizzle/Express/security baseline) must exist before 1.2 and 1.3 can be wired into a working app shell.
- Story 1.2 (auth/session) must exist before 1.3, since the agent loop is only reachable by a signed-in user and the thread id is derived from the authenticated session.
- Story 1.2's `user_settings` table is a forward dependency for Epic 2 (Story 2.2), Epic 4 (Story 4.4), and Epic 5 (Stories 5.1, 5.2, 5.4, 5.5) — none of those stories creates or migrates the table, only reads/extends it.
- Story 1.3 produces the shared `ChatThread`/`ChatMessage` component and the fixed system texts (jailbreak-rejection, model-failure, unsafe-fallback messages); Story 3.1 extends the component additively, and Story 1.4 must retrofit those texts with German/English translation keys.
- Everything in this epic is a foundation dependency for Epics 2-5: the UI shell, i18n layer, auth/session model, and moderated agent loop are reused, not rebuilt, by every later epic's own screens and capabilities.
- Story 1.5 depends on Story 1.3's `ChatThread`/`ChatMessage` component and Story 1.4's i18n layer (status labels need German and English keys) — sequenced after both. Each later tool-introducing story registers its own progress-label key, the same pattern as the env-variable rule.
