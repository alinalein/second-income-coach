import { describe, expect, it, vi } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import {
  CHECKING_ANSWER,
  CHECKING_MESSAGE,
  createProgressMiddleware,
  GENERATING_RESPONSE,
  resolveToolStepKey,
  TOOL_FALLBACK,
} from './progress.js';

// I/O matrix: "Unmapped tool step (forward-looking; no tool exists yet) ...
// resolves to the fixed `tool_fallback` step key, never the raw tool name."
// `TOOL_STEP_REGISTRY` is empty until a tool-introducing story (Epic 2+)
// adds an entry, so every tool name is unmapped in this story.
describe('resolveToolStepKey (AC2/I/O matrix: unmapped tool step)', () => {
  it('falls back to the fixed generic key for any tool name, never the raw name', () => {
    expect(resolveToolStepKey('web_search')).toBe(TOOL_FALLBACK);
  });
});

/**
 * Hook-integration tests (same pattern as `moderation.test.ts`'s
 * `createModerationMiddleware (hook integration)` block): exercises the
 * actual hooks `createMiddleware` wires, not just the pure functions they
 * delegate to, so the "writes one fixed progress chunk, then passes the turn
 * through unchanged" contract (AC1) is covered end-to-end.
 */
describe('createProgressMiddleware (hook integration: AC1 progress chunks)', () => {
  it.each([
    ['beforeModel', CHECKING_MESSAGE],
    ['afterModel', CHECKING_ANSWER],
  ] as const)('%s writes a progress chunk for its fixed step key, then passes through', async (hookName, expectedStep) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `createMiddleware`'s return type doesn't narrow `beforeModel`/`afterModel` to the plain-function form we configured them with (same pattern as `moderation.test.ts`).
    const middleware = createProgressMiddleware() as any;
    const writer = vi.fn();

    const result = await middleware[hookName]({ messages: [] }, { writer });

    expect(writer).toHaveBeenCalledExactlyOnceWith({ type: 'progress', step: expectedStep });
    expect(result).toBeUndefined();
  });

  it('wrapModelCall writes the generating_response chunk, then calls the handler with the same request', async () => {
    const middleware = createProgressMiddleware();
    const writer = vi.fn();
    const request = { messages: [], runtime: { writer } };
    const handler = vi.fn().mockResolvedValue('model-response');

    const result = await middleware.wrapModelCall!(request as never, handler);

    expect(writer).toHaveBeenCalledExactlyOnceWith({ type: 'progress', step: GENERATING_RESPONSE });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toBe('model-response');
  });

  it("wrapToolCall writes the tool's resolved step key (fallback, since the registry is empty), then calls the handler", async () => {
    const middleware = createProgressMiddleware();
    const writer = vi.fn();
    const toolMessage = new ToolMessage({ content: 'tool result', tool_call_id: 'call-1' });
    const request = { toolCall: { name: 'web_search', args: {}, id: 'call-1' }, tool: undefined, runtime: { writer } };
    const handler = vi.fn().mockResolvedValue(toolMessage);

    const result = await middleware.wrapToolCall!(request as never, handler);

    expect(writer).toHaveBeenCalledExactlyOnceWith({ type: 'progress', step: TOOL_FALLBACK });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toBe(toolMessage);
  });
});
