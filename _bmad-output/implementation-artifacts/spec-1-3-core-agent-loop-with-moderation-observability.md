---
title: 'Story 1.3: Core Agent Loop with Moderation & Observability'
type: 'feature'
created: '2026-11-15'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cb9fb5808316a6079de46ba7740bd01dbee273b7'
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Signed-in users have no way to exchange a message with the agent yet: no LLM agent loop, no moderation/safety layer, no observability — the foundational "the stack works end to end" proof the rest of the project depends on.

**Approach:** One LangChain `createAgent` instance on the LangGraph.js runtime behind the existing auth gate (no domain tools yet — Epic 2), with Mistral Moderation 2 at `beforeModel`/`afterModel`, one Postgres-checkpointed LangGraph thread per signed-in user, a LangSmith trace per turn, and the shared `ChatThread`/`ChatMessage` UI wired into the signed-in view.

## Boundaries & Constraints

**Always:**
- Every route this story adds sits behind the existing `requireAuth` gate (`src/api/app.ts`); the LangGraph thread id derives from `req.session.userId`.
- Model: `gpt-6-luna`, routed through OpenRouter's OpenAI-compatible endpoint (`https://openrouter.ai/api/v1`, model id `openai/gpt-6-luna`, via `@langchain/openai`'s `configuration.baseURL`) — the single hardcoded default until Story 5.1's registry/selection UI exists. One `OPENROUTER_API_KEY` covers every provider; not a direct `OPENAI_API_KEY`. (Renegotiated 2026-11-15 — see Spec Change Log.)
- Moderation: Mistral Moderation 2 (`mistral-moderation-2603`, via the official `@mistralai/mistralai` SDK) at `beforeModel` (jailbreak → reject the turn, return `"I can't help with that request. Let's get back to your second income goals — what would you like to work on?"`, log the incident; PII → clean/redact, log, don't reject) and `afterModel` (unsafe output → replace with `"I wasn't able to give a safe response to that — let's try a different angle. What would you like to focus on?"`, log the incident).
- Checkpointing: `@langchain/langgraph-checkpoint-postgres`'s `PostgresSaver` against the existing `DATABASE_URL`; `PostgresSaver.setup()` runs once, idempotently, at API startup (its own schema — not a Drizzle migration).
- `setNodeDefaults` carries retry/timeout for the model node (AD-7) — no retry logic duplicated in route/middleware code.
- A LangSmith trace exists for every turn via `LANGSMITH_TRACING`/`LANGSMITH_API_KEY`/`LANGSMITH_PROJECT` env config — no bespoke per-call tracing code.
- The shared Zod message schema (`shared/schemas/`) enforces a 4000-char max; an over-length message is rejected at the schema boundary, never silently truncated.
- A model call that still fails after its configured retries returns the user a clear, generic error (`"Something went wrong on our end and I couldn't generate a response. Please try again in a moment."`) — the process stays up.
- No log destination (incident logs, LangSmith metadata, error logs) ever contains raw user message text — only flags/categories/ids/lengths.
- New env vars — `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` — are added to `.env.example` (placeholders only) and validated in `src/config/env.ts`.
- `POST /api/chat/messages` uses `createStrictRateLimiter` (`src/api/middleware/rateLimit.ts`) — see Design Notes.
- `GET /api/chat/messages` reads history back from the checkpointer's own thread state — see Design Notes.

**Never:**
- No domain tools (Epic 2+), personality/model-selection UI, token/cost persistence (Epic 5), or i18n retrofitting (Story 1.4 adds translation keys for this story's three fixed texts above).
- No new Drizzle-managed table for messages/history.
- No streaming delivery (AD-19) — standard request/response only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal message | Signed-in user posts a short text message | Agent (`createAgent`/LangGraph) returns a reply; LangSmith trace recorded; thread persists | N/A |
| Jailbreak attempt | Message flagged jailbreak by `beforeModel` | Turn rejected; fixed safe response returned; incident logged (no raw text) | N/A |
| PII in input | Message flagged PII by `beforeModel` | Content cleaned/redacted; processing continues; incident logged | N/A |
| Unsafe model output | `afterModel` flags the response unsafe | Response replaced with the fixed safe fallback before being shown; incident logged | N/A |
| Over-length message | Body exceeds the shared Zod schema's max length | Rejected at the schema boundary (4xx) | Never silently truncated |
| Model call exhausts retries | `setNodeDefaults` retries all fail | User sees the fixed generic error message | App keeps running, no crash |
| Second message, same session | User sends another message in the same browser session | Same LangGraph thread (derived from session), same Postgres checkpoint | N/A |

</frozen-after-approval>

## Code Map

- `src/api/app.ts` -- mount the chat router after `app.use(requireAuth)` (line 75); session/CORS/rate-limit wiring reused as-is.
- `src/api/middleware/rateLimit.ts` -- reuse `createStrictRateLimiter` (exported, unused since Story 1.1); no changes.
- `src/api/middleware/requireAuth.ts` / `session.ts` -- reuse as-is; `req.session.userId` is the thread-id source.
- `src/config/env.ts`, `.env.example` -- add the 5 new vars, same pattern as the Story 1.2 block.
- `src/db/client.ts` -- reuse `createDb`'s pool/`DATABASE_URL`; pass the same connection string into `PostgresSaver.fromConnString` rather than opening a second pool.
- `src/agent/` (new) -- `model.ts` (ChatOpenAI `openai/gpt-6-luna` via OpenRouter's `baseURL`), `moderation.ts` (Mistral client + `beforeModel`/`afterModel` hooks, log hygiene), `resilience.ts` (`setNodeDefaults`), `checkpointer.ts` (`PostgresSaver` + idempotent `setup()`), `index.ts` (`createCoachAgent()` wiring all of it into one compiled graph).
- `src/api/index.ts` -- `await` the checkpointer's `setup()` once at startup (top-level await, ESM) before `createApp`, same try/catch as the existing env-error handling.
- `src/api/routes/chat.ts` (new) -- `createChatRouter`: `POST /api/chat/messages` (validate via `sendMessageRequestSchema`, invoke the agent for the session's thread, return the reply) and `GET /api/chat/messages` (thread's checkpointed state as history).
- `shared/schemas/index.ts` -- add `chatMessageSchema` (`id`, `role: 'user'|'assistant'`, `kind: 'message'|'notice'|'error'`, `content`, `createdAt`), `sendMessageRequestSchema` (`content`, max 4000 chars), `sendMessageResponseSchema`, `chatHistoryResponseSchema` — same `z.infer`-only pattern as `healthStatusSchema`/`authSessionSchema`.
- `web/src/chat/ChatMessage.tsx`, `ChatThread.tsx` (new) -- message list, text input, `'notice'`/`'error'` kinds styled distinctly from `'message'` bubbles; reuse `Badge`/`Card` primitives and the existing muted/foreground-contrast convention.
- `web/src/App.tsx` -- replace the placeholder `Card` in the authenticated branch (lines 180-208) with `<ChatThread />`; header/sign-out unchanged.
- `src/package.json` -- add `langchain@1.6.5`, `@langchain/core@^1.4.1` (actual pin — `langchain@1.6.5`'s peer range requires `^1.4.0`, making the originally-planned `1.3.6` unresolvable), `@langchain/langgraph@1.7.3`, `@langchain/langgraph-checkpoint-postgres`, `@langchain/openai`, `@mistralai/mistralai`.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/env.ts` + `.env.example` -- add `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` -- env-variable rule for this story's external services
- [x] `shared/schemas/index.ts` -- add chat message/request/response/history schemas with max-length enforcement -- shared schema AC
- [x] `src/agent/model.ts`, `resilience.ts`, `checkpointer.ts`, `moderation.ts`, `index.ts` -- wire `createAgent` + hooks + `setNodeDefaults` + `PostgresSaver` -- core agent loop AC
- [x] `src/api/routes/chat.ts` + `src/api/app.ts` -- gated send/history routes, strict rate limiter -- auth-gated agent access AC
- [x] `src/api/index.ts` -- checkpointer `setup()` at startup -- persistence AC
- [x] `web/src/chat/ChatMessage.tsx`, `ChatThread.tsx` + `web/src/App.tsx` -- shared chat UI wired into the signed-in view -- chat UI AC
- [x] Tests for the I/O matrix rows above and the log-hygiene constraint, each mapped to its AC per `CLAUDE.md`'s testing policy

**Acceptance Criteria:**
- Given a signed-in user, when they send a message, then it is processed by a `createAgent` instance on the LangGraph.js runtime via standard request/response (no streaming).
- Given any completed agent turn, when it finishes, then a LangSmith trace exists for that interaction.
- Given the chat UI, when built, then it is the shared `ChatThread`/`ChatMessage` component (message list, text input, error and neutral-notice rendering) — not a one-off, page-specific widget.
- Given this story's env vars, when the backend starts without one configured, then `src/config/env.ts` fails fast, naming exactly which variable is missing.
- Given any incident log written by the moderation hooks, when inspected, then it contains no raw user message text — only flags/categories/ids/lengths.
- Given the model node's resilience config, when invoked, then `setNodeDefaults` retry/timeout applies and no duplicate retry logic exists in route or middleware code.

## Implementation Notes

## Spec Change Log

- **2026-11-15 — human-requested renegotiation, post-`done`:** the human uses OpenRouter (one `OPENROUTER_API_KEY` for every provider), not direct per-provider keys. Checked `ARCHITECTURE-SPINE.md`/`stack.md` first — neither specifies direct provider keys as a requirement; the only router-related text (`mistral-large-4`'s note) explicitly anticipates a router being used, so nothing blocked this. Switched the model path from direct OpenAI to OpenRouter's OpenAI-compatible endpoint (`https://openrouter.ai/api/v1`, model id `openai/gpt-6-luna` — confirmed via OpenRouter's own model listing, not guessed from its naming convention alone); `OPENAI_API_KEY` replaced by `OPENROUTER_API_KEY` everywhere (`.env.example`, `src/config/env.ts`, `src/agent/model.ts`, `src/agent/index.ts`, and the tests referencing it). **Moderation kept on direct `MISTRAL_API_KEY`**, not switched: OpenRouter has no pass-through for Mistral's specific `mistral-moderation-2603` classifier/taxonomy — it only offers its own, differently-shaped "guardrail policies" product, which is not a drop-in equivalent and wasn't asked for. KEEP: the rest of the agent wiring (moderation hooks, checkpointer, resilience, chat routes, UI) is unchanged — this was a model-access-path swap only.

## Review Triage Log

- **`sprint-status.yaml` edited by this build session** (blind-hunter) — `false` — the file's own "WORKFLOW NOTES" comment documents this exact single-key status toggle as happening "via build's sprint sync"; CLAUDE.md's ownership rule targets ad hoc/bulk planning-doc rewrites, not this designed, narrow sync step. Route: **false**.
- **LangSmith env var name may be wrong (`LANGSMITH_TRACING` vs `LANGCHAIN_TRACING_V2`), AC untested** (blind-hunter) — `false` — read installed `langsmith@0.12.0`'s `lib/utils/env.js`/`lib/utils/guard.js`: `isEnvTracingEnabled` checks both `TRACING_V2` and `TRACING` suffixes under both `LANGSMITH_`/`LANGCHAIN_` prefixes; `@langchain/core@1.4.1`'s `CallbackManager._configureSync` auto-attaches a `LangChainTracer` whenever that resolves true. `LANGSMITH_TRACING=true` is genuinely recognized — confirmed from the installed packages' own source, not assumed. Route: **false**.
- **`createCoachAgent`'s graph construction has no dedicated test** (blind-hunter) / **moderation middleware's `beforeModel.hook`/`afterModel` closures are never invoked by any test, only the decoupled pure `evaluate*` functions are** (verification-gap, pre-verified) — `medium` — confirmed: no test imports `createModerationMiddleware` or `createCoachAgent`; `chat.test.ts` fakes the whole agent. A regression dropping `id: lastHuman.id` on the redact path (duplicate message instead of in-place replace) or breaking `jumpTo: 'end'` would pass the full suite undetected. Route: **patch**.
- **Mistral's generic `pii` category is logged as `pii_redacted` even though `redactPii()` only strips email/phone patterns — other PII types pass through unredacted while the log claims cleaning occurred** (blind-hunter) — `medium` — confirmed in `src/agent/moderation.ts`: `evaluateUserMessage`'s redact branch always returns `redactPii(text)` and always logs `pii_redacted` regardless of which sub-category Mistral actually flagged. Route: **patch**.
- **Duplicate hardcoded failure-message string: `MODEL_FAILURE_MESSAGE` (backend) and `CLIENT_SEND_FAILURE_MESSAGE` (frontend) are two independent literals of the same text** (blind-hunter) — `low` — confirmed; nothing enforces they stay in sync, unlike `CHAT_MESSAGE_MAX_LENGTH`'s shared-constant pattern used elsewhere in this same story. Route: **patch**.
- **`GET /api/chat/messages`'s `catch` (503) branch has no test** (blind-hunter) — `low` — confirmed, but this project's own testing policy (CLAUDE.md: "no mapping, no test") has no AC/I-O-matrix row for a checkpointer-read failure, and the condition (Postgres unreachable mid-session) is unlikely in this project's short-session/demo usage. Route: **reject** (low + adding an unmapped test cuts against house style).
- **Spec's Code Map says `@langchain/core@1.3.6`; actual pin is `^1.4.1`** (blind-hunter) — real, but its only fix is editing this spec. Route: **reject** (fix = edit the spec; corrected directly as a documentation accuracy pass, not a code patch).
- **Hardcoded model ids (`gpt-6-luna`, `mistral-moderation-2603`) aren't independently verifiable as real models** (blind-hunter) — `false` — both are carried verbatim from the frozen Intent, themselves sourced from `stack.md`'s registry table, explicitly marked "Entries verified by the user via web as of 2026-11-14." Not this story's call to re-litigate. Route: **false**.
- **`chat.ts`'s "agent resolved but produced no usable reply" fallback logs nothing** (blind-hunter) **and empty-text persisted messages are silently filtered out of `GET` history with no trace** (edge-case-hunter) — `low` — confirmed: `toChatMessage` returns `undefined` for empty/non-text messages; the `POST` handler masks this as the generic `kind:'error'` reply without logging, and the `GET` handler silently drops it from history via `.filter(...)`. Narrow (requires an empty-completion from the model) but a real, currently-silent blind spot. Route: **patch**.
- **Spec frontmatter (`in-review`) and `sprint-status.yaml` (`in-progress`) disagree** (blind-hunter) — `false` — two different-granularity trackers by design (5 spec states vs. 5 sprint-status states that don't map 1:1); the workflow syncs `sprint-status.yaml` only at specific steps, and this diff was captured right at the start of step-04, before any later sync point. Route: **false**.
- **`POST`'s 400 response for an over-length message omits the Zod validation detail, unlike `env.ts`'s named-variable convention** (blind-hunter) — `false` — no AC or I/O-matrix row requires structured error detail in the body; the matrix only requires "rejected at the schema boundary (4xx)," which the current response satisfies. Route: **false**.
- **`req.session.userId!` non-null assertion has no guard/test for a session missing `userId`** (blind-hunter) — `false` — `src/api/app.ts` mounts `requireAuth` unconditionally before the chat router in the only path that reaches it; `requireAuth` already 401s before `next()` on a missing `userId`, so the asserted state is unreachable here. Route: **false**.
- **Late-resolving `GET` history fetch can overwrite an already-sent optimistic message/reply** (edge-case-hunter) — `low` — real but narrow: `GET` fires on mount (before the user can realistically type+submit), so the race window is small; the fix requires an added guard (more than a direct correction) against an unlikely-in-practice ordering. Route: **reject**.
- **`checkpointer.setup()` is awaited at startup with no timeout** (edge-case-hunter) — `medium` — confirmed in `src/api/index.ts`; unlike every other startup failure in this codebase (env validation, `server.on('error', ...)`, `pool.on('error', ...)`), an unreachable/slow Postgres here produces a long silent hang instead of the established fail-fast message — and "Postgres not running yet" is a very plausible everyday local-dev mistake for this exact project. Route: **patch**.
- **`GET` non-OK response (expired session, etc.) renders identically to a brand-new empty conversation** (edge-case-hunter) — `low` — real but self-recovering on reload, and session expiry mid-tab-session is unlikely within this project's short demo-session usage pattern; the fix needs a new error-state branch (more than a direct correction). Route: **reject**.
- **`POST` non-OK (401/429) collapses into the same generic model-failure text** (edge-case-hunter) — `low` — same reasoning as the `GET` case above: narrow likelihood, fix needs new status-aware branching. Route: **reject**.
- **`src/agent/index.ts:57`'s `runtime as unknown as RunnableConfig` double-cast defeats type-checking on the config forwarded into the inner agent** (edge-case-hunter) **— same concern raised independently by verification-gap's "Other findings"** — `low` — confirmed by reading `@langchain/langgraph`'s own `.d.ts`: `LangGraphRunnableConfig extends RunnableConfig`, so the cast through `unknown` is unnecessary and suppresses structural checking that would otherwise apply for free. The underlying `configurable.thread_id` mechanism itself is LangGraph's stable public API and unlikely to silently diverge, but the cast should still go. Route: **patch**.
- **`web/src/App.tsx`'s rewrite removed the only remaining consumer of `shadcn-glass-ui` in `web/src`, leaving the dependency and its global style import dead** (edge-case-hunter) — `low` — confirmed via repo-wide grep: no `.tsx`/`.ts` file under `web/src` references `GlassCard`/`shadcn-glass-ui` anymore, yet `web/package.json` and `web/src/index.css` both still reference it. The fix (delete the unused dependency entry and `@import`) is trivial. Route: **patch**.


## Design Notes

- **Checkpointer, not a messages table:** AD-3 reserves the checkpointer for "conversational context only" — a thread's message history is exactly that, not a hard fact another capability depends on being exact (unlike ideas/plans/check-ins, which get dedicated tables from Epic 2 on). Reading history back through it avoids a second, divergent source of truth.
- **`createStrictRateLimiter` now:** Story 1.1 built the factory with no route to apply it to yet. `POST /api/chat/messages` is the first LLM-backed, cost-bearing route (AD-30's stricter tier), so it's the first consumer.
- **Thread id shape:** `discovery:${userId}`, not bare `userId` — reserves the `plan:${planId}` naming Epic 3 introduces per AD-18, so the two thread kinds never collide once Story 3.1 lands.
- **Mistral SDK:** the official `@mistralai/mistralai` TypeScript client (has a moderation endpoint) over a hand-rolled HTTP call — fewer places to get auth/retry/error-shape wrong.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean across `src`, `web`, `shared`
- `npm run lint` -- expected: zero lint errors
- `npm test` -- expected: new tests (mapped to ACs/AD-7/AD-11/AD-30 per `CLAUDE.md`) pass, previous suite still green
- `npm run build` -- expected: clean production build

**Manual checks (if no CLI):**
- Sign in, send a normal message, confirm a reply renders in `ChatThread` and a corresponding trace appears in the LangSmith project.
- Send an obvious jailbreak-style message, confirm the fixed safe response renders as a `notice`, not a normal reply.
- Reload the page mid-conversation, confirm prior messages still render (read back from the checkpointer).
