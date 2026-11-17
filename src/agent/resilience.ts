import type { RetryPolicy, TimeoutPolicy } from '@langchain/langgraph';
import { MODEL_FAILURE_MESSAGE } from '@app/shared';

/**
 * AD-7 (Resilience fabric split): "Retries, timeouts, and caching live at the
 * LangGraph node level via `setNodeDefaults` ... as the uniform baseline —
 * never duplicated inside `createAgent` middleware." This story has no
 * domain tools yet (Epic 2+), so the one node these defaults apply to is the
 * agent's own model-calling node (Boundary: "`setNodeDefaults` carries
 * retry/timeout for the model node (AD-7) — no retry logic duplicated in
 * route/middleware code").
 *
 * Exact retry counts/backoff/timeout values are left to implementation
 * (ARCHITECTURE-SPINE.md's "Deferred" section) — these are reasonable
 * starting defaults, not a tuned/measured budget.
 */
export const MODEL_NODE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 500,
  backoffFactor: 2,
};

export const MODEL_NODE_TIMEOUT_MS = 30_000;

/**
 * Story 2.2 follow-up fix 1 (AD-7: "generate_ideas/create_plan get longer
 * timeouts"): originally 90s, sized against round 1's ~23-33s measurements —
 * since outdated by round 4-6's grounding/quality checks (verified quotes,
 * vendor/source-trust checks, rate-unit handling), which made the model
 * write substantially more per call. A real post-quality-fixes run now
 * measures ~56s for a single *successful* attempt (the user's own report:
 * "two model calls, 18s planning + 30s writing, plus 8s parallel search"),
 * and a validation-triggered retry (`generate_ideas.ts`'s `MAX_DRAFT_
 * ATTEMPTS = 2`, now common given stricter `batchIsValid` checks) means two
 * such attempts can legitimately be needed in one turn. Round 8 (bug fix,
 * found live): raised to 170s — comfortably over 2 attempts at the new
 * `DRAFT_ATTEMPT_TIMEOUT_MS` (75s each, `generate_ideas.ts`) plus the outer
 * `reactAgent`'s own decision + final-reply calls, which also run inside
 * this same outer `'model'` node (Design Notes: the whole turn, not just
 * one LLM call, is this node's body). Chat and `submit_intake` keep
 * `MODEL_NODE_TIMEOUT_MS` unchanged — only ideas generation got slower.
 */
export const IDEAS_MODEL_NODE_TIMEOUT_MS = 170_000;

/**
 * Story 2.2 round 9, fix (a) (user-required, not a guess): "the ideas path
 * gets NO whole-turn retry at node level — a timeout is a failure, never a
 * re-run of every search." Confirmed directly in `@langchain/langgraph`'s
 * own source (`pregel/retry.js`'s `_runWithRetry`) that `MODEL_NODE_RETRY_
 * POLICY`'s default `maxAttempts: 3` was exactly what re-ran the *entire*
 * outer `'model'` node — including a brand-new `generate_ideas` call and
 * all of its searches — on a `NodeTimeoutError` (LangGraph's own retry
 * logging, `Retrying task "model" after ...ms (attempt N) after
 * NodeTimeoutError`, is what the user's terminal output showed every time).
 * `maxAttempts: 1` means the node task runs once; on any failure
 * (`_runWithRetry`'s loop: `attempts >= maxAttempts` breaks immediately
 * after the first attempt), it fails cleanly instead of retrying — not just
 * for a timeout, for any error, matching the user's literal ask ("NO
 * whole-turn retry"). `generate_ideas`'s own internal 2-attempt retry
 * (`MAX_DRAFT_ATTEMPTS`, `generate_ideas.ts`) is unaffected — that's a
 * different, inner retry loop this policy has no bearing on. Chat and
 * `submit_intake` keep `MODEL_NODE_RETRY_POLICY` (3 attempts) unchanged —
 * they don't have this node-level whole-turn-rerun problem since they never
 * run anywhere near their own 30s budget.
 */
export const IDEAS_MODEL_NODE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
};

