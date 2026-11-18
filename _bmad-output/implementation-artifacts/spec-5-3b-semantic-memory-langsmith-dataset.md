---
title: 'Story 5.3b: Per-User Semantic Memory + LangSmith Feedback Dataset'
type: 'feature'
created: '2026-11-18'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'c66ab43'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 5.3's core (`record_feedback`, thumbs/comment UI, moderation) is done, but a rated trace doesn't yet feed per-user semantic memory or a LangSmith dataset (AD-2/AD-22), so later turns never benefit from past feedback and there's no offline dataset of rated traces.

**Approach:** Use `@langchain/langgraph-checkpoint-postgres`'s `PostgresStore` (already a dependency, AD-2's named mechanism) backed by pgvector, embedding with Mistral `mistral-embed` (existing `MISTRAL_API_KEY`). On `setFeedback`, if a moderated comment exists, upsert it into the user's memory namespace and add a LangSmith example (comment is already PII-stripped by existing moderation before either call). On `removeFeedback`, delete the memory entry. Before each chat turn, retrieve the user's top-3 memories above a similarity floor, capped in characters, and fold into the system prompt. Switch local Postgres to a pgvector-enabled image.

## Boundaries & Constraints

**Always:** Memory/dataset writes never fail or block the feedback HTTP response (catch + log). Retrieval failure never blocks a turn — proceeds with the base prompt. Memory is strictly per-user (namespace `['memory', userId]`); never cross-user. Only the already-moderated comment text is embedded/sent — never raw user input. AD-12/guardrail checks remain fully decoupled from `record_feedback` (unchanged).

**Never:** No custom Drizzle migration for the memory table — `PostgresStore.setup()` owns its own schema + `CREATE EXTENSION vector`, same "library owns its own schema, called once at startup" precedent as `PostgresSaver.setup()`. No message content plumbed into the feedback route — a thumbs-only rating (no comment) produces no memory entry (nothing to embed). Don't touch sidebar/App.tsx/plan-workspace layout/ideas/check-in/plan tools. No LangSmith README (Story 7.1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rating + comment stored | thumbs-down + comment on topic X | memory upserted (user-scoped), LangSmith example added | N/A |
| Thumbs only, no comment | rating, no comment | no memory/dataset write (nothing to embed) | N/A |
| Later turn, same topic | user asks about X again | system prompt includes the stored memory | N/A |
| Later turn, different user | different userId, same topic | no memory surfaced (no cross-user leak) | N/A |
| Embedding/store call fails | Mistral/Postgres error on write or search | feedback write still succeeds; turn proceeds without memory | logged, never thrown to caller |
| Rating changed/removed | existing rating comment edited / deleted | memory entry updated / deleted to match | N/A |
| LangSmith not tracing | `LANGSMITH_TRACING=false` | dataset write is a no-op with a log line | N/A |

</frozen-after-approval>

## Code Map

- `src/agent/memory.ts` (new) -- `createMemoryStore(env)` returns configured `PostgresStore.fromConnString` (Mistral embeddings adapter, dims 1024, cosine); `rememberFeedback`/`forgetFeedback`/`recallMemories` (top 3, similarity floor, char cap), all try/catch-and-log.
- `src/agent/feedback-dataset.ts` (new) -- `recordFeedbackExample(env, {...})` using `langsmith`'s `Client`; no-op + log when `LANGSMITH_TRACING !== 'true'`; ensures dataset via `hasDataset`/`createDataset`.
- `src/agent/checkpointer.ts` -- reuse pattern for `src/agent/memory.ts`'s factory (pure construction, `.setup()` called at startup, not here).
- `src/agent/index.ts` -- `dynamicSystemPromptMiddleware` callback becomes async: resolve `userId` via existing `extractUserIdFromThreadId`, pull latest human message text from `state.messages`, call `recallMemories`, append to `buildSystemPrompt(...)` output. New optional `memoryStore` dep on `CreateCoachAgentDeps`.
- `src/tools/plain/record_feedback.ts` -- `setFeedback`/`removeFeedback` take an optional `memoryStore`/dataset dep; call `rememberFeedback`/`forgetFeedback`/`recordFeedbackExample` after the Postgres write (never blocking it).
- `src/api/routes/chat.ts`, `src/api/routes/plan-chat.ts` -- thread `memoryStore` through router deps into `setFeedback`/`removeFeedback` calls.
- `src/api/index.ts` -- construct `memoryStore`, `await withTimeout(memoryStore.setup(), ..., 'Memory store setup')` (same precedent as checkpointer), pass into all three `createCoachAgent` calls and `createApp`.
- `src/api/app.ts` -- add `memoryStore` to `AppDeps`, thread to both routers.
- `src/config/env.ts`, `.env.example` -- add optional `LANGSMITH_FEEDBACK_DATASET` (default `'second-income-coach-feedback'`); no new required key.
- `docker-compose.yml` -- swap `postgres:17-alpine` → `pgvector/pgvector:pg17`.
- `src/agent/index.ts` (live-test follow-up) -- `resolveUserId(configurable)`: explicit `configurable.userId` first, `extractUserIdFromThreadId` fallback; used by both the settings lookup and memory retrieval, so both now work on a plan-chat thread, not just discovery.
- `src/api/routes/chat.ts` (live-test follow-up) -- `agent.stream(...)`'s `configurable` now also carries `userId` (`plan-chat.ts` already did).

