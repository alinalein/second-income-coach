import { describe, expect, it, vi } from 'vitest';
import { applyModelNodeResilience, MODEL_NODE_RETRY_POLICY, MODEL_NODE_TIMEOUT_MS, type NodeDefaultsTarget } from './resilience.js';

function fakeGraph(): NodeDefaultsTarget & { setNodeDefaults: ReturnType<typeof vi.fn> } {
  const graph = { setNodeDefaults: vi.fn() };
  graph.setNodeDefaults.mockReturnValue(graph);
  return graph;
}

// AD-7: "Retries, timeouts, and caching live at the LangGraph node level via
// `setNodeDefaults` ... never duplicated inside `createAgent` middleware."
// Boundary: "`setNodeDefaults` carries retry/timeout for the model node
// (AD-7) — no retry logic duplicated in route/middleware code."
describe('applyModelNodeResilience (AD-7: model node resilience)', () => {
  it('applies the retry policy and timeout to the graph via setNodeDefaults', () => {
    const graph = fakeGraph();

    const result = applyModelNodeResilience(graph);

    expect(graph.setNodeDefaults).toHaveBeenCalledTimes(1);
    expect(graph.setNodeDefaults).toHaveBeenCalledWith({
      retryPolicy: MODEL_NODE_RETRY_POLICY,
      timeout: MODEL_NODE_TIMEOUT_MS,
    });
    expect(result).toBe(graph);
  });
});
