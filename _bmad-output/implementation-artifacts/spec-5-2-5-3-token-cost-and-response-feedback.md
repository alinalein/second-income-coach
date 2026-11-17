---
title: 'Token & Cost Display (5.2) + Response Feedback (5.3)'
type: 'feature'
created: '2026-11-17'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 1
context: []
baseline_commit: '6412b5d50513740565322564e1fd279ed23ab234'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chat/plan-chat turns give no visibility into token/cost spend per message, and there's no way for a user to rate a response or feed that signal back into the system.

**Approach:** Capture per-call token usage + actual model id inside the existing agent-loop model-selection hook (`model.ts`'s `wrapModelCall`, which already resolves fallback), sum it per turn in the outer graph node (`index.ts`), persist it (USD-native, integer minor units + price snapshot) keyed by message id, and convert to the user's current currency at read time. Add a plain, deterministic `record_feedback` write (rating + moderated comment) reachable per-thread, with change/remove support. Both render as one footer item each (`MessageCost`, `MessageFeedback`) via Story 3.1's existing `ChatMessage` footer extension point — no restructuring.

## Boundaries & Constraints

**Always:**
- Sum tokens across every model call in the turn's agent-loop (not just the final AIMessage) — the inner `createAgent` ReAct loop can produce multiple AIMessages per turn.
- Persist cost as USD-native integer minor units + a price-snapshot (model id, price-per-million-in/out, price-as-of) so later registry price changes never retroactively alter a past message's recorded cost.
- Convert to the user's **current** `user_settings.currency` at every read (POST result + GET history) — never freeze the display currency at write time.
- A model with no `findModelEntry` match → token count only, `amount: null`, never a guessed/zero cost.
- Direct-path flows (intake/ideas/plan creation, AD-4 amendment) are not chat messages and get no cost line — only `chat.ts`/`plan-chat.ts` turns.
- Feedback comment passes through the exact same `evaluateUserMessage` moderation pure function already used for chat input (AD-11) — reject drops the comment (rating still stored, incident logged), redact stores the cleaned text, pass stores verbatim.
- Chat input is never disabled/gated on missing feedback (explicit test).
- `record_feedback` never touches moderation/guardrail state — a positive rating must not suppress or alter an unrelated hard-constraint check.

**Never:**
- No restructuring of `ChatMessage`/`ChatThread`/`PlanWorkspace` beyond: one new state field on the agent's outer graph, one new optional `cost` field on `ChatMessage`, one `footerItems` array entry each, one new route pair per router file.
- No semantic-memory (pgvector) write/retrieval in this pass — see Open Questions (decision gate: needs an embedding model, none configured).
- No changes to idea generation, translation, search, plans business logic, or settings code.
- No float money anywhere — integer minor units + ISO code only (`shared/money.ts`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-call turn | Agent loop makes 2 model calls (decide + narrate) before final reply | Persisted/displayed cost = sum of both calls' tokens | N/A |
| No registry price | Turn's resolved model id has no `findModelEntry` match | `cost.amount` is `null`; token counts still shown | Never a guessed/$0 figure |
| EUR user | `user_settings.currency = 'EUR'`, registry price is USD | Amount converted via `convertMoney`, `isEstimate: true`, labeled "estimate" | N/A |
| USD user | `user_settings.currency = 'USD'` | No conversion, `isEstimate: false` | N/A |
| Reload | User refetches `GET /api/chat/messages` after a currency change | Same tokens/model/price snapshot; amount re-converted to the *current* currency | N/A |
| Fallback mid-turn | Selected model's provider key missing/call fails → falls back to default | Cost reflects the default model actually used, tokens preserved (not dropped) | N/A |
| Feedback jailbreak comment | Comment text flagged `jailbreaking` | Rating stored, comment dropped, incident logged | N/A |
| Feedback PII comment | Comment text flagged `pii` | Rating + redacted comment stored, incident logged | N/A |
| Change/remove rating | Existing feedback row for a message | Upsert on change; row deleted on remove | N/A |
| Rated violation | A response that violated a hard constraint gets rated 👍 | Violation log/check unaffected; still fires on repeat | N/A |

</frozen-after-approval>

## Open Questions

- **DECISION GATE — semantic memory embedding model.** AD-2 requires `PostgresStore` + pgvector for per-user semantic memory. No embedding model, no pgvector extension, and no `PostgresStore` usage exist anywhere in this codebase today (`postgres:17-alpine` has no pgvector). Options:
  - **A — Mistral `mistral-embed` via the already-configured `MISTRAL_API_KEY`** (cheapest: no new key/service, just incremental Mistral usage cost on the existing account; `@mistralai/mistralai` SDK already installed and already exposes `embeddings.create`). Still requires swapping the Postgres image to one with the `pgvector` extension (or `CREATE EXTENSION vector` on the existing image if available) and a new migration for the vector store tables.
  - **B — A new embedding provider/key** (e.g. OpenAI `text-embedding-3-small`) — new paid service, new env var, user must create the key.
  - **Consequence either way:** this AC (semantic-memory write + a retrieval test showing an observable behavior change) is deferred out of this session regardless, until the human picks A/B and confirms the pgvector infra change. Everything else in 5.3 (record_feedback, UI, moderation, persistence, LangSmith dataset hook) ships without it.

## Code Map

- `src/agent/model.ts` — `wrapModelCall`/`withFallbackNotice`: tag every returned `AIMessage.response_metadata.resolvedModelId`; fix `withFallbackNotice` to carry forward `usage_metadata` (currently dropped when a fallback notice is prepended — a latent gap for AD-21).
- `src/agent/index.ts` — outer `StateGraph(MessagesAnnotation)`: extend to a custom `Annotation.Root` with an added `turnUsage` channel (reducer: replace); `'model'` node computes it from `result.messages.slice(state.messages.length)` (this turn's new AI messages) after `reactAgent.invoke`, returns it alongside `messages`.
- `src/agent/turn-cost.ts` (new) — pure functions: `sumTurnUsage(newMessages)` (mirrors `src/evals/usage.ts`'s `sumUsage`, not imported cross-module — evals stays untouched), `computeMessageCost(usage, modelId, userCurrency)` using `findModelEntry`/`convertMoney` (mirrors `src/evals/cost.ts`'s null-on-no-price precedent).
- `src/db/schema/messageCosts.ts`, `src/db/schema/messageFeedback.ts` (new tables) + `src/db/schema/index.ts` (add exports).
- `src/db/message-cost-repository.ts`, reuse `record_feedback.ts` for feedback persistence directly (same single-file pattern as `src/tools/plain/set_idea_status.ts` — no separate repository layer for feedback).
- `src/tools/plain/record_feedback.ts` (new) — plain deterministic write, reusing `evaluateUserMessage` from `src/agent/moderation.ts` for the comment.
- `src/api/routes/chat.ts`, `src/api/routes/plan-chat.ts` — read `turnUsage` off the `'values'` stream payload; persist + attach `cost` to the reply `ChatMessage`; batch-attach cost on `GET /messages`; add `POST`/`DELETE .../messages/:messageId/feedback` next to each router's existing message routes (reusing each file's own thread-ownership check).
- `shared/schemas/index.ts` — add optional `cost` field to `chatMessageSchema` (imports `moneySchema` from `../money.js`); add feedback request/response schemas.
- `web/src/chat/MessageCost.tsx`, `web/src/chat/MessageFeedback.tsx` (new footer items) — `MessageFeedback` exported as a factory `createMessageFeedbackItem(endpoint)` so it can know which router to call without widening `ChatMessageFooterItem`'s `{message}`-only shape.
- `web/src/features/plan-workspace/PlanWorkspace.tsx` — only live `<ChatThread>` call in the app; add `footerItems={[MessageCost, createMessageFeedbackItem(...)]}`.

## Tasks & Acceptance

**Execution:**
- [x] `src/agent/model.ts` -- tag `resolvedModelId`, preserve `usage_metadata` through fallback -- AD-21's "model id actually used" + no silent token loss on fallback
- [x] `src/agent/index.ts` -- extend graph state with `turnUsage`, compute per-turn sum -- AD-21 "sum of every model call in the turn"
- [x] `src/agent/turn-cost.ts` -- pure sum + cost/currency computation -- unit-testable without DB/HTTP
- [x] `src/db/schema/messageCosts.ts`, `messageFeedback.ts` + index export -- new persistence
- [x] `src/db/message-cost-repository.ts` -- persist/read cost rows keyed by message id
- [x] `src/tools/plain/record_feedback.ts` -- set/remove rating+comment, moderation reuse
- [x] `src/api/routes/chat.ts`, `plan-chat.ts` -- wire cost persistence/attach + feedback routes
- [x] `shared/schemas/index.ts` -- `cost` field + feedback schemas
- [x] `web/src/chat/MessageCost.tsx`, `MessageFeedback.tsx` + `PlanWorkspace.tsx` wiring
- [x] migration -- generated last, after a final `git log main` check (another lane also adds one): `0008_robust_warhawk.sql`
- [ ] semantic memory (pgvector) write/retrieval -- deferred, decision gate (see Open Questions)
- [ ] LangSmith rated-traces dataset hook -- deferred, needs its own scoped Code Map entry (see Implementation Notes)

**Acceptance Criteria:** see Stories 5.2/5.3 in `epics.md` verbatim — not restated here.

## Implementation Notes

- Implemented in full except the semantic-memory (pgvector) write/retrieval and the LangSmith rated-traces dataset hook — both deferred per Open Questions; everything else in 5.3 (record_feedback, UI, moderation, persistence) shipped.
- Migration generated last, as instructed: `0008_robust_warhawk.sql` (two tables, `message_costs`/`message_feedback`). `lane/b`'s worktree has an uncommitted `0008_rare_hairball.sql` (Story 3.2) — a renumbering collision on merge, exactly as anticipated.
- Applied to lane/c's dev + test databases; full suite green (shared 37, src 374, web 87).

## Spec Change Log

- Review pass (iteration 1) found: (1) `setFeedback`'s upsert had no check that an existing `messageId` row belonged to the same user — fixed with a `FeedbackOwnershipError` ownership check (mirrors `IdeaNotFoundError` -> 404 precedent), both routes updated, one real-DB test added. (2) `GET /messages`'s two independent reads (`getUserSettings`/`getMessageCosts`) ran sequentially — switched to `Promise.all` in both `chat.ts`/`plan-chat.ts`. (3) `sumTurnUsage`'s `complete` flag is computed but not consulted by callers — left as a known limitation (no AC requires signaling a partial-usage floor; OpenRouter reliably reports usage on every call in production). (4) A theoretical `ChatMessage.id` stability concern on `toChatMessage`'s pre-existing `randomUUID()` fallback — verified against `@langchain/langgraph`'s `messages_reducer` source: every message is guaranteed a stable `.id` before checkpointing, so this fallback is unreachable in practice; no code change.

## Review Triage Log

- `src/tools/plain/record_feedback.ts` (setFeedback upsert authorization gap) — CONFIRMED, fixed.
- `src/api/routes/chat.ts`/`plan-chat.ts` (sequential GET reads) — CONFIRMED, fixed (cheap, no behavior change).
- `src/agent/turn-cost.ts` (`complete` flag unused) — PLAUSIBLE, not fixed (no AC coverage, documented as a known limitation).
- `src/api/routes/chat.ts` (`toChatMessage` id-stability fallback) — refuted on verification: LangGraph's message reducer always assigns a stable id before checkpointing, so the `randomUUID()` fallback this flagged is unreachable for a checkpointed message.

## Design Notes

Money flow: persist is always `{amountMinorUnitsUsd: integer, modelId, inputTokens, outputTokens, pricePerMillionInput/Output, priceAsOf}` — never a pre-converted figure. Display conversion (`convertMoney` to the user's current `user_settings.currency`) happens fresh on every read (POST result + GET history), so a later currency-setting change changes what reloading shows without touching stored rows (AD-27).

Feedback ownership: no new ownership-check code — `record_feedback` is called from within each router file's own existing thread (`chat.ts` discovery thread = `req.session.userId`; `plan-chat.ts` reuses its existing `assertPlanOwnership`), so the same check that already gates the message routes gates the new feedback routes.

## Verification

**Commands:**
- `npm test --workspace=src -- <changed files>` -- expected: all new/affected tests pass, run only while working
- `npm test` (full suite, once at the end) -- expected: no regressions
- `cd src && DATABASE_URL=<lane-c-test-url> npx drizzle-kit migrate` -- expected: clean apply of the new migration generated at the end

**Manual checks (if no CLI):**
- Reload a chat/plan thread after a cost-bearing turn — tokens/model/amount unchanged.
- Rate a message, change it, remove it — chat input stays enabled throughout.