## Tasks & Acceptance

**Execution:**
- [x] `docker-compose.yml` -- switch image to `pgvector/pgvector:pg17` -- same major version, pgvector pre-installed
- [x] `src/agent/memory.ts` -- new module: Mistral embeddings adapter + `PostgresStore` factory + remember/forget/recall helpers -- AD-2
- [x] `src/agent/feedback-dataset.ts` -- new module: LangSmith example writer, no-op when tracing off -- AD-22
- [x] `src/tools/plain/record_feedback.ts` -- wire memory + dataset calls into `setFeedback`/`removeFeedback` -- AC "feeds per-user semantic memory and a LangSmith dataset"
- [x] `src/agent/index.ts` -- async system-prompt memory retrieval, user-scoped, bounded -- AC "retrieval surfaces it ... observable behavior change"
- [x] `src/api/index.ts`, `src/api/app.ts`, `chat.ts`, `plan-chat.ts` -- wire `memoryStore` end to end -- plumbing
- [x] `src/config/env.ts`, `.env.example` -- add `LANGSMITH_FEEDBACK_DATASET` -- CLAUDE.md external-service rule

**Acceptance Criteria:** see epics.md Story 5.3's last four ACs (semantic memory + LangSmith dataset, AD-12 preserved, change/remove updates memory) — not restated here.

## Implementation Notes

Implemented by a subagent, diff reviewed against baseline `c66ab43`. `@langchain/langgraph-checkpoint-postgres/store` subpath exports `PostgresStore`; `mistral-embed` embed fn passed as a plain function (`IndexConfig.embed` accepts `Embeddings | EmbeddingsFunc`). Added `langsmith` (`^0.12.0`, previously only a transitive dep) to `src/package.json`. 7 new/changed test files, 15 new assertions total across `memory.test.ts` (6), `feedback-dataset.test.ts` (4), `record_feedback.test.ts` (+3, one `it.each` of 2 rows), `index.test.ts` (+2) — all I/O-matrix rows covered and passing; fixture-only updates to `app.test.ts`/`chat.test.ts`/`plan-chat.test.ts` for the widened deps shape.

Verified: `npm run typecheck` clean; `npm run test --workspace=src` against this lane's own `second_income_coach_c_test` DB (414/414); full `npm test` once (551/551: 41 shared + 414 src + 96 web). Live-verified `PostgresStore.setup()` (CREATE EXTENSION + migrations) and the embed-call error path against a disposable `pgvector/pgvector:pg17` container on a throwaway port — never touched the shared lane container.

Known gap: the shared dev Postgres container on :5432 still runs `postgres:17-alpine` (old image) — recreating it is a user action (see report), not re-run here to avoid disrupting other concurrent lanes.