/**
 * Story 3.1 (AD-4/AD-7): `create_plan`'s own outer-node timeout. Unlike
 * `generate_ideas`, `create_plan` makes no nested-agent/`web_search` calls —
 * it's a single, direct `chatModel.withStructuredOutput(...)` invocation
 * (Design Notes: "a single direct structured-output call is simpler and
 * inherently satisfies 'one attempt, no loop'") — so it stays at the
 * standard chat/intake budget rather than `IDEAS_MODEL_NODE_TIMEOUT_MS`'s
 * search-inflated one.
 */
export const PLAN_MODEL_NODE_TIMEOUT_MS = 30_000;

/**
 * Story 3.1 (Boundary: "one attempt, no whole-turn retry ... mirroring
 * IDEAS_MODEL_NODE_RETRY_POLICY"): same `maxAttempts: 1` reasoning as
 * `IDEAS_MODEL_NODE_RETRY_POLICY` above — a `create_plan` failure (timeout,
 * Zod validation failure, or any other error) is a failure, never a
 * whole-turn re-run. `create_plan` itself has no internal retry loop either
 * (unlike `generate_ideas`'s `MAX_DRAFT_ATTEMPTS`) — this is genuinely the
 * only attempt the whole turn gets.
 */
export const PLAN_MODEL_NODE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
};

/**
 * I/O matrix: "Model call exhausts retries" -> "User sees the fixed generic
 * error message" / "App keeps running, no crash". Returned by the chat route
 * when the compiled graph's `invoke()` rejects after `setNodeDefaults`'s
 * retries are exhausted. Defined once in `shared/schemas` (also used by
 * `web/src/chat/ChatThread.tsx`'s transport-failure fallback) and re-exported
 * here so this module stays the one place resilience-related callers import
 * it from.
 */
export { MODEL_FAILURE_MESSAGE };

/**
 * Story 1.4 (AC2): the German form of `MODEL_FAILURE_MESSAGE`, picked by
 * `detectReplyLanguage` on the message that triggered the failed turn
 * (`src/api/routes/chat.ts`). A local constant, not `shared/schemas` — same
 * reasoning as `JAILBREAK_REJECTION_MESSAGE_DE`/`UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE`
 * in `src/agent/moderation.ts` (Design Notes).
 */
export const MODEL_FAILURE_MESSAGE_DE =
  'Bei uns ist etwas schiefgelaufen und ich konnte keine Antwort erzeugen. Bitte versuche es gleich noch einmal.';

/**
 * The narrow slice of `StateGraph` this needs — just `setNodeDefaults` —
 * kept as its own interface so a unit test can assert the exact policy
 * applied without constructing a real graph.
 */
export interface NodeDefaultsTarget {
  setNodeDefaults(defaults: { retryPolicy?: RetryPolicy; timeout?: number | TimeoutPolicy }): unknown;
}

/**
 * Applies the model node's resilience defaults to a graph builder, before
 * `compile()`. The one call site for `setNodeDefaults` in this codebase —
 * `src/agent/index.ts` calls this instead of inlining the policy, so there's
 * exactly one place retry/timeout values are defined (AD-7). `timeoutMs`
 * defaults to the standard chat/intake budget; `src/agent/index.ts` passes
 * `IDEAS_MODEL_NODE_TIMEOUT_MS` for the second compiled agent used only by
 * the ideas route (Story 2.2 follow-up fix 1). `retryPolicy` defaults to the
 * standard 3-attempt policy; round 9 fix (a) passes `IDEAS_MODEL_NODE_
 * RETRY_POLICY` (no retry) for that same ideas-only agent.
 */
export function applyModelNodeResilience<G extends NodeDefaultsTarget>(
  graph: G,
  timeoutMs: number = MODEL_NODE_TIMEOUT_MS,
  retryPolicy: RetryPolicy = MODEL_NODE_RETRY_POLICY,
): G {
  graph.setNodeDefaults({ retryPolicy, timeout: timeoutMs });
  return graph;
}
