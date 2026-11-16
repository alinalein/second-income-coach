# Stack

Planned technical approach for Second Income Coach (CAP-1 through CAP-9).

## Agent shape

Single LLM agent with tool-calling via LangChain's `createAgent` (TypeScript, `langchain@1.5.18` / `@langchain/core@1.2.18`), running on the LangGraph.js runtime — an agentic loop where the model calls domain-specific tools, observes results, and iterates before producing a final response, not a single-shot chatbot. Not a multi-agent/orchestrator setup, by design.

## Application stack

- TypeScript
- Node
- React, with React Compiler enabled (`reactCompilerPreset` from `@vitejs/plugin-react`; peers `@rolldown/plugin-babel`, `babel-plugin-react-compiler`, `@babel/core`; babel plugin before react in Vite plugin order). Manual `useMemo`/`useCallback` to be reviewed and removed where the compiler now covers it.
- UI library: shadcn/ui + **`shadcn-glass-ui`** (unscoped npm package, v2.11.2+, 59 components, Tailwind v4 + React 19 compatible, drop-in with shadcn/ui, zero migration). **[VERIFIED 2026-11]** `npm install shadcn-glass-ui` - the older scoped package `@yhooi2/shadcn-glass-ui` is deprecated/renamed, do not install it. Covers all needed primitives: dialog, slider, tabs, chat/message surfaces, form inputs. Toast: shadcn/ui's own Toast is deprecated project-wide in favor of **Sonner** - use Sonner for any notice/banner (e.g. Story 5.1's provider-fallback notice), not a Toast component.
- **[CHOSEN, final] Accent color: Teal** - selected after a contrast-verified comparison across emerald/teal/amber/ocean (all four passed once corrected; teal picked as the final choice). Token set (one set of 4 vars, shared structure with shadcn/ui: `--primary`/`--primary-foreground`/`--accent`/`--accent-foreground`; neutral surface/background/foreground/muted/border tokens stay the same regardless of accent):
  - Light: `--primary: #0f766e` (teal-700 - NOT teal-600/`#0d9488`, which fails white-text contrast at 3.74:1), `--primary-foreground: #ffffff` (5.47:1 PASS), `--accent: #ccfbf1` (teal-100), `--accent-foreground: #0f766e` (4.86:1 PASS).
  - Dark: `--primary: #2dd4bf` (teal-400), `--primary-foreground:` near-black (e.g. `#121316`, NOT white - white on teal-400 fails at 1.86:1; dark text passes at 9.98:1), `--accent: #134e4a` (teal-900), `--accent-foreground: #5eead4` (teal-300, 6.41:1 PASS).
  - Accent colors apply only to buttons, badges, progress fill, focus rings, and the missed-check-in banner - never to whole surfaces/blocks (neutral background/card/border tokens are shared across any accent choice, confirmed in `layout-preview.html`).
  - Superseded by this entry: the earlier generic "green/emerald" language used before the comparison - emerald itself remains a verified-passing option but teal is what's actually chosen.
  - Mode unchanged: light is the default theme, dark via toggle, choice persisted (UX-DR1/UX-DR2).
  - **Neutral tokens (shared, identical regardless of accent - adopted from the palette check):** Light: `--background: #f7f7f8`, `--card: #ffffff`, `--foreground: #1f2937`, `--muted-foreground: #6b7280`, `--muted: #eef0f1`, `--border: #e2e2e4`. Dark: `--background: #121316`, `--card: #1c1d20`, `--foreground: #e9eaec`, `--muted-foreground: #9aa0a6`, `--muted: #232528`, `--border: #2c2e31`.
  - **Muted badges**: use `--foreground` (the main text color), never `--muted-foreground`, for their label text - `--muted-foreground` on `--muted` fails WCAG (4.22:1); `--foreground` on `--muted` passes comfortably (12.8:1+ both themes).
- TanStack Query for all frontend server-state fetching against the Node backend API.
- Zod schemas live in one shared location imported by both backend and frontend; TypeScript types are derived via `z.infer`, not hand-written separately.

## Tools

- **LLM-backed (generation only):** `generate_ideas`, `create_plan`
- **Plain-code (deterministic, read/write Postgres directly):** `submit_intake`, `set_idea_status`, `get_current_step`, `start_step`, `complete_step`, `record_check_in`, `get_projection`, `activate_plan`, `set_personality`, `set_model`, `set_ui_language`, `set_currency`, `record_feedback`

