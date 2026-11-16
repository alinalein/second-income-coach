import { describe, expect, it, vi } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import type { ToolCallHandler, ToolCallRequest } from 'langchain';
import { createWebSearchModerationHook } from './moderation-web-search.js';

function fakeRequest(query: string, id = 'call-1'): ToolCallRequest {
  return {
    toolCall: { id, name: 'tavily_search', args: { query } },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  } as unknown as ToolCallRequest;
}

/** The exact text shape the real `tavily-mcp` `tavily_search` tool returns
 * (verified directly against the installed package's own `formatResults`
 * source — `Detailed Results:` header, one blank-line-separated
 * `Title:`/`URL:`/`Content:` block per hit). */
function fakeTavilySearchResultText(): string {
  return [
    'Detailed Results:',
    '',
    'Title: Safe result',
    'URL: https://example.com/a',
    'Content: A normal freelance rate article.',
    '',
    'Title: Flagged result',
    'URL: https://example.com/b',
    'Content: contains something unsafe',
  ].join('\n');
}

// I/O matrix: "web_search result flagged" -> "Flagged portion stripped,
// search not rejected whole" (AD-11).
describe('createWebSearchModerationHook (AD-11: strip the flagged result, not the whole search)', () => {
  it('drops only the flagged result block and still returns the rest as a ToolMessage', async () => {
    // Flags only the individual flagged block, not the whole merged text (the
    // whole-text safety net runs on the full raw text first — matching only
    // this one block's own leading marker keeps that check from tripping on
    // content a different, later block carries).
    const classify = vi.fn(
      async (text: string): Promise<Record<string, boolean>> =>
        text.startsWith('Title: Flagged result') ? { dangerous: true } : {},
    );
    const handler: ToolCallHandler = vi.fn(
      async () => new ToolMessage({ content: fakeTavilySearchResultText(), tool_call_id: 'call-1' }),
    );

    // Story 2.2 follow-up fix 1c: the hook now defaults to one module-level
    // shared cache (so repeat queries across different `generate_ideas`
    // calls hit it, per AD-7) — inject an isolated `Map` here so this test
    // never collides with another test's cache entry for the same query.
    const hook = createWebSearchModerationHook({ MISTRAL_API_KEY: 'x' }, { classify, cache: new Map() });
    const result = await hook(fakeRequest('freelance rates'), handler);

    expect(result).toBeInstanceOf(ToolMessage);
    const content = (result as ToolMessage).content as string;
    expect(content).toContain('Safe result');
    expect(content).not.toContain('Flagged result');
    expect(content).not.toContain('unsafe');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// I/O matrix: "Repeat query within TTL" -> "Cache hit returns prior
// moderated result, no new MCP call, no re-moderation" (AD-7).
describe('createWebSearchModerationHook (AD-7: cache hit skips the call and re-moderation)', () => {
  it('returns the cached moderated result without calling handler or classify again', async () => {
    const classify = vi.fn(async () => ({}));
    const handler: ToolCallHandler = vi.fn(
      async () => new ToolMessage({ content: fakeTavilySearchResultText(), tool_call_id: 'call-1' }),
    );
    let currentTime = 0;
    const hook = createWebSearchModerationHook(
      { MISTRAL_API_KEY: 'x' },
      { classify, now: () => currentTime, cache: new Map() },
    );

    const first = await hook(fakeRequest('freelance rates', 'call-1'), handler);
    currentTime += 1000; // still well within the default TTL
    const second = await hook(fakeRequest('freelance rates', 'call-2'), handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(3); // once whole-text safety net + once per result block, on the miss only
    expect((second as ToolMessage).content).toBe((first as ToolMessage).content);
    expect((second as ToolMessage).tool_call_id).toBe('call-2');
  });
});

// `moderateSearchResult`'s non-Tavily-shaped fallback (`splitIntoResultBlocks`
// finds no `Detailed Results:` marker) — covered via the same whole-text
// `classify()` safety net the block-split path also runs first.
describe('createWebSearchModerationHook (fallback: content with no Detailed Results: marker)', () => {
  it.each([
    {
      name: 'flagged plain text becomes the placeholder',
      text: 'some unsafe plain text with no markers',
      expectPlaceholder: true,
    },
    {
      name: 'clean plain text passes through unchanged',
      text: 'some clean plain text with no markers',
      expectPlaceholder: false,
    },
  ])('$name', async ({ text, expectPlaceholder }) => {
    const classify = vi.fn(async (input: string): Promise<Record<string, boolean>> => (input.includes('unsafe') ? { dangerous: true } : {}));
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: text, tool_call_id: 'call-1' }));

    const hook = createWebSearchModerationHook({ MISTRAL_API_KEY: 'x' }, { classify, cache: new Map() });
    const result = await hook(fakeRequest('some query'), handler);

    const content = (result as ToolMessage).content as string;
    if (expectPlaceholder) {
      expect(content).toBe('[content removed by moderation]');
    } else {
      expect(content).toBe(text);
    }
  });
});
