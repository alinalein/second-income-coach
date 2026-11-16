import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebSearchTool } from './web_search.js';

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

    const handle = await getWebSearchTool({ TAVILY_API_KEY: 'test-key' });

    expect(handle.tool.name).toBe('tavily_tavily_search');
  });

  it('throws the documented error when no tool name matches the suffix', async () => {
    listToolsMock.mockResolvedValue([fakeTool('tavily_tavily_extract'), fakeTool('tavily_tavily_crawl')]);

    await expect(getWebSearchTool({ TAVILY_API_KEY: 'test-key' })).rejects.toThrow(
      /tavily-mcp did not expose a '\*tavily_search' tool/,
    );
  });
});