`submit_intake` persists CAP-1's intake fields, including a `failurePattern` argument typed as a Zod enum. Classification of the raw free-text "what's stopped you before" answer into that enum happens once, at intake time, as part of the top-level agent's normal reasoning when it constructs this tool call — not a separate LLM-backed tool. `create_plan` only ever reads the stored value, never reclassifies it. `set_idea_status` flips an idea between `selected`/`bookmarked`/`rejected` — a pure DB update.

`get_current_step` is also where missed check-ins get detected — **lazily**, the next time the app is opened: it compares the expected vs. actual last check-in date and triggers CAP-4's timeline auto-adjustment and neutral reset messaging right there. No scheduler or notification channel needed for v1; a background job with proactive reminders is a natural v2 addition.
- **MCP:** `web_search` (e.g. Brave Search/Tavily/Exa, via `@langchain/mcp-adapters` 2.0+), shared by `generate_ideas` and `get_projection`'s baseline-rate sourcing

Only `generate_ideas` and `create_plan` are LLM-backed; every tool that mutates step/check-in/plan/activation state is plain, deterministic code — never a nondeterministic LLM call.

## Idea & plan lifecycle (CAP-2/CAP-3/CAP-6)

- **Idea status:** `suggested` (one of the 5) → `selected` | `bookmarked` | `rejected`. A rejected idea is removed from the visible list; bookmarked ideas remain available to activate later.
- **Plan status:** `draft` (produced by `create_plan`) → `active` | `paused`. Only one plan may be `active` at a time. `activate_plan` is the human-in-the-loop step: it pauses graph execution via LangGraph.js's `interrupt()` / `Command(resume=value)` pattern (createAgent also exposes this directly as human-in-the-loop middleware with an `interruptOn` property — no extra dependency needed) and surfaces the draft for the user to confirm, modify, or reject. Confirm → plan becomes `active`, any previously active plan becomes `paused` (not deleted). Reject → feedback routes back into `create_plan` for a revised draft. Switching to a paused plan resumes it rather than regenerating it.

## Internationalization / i18n (CAP-7/CAP-10)

**[VERIFIED 2026-11]** Library: **`react-i18next`** - the standard safe default for non-Next.js React+Vite projects, largest ecosystem, and matches the "translation keys" approach (named JSON keys) rather than source-string extraction (Lingui) or typed-function extraction (Paraglide-JS), both of which were considered and ruled out for this reason.

