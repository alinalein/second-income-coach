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
 * exactly one place retry/timeout values are defined (AD-7).
 */
export function applyModelNodeResilience<G extends NodeDefaultsTarget>(graph: G): G {
  graph.setNodeDefaults({ retryPolicy: MODEL_NODE_RETRY_POLICY, timeout: MODEL_NODE_TIMEOUT_MS });
  return graph;
}