**Review pass (edge-case-hunter, 1 reviewer per user instruction):** 6 findings, see Review Triage Log below. Applied directly (not re-dispatched to the implementation subagent — both were small, well-understood, verified fixes): (1) `setFeedback`/`removeFeedback`'s memory/dataset calls changed from `await`ed to fire-and-forget (`void`), since awaiting them contradicted the spec's own "never block the feedback HTTP response" Boundary; (2) `feedback-dataset.ts`'s dataset-ensure step isolated in its own try/catch so a concurrent-creation race never drops the example write. `record_feedback.test.ts`'s 4 affected assertions switched to `vi.waitFor(...)` to poll for the now-async side effects instead of asserting immediately after `await setFeedback(...)`. Re-ran `record_feedback.test.ts`/`feedback-dataset.test.ts`/`memory.test.ts` (22/22), full `npm run typecheck`, `eslint` on the 3 patched files, and the full `npm test` once more (551/551) after these fixes — all green. 4 findings deferred to `deferred-work.md` (empty-string env var, duplicate LangSmith examples on repeated comment edits, repeated embed calls within one ReAct turn, plan-thread memory-retrieval scope gap).

Test-count tidy (CLAUDE.md: "put variants of the same case into one table-driven test"): consolidated `feedback-dataset.test.ts`'s "dataset missing"/"dataset exists" pair and `index.test.ts`'s "same user"/"different user" pair into `it.each`, each counting as one test for this story's budget. New test count by story (each `it.each` = 1): `memory.test.ts` 5, `feedback-dataset.test.ts` 3, `record_feedback.test.ts` +3, `index.test.ts` +1 = **12 new tests**, under the 15 cap. Vitest's own raw executed-case count is unchanged (414/414 — `it.each` still runs each row).

**Live-test follow-up 2 (hardening, not a confirmed root-cause fix):** a live "agent produced no usable reply" was traced via the real `[api]` terminal log: `model_call` → `moderation_after (skipped, no_text)` → `tool_call: create_plan` → nothing further, no thrown error. `create_plan`'s existing-plan early-return (`select ... if (existingPlan) return`) is already correct and fast (13ms, matches the log), ruling that out. The absence of a *second* `model_call` log line with no exception anywhere points most plausibly at `plan-chat.ts`'s own documented, pre-existing behavior — `req.on('close')` setting `clientDisconnected`, breaking the `for await` loop early and using whatever `lastValuesPayload` was captured so far (here: right after the tool call, before any narration) — i.e. the client/dev-server reconnecting mid-stream (plausible right after the container/Vite restarts earlier in this session), not a bug introduced by this story. Could not be proven with the log excerpt alone. Applied a cheap, strictly-safer hardening regardless: `src/agent/index.ts`'s memory-lookup block in `dynamicSystemPromptMiddleware` is now wrapped in its own `try/catch` (previously only `recallMemories` internally caught its own errors) — any unexpected failure anywhere in that lookup now falls back to the base prompt instead of risking the model call itself. No test added (nothing reproducible to assert against); full suite re-run once (552/552).