- Translation files live under `src/locales/<language-code>/<namespace>.json` - e.g. `src/locales/de/common.json`, `src/locales/en/common.json` - one namespace per feature area, loaded at app init.
- Established from Story 1.1 onward: no hardcoded user-facing string anywhere, in either language.
- Fixed system texts requiring both-language entries from day one: the neutral re-entry message (CAP-4), error messages (Story 1.3), acknowledgment messages (CAP-4), and the key-missing fallback notice (CAP-7).
- UI language: persisted per user in `user_settings` (same table as personality/model, AD-20), defaults to **English** (not browser-detected).
- Currency: persisted per user in `user_settings`, EUR or USD, defaults to **EUR**. Covers both CAP-8's cost display and CAP-2/CAP-5's income projections/idea budgets - a single setting, not inferred from UI language and not separate per-feature. See the dedicated Currency section below for the full design.
- Chat reply language (CAP-10) is a **separate** mechanism from UI language - the agent determines which language to reply in per-message from what the user actually wrote (or, for voice, the language detected by `gpt-transcribe`), not from the UI setting. The two can differ at any time (e.g. UI in English, chatting in German).
- Personality (CAP-7) is language-aware: the formal/friendly/terse tone must render correctly in both languages - this is a prompt-construction detail (the system prompt carries both the personality instruction and the detected/target reply language), not a separate per-language personality definition.
- **Guardrails in German**: Mistral Moderation 2 is natively multilingual, explicitly trained on German (11 languages total) - no additional moderation work needed beyond adding German test cases (`evals.md`). The guilt/streak-language check (AD-12) is a bespoke prompt-based check, not Mistral Moderation - it needs German example patterns added to its test coverage, since its correctness isn't guaranteed by a vendor's multilingual training the way Mistral's is.
- **Voice language handling**: `gpt-transcribe` supports a `languages` hint parameter (ISO-639-1 codes) to narrow detection, or full auto-detect if omitted. Decision: pass `languages: ["de", "en"]` as a hint (narrows to the app's two supported languages without forcing either) and capture the detected language from the response, passed downstream so the agent's reply uses that same detected language - consistent with the text-based reply-matching rule above.
- **Currency/number/date formatting**: native `Intl.NumberFormat`/`Intl.DateTimeFormat` (no library needed), locale-aware. The underlying formatting mechanism is settled; the currency choice itself (fixed EUR vs. user-selectable, independent of UI language) is an open product question - see SPEC.md's Open Questions, asked directly to the user.

## Quality & Decisions page (CAP-11)

A public, unauthenticated, read-only page - the one deliberate, narrowly-scoped exception to AD-17's auth requirement (AD-28). Three sections, each **generated from an existing source, never hand-copied** (AD-29):

- **Evaluation Results**: reads a machine-readable JSON summary that the eval report script (Story 6.3) emits alongside its human-readable markdown/HTML report - tool-call accuracy per model, safety test pass/fail, run date, judge model, run cost, known limitations.
- **Key Decisions**: reads a curated decisions-summary data file maintained alongside `ARCHITECTURE-SPINE.md`, each entry citing its `AD-n` id plus a short reason/trade-off - covering at minimum: agent shape (why an agent over prompt engineering or RAG, AD-1/AD-5), tool boundary (AD-4), the HITL gate (AD-14), the persistence split (AD-3), guardrails (AD-11/AD-12), model choice (AD-20), i18n (AD-24/AD-25), and money handling (AD-27).
- **Reflection**: reuses the same structured content Story 7.4 produces for the known-weaknesses/traceability documentation - known problems, improvement suggestions, and guidance on when to use prompt engineering vs. RAG vs. agents - rather than a separately hand-written copy.

**Security**: the page's content pipeline must exclude user-specific data, secrets, and LangSmith trace links by construction - a dedicated test scans the rendered page/its data sources for these before the page ships, not a manual review.

**Localization**: the page's UI chrome (nav, labels, section headers) goes through the same i18n layer as the rest of the app (AD-24, German/English). The report/decision content itself stays English-only - a deliberate choice, stated visibly on the page.

## Currency (CAP-2/CAP-5/CAP-8)

A user setting (EUR or USD, default EUR), not fixed in code and not inferred from UI language - covers both CAP-8's cost display and CAP-2/CAP-5's income projections/idea budgets as one setting, never two separate per-feature choices.

- **Storage:** money is stored as integer minor units (e.g. cents) plus an ISO currency code (`EUR`/`USD`) - never as a float, to avoid floating-point rounding bugs. This applies everywhere a monetary amount is persisted: idea budgets/startup costs (CAP-2), income projections (CAP-5), and per-message cost estimates (CAP-8).
- **Conversion:** one configured EUR/USD exchange rate with an as-of date - the same pattern as the model registry's `price_as_of` (AD-20) - not a live FX API call. Any converted amount is always visibly labeled as an estimate.
- **Setting location:** `user_settings`, alongside `language`/`personality`/`model` (AD-20). Changing currency re-renders every displayed amount in the newly chosen currency.
- **Source-of-truth amounts:** LLM billing (CAP-8) is natively in USD - the vendor fact doesn't change. When the user's currency is USD, the cost estimate displays directly; when EUR, it's converted using the configured rate and labeled an estimate. `generate_ideas`' sourced baseline rates (CAP-2/AD-6) are persisted once at generation time in whatever currency was sourced, then converted to the user's chosen currency using the same configured rate when displayed or used by `get_projection` - the stored source-of-truth value and citation never change; only the displayed/converted value does.
- **Formatting:** `Intl.NumberFormat` with `{ style: 'currency', currency: <EUR|USD> }`, locale driven by the active **UI language** (`de-DE` or `en-US`) independent of the currency choice - locale controls separators/symbol placement, the currency code controls which currency. A German-UI user with USD selected still sees German-style grouping with a `$` symbol, and vice versa.

## Settings: personality & model registry (CAP-7)

**Personality** (formal/friendly/terse) is a prompt layer only — it changes tone, never the tool boundary or any constraint. The guilt-language/moderation checks (AD-11/AD-12) apply identically under every personality.

**Model registry** — fields: `id`, `provider`, `display name`, price per 1M input/output tokens, `price_as_of` date. Only providers with a configured server-side key are selectable; the moderation model and transcription model are never exposed here. Prices are never hardcoded elsewhere in the codebase — this table is the single source.

Entries verified by the user via web as of 2026-11-14:

| id | provider | price in / 1M | price out / 1M | price_as_of | notes |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-luna` | openai | $0.10 | $0.50 | 2026-11-14 | Above 272K input tokens: $0.20 / $0.75 (optional `long_context_tier` field). OpenAI's own id for this model is `gpt-6-luna`. |
| `claude-haiku-4.5` | anthropic | **to verify** | **to verify** | - | OpenRouter id `anthropic/claude-haiku-4.5`. Price not yet recorded: look it up on the actual router before shipping and set `price_as_of` then. |
| `gemini-3.8-flash` | google | $0.75 | $3.75 | 2026-11-14 | Rising to $1.50 / $7.50 from 2027-01-01. Output price includes thinking tokens. Also an eval judge (see `evals.md`); selecting it in settings never affects judging. |

The registry holds exactly these three user-selectable chat entries (default: `gpt-6-luna`), all routed via OpenRouter. `mistralai/mistral-large-4-0` ($1.36 / $4.18) was removed (too slow: it repeatedly hit the 15 s fallback timeout). **Eval-only, not in the registry and never user-selectable:** `anthropic/claude-sonnet-5.5` ($2.00 / $10.00 per 1M, as of 2026-11-14; used only by on-demand evals as a fourth compared model) and the judge `deepseek/deepseek-v4.1-flash` (judge only; price to verify when configured).

`set_personality`/`set_model`/`set_ui_language`/`set_currency` are plain-code tools (pure Postgres writes to a dedicated `user_settings` table) — selecting a personality, model, UI language, or currency is never itself an LLM decision, and all four are only ever invoked via the settings UI's API calls, never autonomously by the agent. If the selected provider's key is missing or a call fails, the system falls back to the default model with a neutral notice rather than a hard error. `set_ui_language` defaults to English; `set_currency` defaults to EUR.

## Token & cost tracking (CAP-8)

Every agent turn sums the token usage of every model call made during that turn's full agent-loop execution (not just the final response). Cost is computed in application code from the model registry's price-per-1M figures for whichever model was active, labeled "estimate," and persisted per message in Postgres **together with the model id used and a price snapshot at that time** - so a later registry price change never retroactively rewrites a past message's recorded cost. A model with no registered price shows token count only, never a guessed or zero cost. Persisted values survive reload. This is a backend/API-layer computation after a turn completes, not an agent tool the model decides to call.

## Feedback (CAP-9)

Thumbs up/down plus an optional comment on any agent response, always optional, never blocking the chat input. A rating can be changed or removed later. `record_feedback` is a plain-code tool (pure Postgres write). The comment is untrusted user text and passes through the same `beforeModel`-equivalent moderation as any other input before being stored. Rated traces feed two destinations: per-user semantic memory (LangGraph `Store`/pgvector - retrieval in later turns is expected to produce an observable behavior change, testable), and a LangSmith dataset of rated traces used only for offline prompt improvement — never for model training; user content entering that dataset is anonymized (PII stripped) before storage, a documented security/privacy consideration rather than a separate opt-in flow for v1. A positive rating never overrides AD-12's guilt-language check or any other hard constraint.

## Chat topology (amends CAP-2/CAP-3)

One LangGraph thread per plan (AD-18 refined), plus a separate discovery chat thread used before any plan is chosen, for intake and idea discussion. Follow-up questions are allowed within a plan's own thread. "More ideas" (CAP-2) requests a further batch of 5 via `generate_ideas`, excluding anything already `bookmarked` or `rejected`.

## Evals & quality report

See `evals.md` — TypeScript-only tooling (`agentevals` + Vitest + LangSmith), deterministic unit/guardrail tests, a 15-25 case trajectory suite run against all 3 model registry entries plus the eval-only `anthropic/claude-sonnet-5.5`, and a report script.

## Moderation (mandatory)

Mistral Moderation 2 (`mistral-moderation-2603`, March 2026 — 128k context, jailbreak detection, PII category, multilingual) is a required pass, not optional, evaluated against the project's labelled/held-out test sets before adoption is finalized.

- **`before_model`** (screens user input): jailbreak → reject the turn, return a safe generic response, log the incident. PII → clean up/redact before storage or further processing, log, do not reject (users describing themselves in intake is normal).
- **`wrap_tool_call`** around `web_search` (screens untrusted external search results before they re-enter model context): on trigger → clean up/strip the flagged portion rather than rejecting the whole search, log.
- The "no streak-shaming/guilt language" constraint is a **separate**, bespoke check (Mistral Moderation has no category for this) on `after_model`, scoped to CAP-4 responses: on trigger → clean up (regenerate without the flagged phrasing), always logged — this is what makes that constraint mechanically verifiable rather than an asserted rule.

## Observability

LangSmith for tracing, tool-calling evals, and error visibility (user-provided API key) — pairs natively with `createAgent`/LangGraph.

## Authentication

Google OAuth (Google sign-in) — needed because CAP-4 persists per-user state across sessions.

## Cross-cutting concerns (middleware)

Error handling and message/context trimming are both implemented via middleware hooks wrapping the agent loop, composable across multiple middleware components:

```
before_agent() → before_model() → wrap_model_call(→ MODEL CALL →) → after_model() → [tool calls, same wrap pattern] → after_agent()
```

This is the chosen mechanism for request/response-shaping concerns (e.g. voice-failure-to-text fallback), not generic retry-on-failure, and for trimming conversation context before it reaches the model.

## Resilience (LangGraph node-level, not middleware)

Retries, timeouts, and caching live at the LangGraph node level via `setNodeDefaults` as the uniform baseline, deliberately not duplicated inside middleware (prevents two divergent retry systems):

- `generate_ideas` / `create_plan` → longer timeout (LLM calls), no caching (personalized per user)
- `web_search` → short-TTL `CachePolicy` (market-rate lookups repeat across users/sessions)
- Postgres plain-code tools → short timeout, fast retry

Service/dependency handles that don't belong in graph state (Postgres pool, LangSmith client, the OpenAI client) are injected via LangGraph's `runtime.context`, never stored as state fields. Graph state holds only data (intake values, selected idea/plan id, current step).

## Voice interaction (phased, behind one interface)

Both versions sit behind a single voice interface (e.g. one `transcribeCheckIn` / `speakResponse` contract) so swapping the implementation never touches check-in logic in `record_check_in` or elsewhere.

- **v1 (current):** browser `MediaRecorder` API records the check-in client-side → sent to the backend → transcribed via `gpt-transcribe` (OpenAI's current file-transcription model, released July 2026; the prior generation - `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` - was deprecated August 2026 and leaves the API February 2027, so not viable) → the transcript is shown back to the user to review/edit before it's submitted as the check-in. Typed text input is always available as a fallback. No raw audio is retained beyond what's needed to produce the transcript.
  - **[VERIFIED 2026-11]** Model id `gpt-transcribe`, endpoint `POST /v1/audio/transcriptions`, accepts file uploads. Supported formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm — covers both Chrome's `audio/webm;codecs=opus` and Safari's `audio/mp4` MediaRecorder output. Size limit 25MB (irrelevant for short check-ins). Price $0.0045/min (~$0.27/hr). Confirmed current, not deprecated. Not live-tested against a real API call - no key available in this environment; verify once implementation has credentials.
- **v2 (future):** swap to `gpt-audio-mini` for unified speech-to-speech (no transcript-review step) once the interface has proven itself in v1.

## Persistence layer

Required specifically because CAP-4 (check-ins) depends on remembering user state and progress across sessions (selected income idea, completed steps, check-in history, classified failure pattern). CAP-1/CAP-2 (intake, idea generation) are largely stateless per session and don't carry the same requirement.

- Threads
- Checkpointers
- Semantic memory retrieval
- Postgres

## Deployment & environments

Local-only on the user's laptop first (for build and the live class demo), deploying afterward to **Cloud Run** (app, genuine always-free tier, 2M requests/month, scales to zero) + **Neon** (Postgres — not Supabase or self-hosted GCP VM; decisive reason: Neon auto-wakes on query after scaling to zero, while Supabase free-tier projects pause when idle and require a manual dashboard resume, an unacceptable risk for a live demo hitting a cold database). Google Cloud SQL has no perpetual free tier, only a 30-day trial — ruled out for that reason.
