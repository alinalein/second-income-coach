import { describe, expect, it, vi } from 'vitest';
import { createForceToolChoiceMiddleware } from './toolChoice.js';

// Perf fix (user-requested): "force tool_choice: create_plan ... cuts 3 LLM
// calls to 1". Pure unit test over the middleware's own `wrapModelCall`
// hook — no real model/graph needed to verify it forwards the right request.
describe('createForceToolChoiceMiddleware', () => {
  it('forces toolChoice to the named function when runtime.configurable.forceToolChoice is set', async () => {
    const middleware = createForceToolChoiceMiddleware();
    const handler = vi.fn().mockResolvedValue('ai-message');
    const request = { runtime: { configurable: { forceToolChoice: 'create_plan' } } };

    const result = await middleware.wrapModelCall!(request as never, handler);

    expect(handler).toHaveBeenCalledWith({
      ...request,
      toolChoice: { type: 'function', function: { name: 'create_plan' } },
    });
    expect(result).toBe('ai-message');
  });

  it('passes the request through unchanged when no caller sets forceToolChoice', async () => {
    const middleware = createForceToolChoiceMiddleware();
    const handler = vi.fn().mockResolvedValue('ai-message');
    const request = { runtime: { configurable: { thread_id: 'discovery:user-1' } } };

    await middleware.wrapModelCall!(request as never, handler);

    expect(handler).toHaveBeenCalledWith(request);
  });
});
