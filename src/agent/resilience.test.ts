import { describe, expect, it, vi } from 'vitest';
import {
  applyModelNodeResilience,
  MODEL_NODE_RETRY_POLICY,
  MODEL_NODE_TIMEOUT_MS,
  IDEAS_MODEL_NODE_TIMEOUT_MS,
  IDEAS_MODEL_NODE_RETRY_POLICY,
  type NodeDefaultsTarget,
} from './resilience.js';

function fakeGraph(): NodeDefaultsTarget & { setNodeDefaults: ReturnType<typeof vi.fn> } {
  const graph = { setNodeDefaults: vi.fn() };
  graph.setNodeDefaults.mockReturnValue(graph);
  return graph;
}

// AD-7: "Retries, timeouts, and caching live at the LangGraph node level via
// `setNodeDefaults` ... never duplicated inside `createAgent` middleware."
// Boundary: "`setNodeDefaults` carries retry/timeout for the model node
// (AD-7) — no retry logic duplicated in route/middleware code." Table-driven
// (CLAUDE.md): same assertion, default vs. Story 2.2 follow-up fix 1's
// overridden-timeout call vs. round 9 fix (a)'s overridden-retry-policy
// call, so neither override is silently ignored.
describe('applyModelNodeResilience (AD-7: model node resilience)', () => {
  it.each([
    ['defaults (no overrides)', undefined, undefined, MODEL_NODE_TIMEOUT_MS, MODEL_NODE_RETRY_POLICY],
    [
      'overridden timeout (follow-up fix 1: the ideas-specific agent)',
      IDEAS_MODEL_NODE_TIMEOUT_MS,
      undefined,
      IDEAS_MODEL_NODE_TIMEOUT_MS,
      MODEL_NODE_RETRY_POLICY,
    ],
    [
      'overridden timeout + no-retry policy (round 9 fix (a): the ideas-specific agent)',
      IDEAS_MODEL_NODE_TIMEOUT_MS,
      IDEAS_MODEL_NODE_RETRY_POLICY,
      IDEAS_MODEL_NODE_TIMEOUT_MS,
      IDEAS_MODEL_NODE_RETRY_POLICY,
    ],
  ])('%s', (_label, timeoutArg, retryPolicyArg, expectedTimeout, expectedRetryPolicy) => {
    const graph = fakeGraph();

    const result = applyModelNodeResilience(graph, timeoutArg, retryPolicyArg);

    expect(graph.setNodeDefaults).toHaveBeenCalledTimes(1);
    expect(graph.setNodeDefaults).toHaveBeenCalledWith({
      retryPolicy: expectedRetryPolicy,
      timeout: expectedTimeout,
    });
    expect(result).toBe(graph);
  });

  // Round 9 fix (a): the actual value the ideas-specific agent now gets —
  // 1 attempt means `_runWithRetry` (LangGraph's own retry loop, confirmed
  // directly in its source) never retries the outer 'model' node at all,
  // not just skips retrying a timeout specifically.
  it('IDEAS_MODEL_NODE_RETRY_POLICY allows exactly 1 attempt (no whole-turn retry)', () => {
    expect(IDEAS_MODEL_NODE_RETRY_POLICY.maxAttempts).toBe(1);
  });
});
