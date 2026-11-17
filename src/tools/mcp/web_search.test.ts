import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MCPAdapter } from '@langchain/mcp-adapters';
import { getWebSearchTool, applyForcedSearchParams } from './web_search.js';

const listToolsMock = vi.fn();
const closeMock = vi.fn();

vi.mock('@langchain/mcp-adapters', () => ({
  MCPAdapter: vi.fn().mockImplementation(function MockMCPAdapter(this: unknown) {
    return { listTools: listToolsMock, close: closeMock };
  }),
}));

function fakeTool(name: string): DynamicStructuredTool {
  return { name } as unknown as DynamicStructuredTool;
}

beforeEach(() => {
  listToolsMock.mockReset();
  closeMock.mockReset();
});

// AD-5/Boundary: `MCPAdapter.listTools()` prefixes every `tavily-mcp` tool
// name with the server key, so selection must match by suffix among all of
// `tavily-mcp`'s real tool names, never just the one wanted.
describe('getWebSearchTool (suffix-match tool selection)', () => {
  it('picks the tool whose name ends with tavily_search among tavily-mcp\'s other real tool names', async () => {
    listToolsMock.mockResolvedValue([
      fakeTool('tavily_tavily_extract'),
      fakeTool('tavily_tavily_crawl'),
      fakeTool('tavily_tavily_search'),
      fakeTool('tavily_tavily_map'),
    ]);

    const handle = await getWebSearchTool({ TAVILY_API_KEY: 'test-key', WEB_SEARCH_MODE: 'live' });

    expect(handle.tool.name).toBe('tavily_tavily_search');
  });

  it('throws the documented error when no tool name matches the suffix', async () => {
    listToolsMock.mockResolvedValue([fakeTool('tavily_tavily_extract'), fakeTool('tavily_tavily_crawl')]);

    await expect(getWebSearchTool({ TAVILY_API_KEY: 'test-key', WEB_SEARCH_MODE: 'live' })).rejects.toThrow(
      /tavily-mcp did not expose a '\*tavily_search' tool/,
    );
  });
});

// Story 2.11 AC1: "forces the cheapest search settings ... regardless of
// what the nested model asks for".
describe('applyForcedSearchParams (Story 2.11 AC1)', () => {
  it('overrides depth/raw-content/max-results regardless of what was requested, leaving other fields untouched', () => {
    const result = applyForcedSearchParams({ query: 'freelance rates', search_depth: 'advanced', include_raw_content: true, max_results: 20, country: 'Germany' });

    expect(result).toEqual({ query: 'freelance rates', search_depth: 'basic', include_raw_content: false, max_results: 5, country: 'Germany' });
  });
});

// Story 2.11 AC4: "stub" returns fixed canned results with no network call
// and no credit use.
describe('getWebSearchTool (Story 2.11 AC4: WEB_SEARCH_MODE=stub)', () => {
  it('never constructs the real MCPAdapter and returns a fixed canned result with no network call', async () => {
    const handle = await getWebSearchTool({ TAVILY_API_KEY: 'unused', WEB_SEARCH_MODE: 'stub' });

    expect(MCPAdapter).not.toHaveBeenCalled();
    expect(handle.tool.name).toBe('tavily_tavily_search');

    const result = await handle.tool.invoke({ query: 'freelance writer rates' } as never);
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    expect(content).toContain('freelance writer rates');
    expect(content).toContain('Detailed Results:');

    await expect(handle.close()).resolves.toBeUndefined();
  });
});