**Live-test follow-up (plan-chat memory fix, user-directed):** a live run (thumbs-down + comment, then a follow-up "i need some new ideas" on an active plan's chat) showed no behavior change. Root-caused by querying the running dev DB directly (`store`/`store_vectors` had the right rows, a live similarity check scored 0.65–0.69 against the floor of 0.5 — retrieval itself was sound), but `checkpoints` showed the conversation was on a `plan:${planId}` thread, not `discovery:${userId}` — `extractUserIdFromThreadId` only ever resolved a userId for the discovery prefix, so both memory retrieval and the AD-20 settings lookup silently no-op'd on every plan-chat turn. Fixed per the user's explicit direction: `chat.ts` now also passes `userId` into `configurable` (`plan-chat.ts` already did); `src/agent/index.ts` gained `resolveUserId(configurable)` — prefers the explicit `configurable.userId`, falls back to `extractUserIdFromThreadId` for any caller that doesn't pass it — used by both the outer node's settings lookup and the inner `dynamicSystemPromptMiddleware`'s memory retrieval. `buildSystemPrompt`'s memory section reworded from a soft "if useful" hint to an explicit standing instruction ("The user previously said: \"...\". Follow it for similar topics."), per the user's request. Similarity floor/embedding target unchanged, as instructed. One new table-driven test (`index.test.ts`) replaces the earlier 2-row one: plan-chat-shaped thread id, 3 rows (owner surfaces, no-memory user doesn't, different user doesn't) — proves the fix on the actual failing shape. One pre-existing test (`chat.test.ts`) updated for the now-widened `configurable` object. Full suite re-run: 552/552 (41 shared + 415 src + 96 web).

## Review Triage Log

One review pass (`edge-case-hunter`, per the user's explicit "one review pass, at most 1 reviewer" instruction — narrower than this workflow's default 3-layer review).

- **`src/agent/feedback-dataset.ts:51-58`** — concurrent first-ever writes can both see `hasDataset` false and race on `createDataset`; the loser's error (same outer `try`) previously skipped `createExample` entirely, silently dropping that example. Verdict: `low` (narrow race, first-dataset-creation-only). Route: **patch** — fixed by isolating the ensure-step in its own inner `try/catch` so a conflict there never skips `createExample`.
- **`src/tools/plain/record_feedback.ts` (claim check)** — spec's own Boundary says memory/dataset writes "never ... block the feedback HTTP response", but `setFeedback` `await`ed `rememberFeedback`/`recordFeedbackExample` before returning, so the response latency did include a live Mistral embed call plus a LangSmith round trip. Verdict: `medium` (real, user-facing latency regression on a "frictionless" rating action, confirmed against the code). Route: **patch** — fixed by firing these (and `forgetFeedback` in both `setFeedback` and `removeFeedback`) without `await`; they already catch+log internally so this can never produce an unhandled rejection. Tests updated to `vi.waitFor(...)` instead of asserting immediately after `await setFeedback(...)`.
- **`src/config/env.ts:70`** (`LANGSMITH_FEEDBACK_DATASET`) — an explicit empty-string value crashes startup (`.min(1)` rejects it; `.default()` only substitutes for `undefined`). Verdict: `low` — real, but reproduces the exact same pre-existing pattern already shared by `CORS_ORIGIN`/`BODY_LIMIT` in this same file; fixing only the new field would be the inconsistent one. Route: **defer** (deferred-work.md).
- **`src/tools/plain/record_feedback.ts:118-126`** — repeatedly editing the same message's comment creates a new LangSmith example each time (no `id`/upsert), accumulating duplicates/stale examples for that `messageId`. Verdict: `low` (rare user action; data-hygiene only, not a functional or security defect; the right fix depends on LangSmith's own id-conflict semantics, which weren't verified here). Route: **defer** (deferred-work.md).
- **`src/agent/index.ts:293-302`** — `recallMemories` (a live Mistral embed call + a Postgres vector search) re-runs on every model invocation within one turn's ReAct loop (e.g. once before a tool call, again before the final reply), not once per turn. Verdict: `low` (minor added cost/latency, not a correctness defect; this agent's tool set makes at most 2-3 model calls per turn). Route: **defer** (deferred-work.md).
- **`src/agent/index.ts` (claim check, `extractUserIdFromThreadId`)** — the I/O matrix's "Later turn, same topic" row reads as any later turn; `extractUserIdFromThreadId` only resolves a `userId` for `discovery:`-prefixed thread ids, so memory never surfaced on a plan-chat (`plan:${planId}`) turn. Verdict: `low` at review time — initially deferred as the same pre-existing AD-20 settings-lookup gap. **Superseded:** the user's own live test hit exactly this path (plan-chat is the only chat surface in the UI), so this was fixed, not left deferred — see "Live-test follow-up" above. Entry removed from `deferred-work.md` accordingly.

## Design Notes

PII: the embedded/dataset text is always the already-moderated comment (`resolveFeedbackComment`'s `redact`/`pass` branches) — the same text already stored in `messageFeedback.comment`. No second strip step is needed; this is the documented security/privacy consideration for the LangSmith dataset (offline prompt-improvement only, never training).

AD-12: no check-in/guilt-language mechanism exists yet in this codebase (CAP-4 unbuilt). This story keeps `record_feedback` fully decoupled from any constraint-check path (unchanged) and proves that boundary with a test, rather than inventing a guardrail mechanism out of scope.

## Verification

**Commands:**
- `DATABASE_URL=... npm run test --workspace=src` -- affected suites green
- `npm run typecheck` -- no type errors
- full `npm test` once at the end
