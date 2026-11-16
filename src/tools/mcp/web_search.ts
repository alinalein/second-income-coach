import { MCPAdapter } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Env } from '../../config/env.js';

/**
 * AD-5: "`@langchain/mcp-adapters` (2.0+) is the only MCP integration path
 * (`MCPAdapter` -> `listTools()` -> passed to `createAgent`)." Tavily
 * (`tavily-mcp`, stdio, spawned via `npx`) was chosen per the Intent —
 * purpose-built for agent search grounding, one env var, a simple stdio
 * server, no extra account/project setup beyond the API key.
 *
 * `tavily-mcp` exposes 5 tools (search/extract/crawl/map/research); this
 * story is scoped to exactly one of them — the other 4 are never returned,
 * so they can never reach `generate_ideas`'s nested agent even by accident.
 */
/**
 * `MCPAdapter.listTools()` prefixes each tool name with its server key (the
 * `servers.tavily` key below) — so the one we want comes back named
 * `tavily_tavily_search`, not the bare `tavily_search` the MCP server
 * itself advertises (verified directly against the real `tavily-mcp`
 * package, not assumed from its docs).
 */
const TAVILY_SEARCH_TOOL_NAME_SUFFIX = 'tavily_search';

export interface WebSearchToolHandle {
  tool: DynamicStructuredTool;
  /** Closes the underlying `MCPAdapter`'s `tavily-mcp` stdio child process
   * (`MCPAdapter.close()`) — callers (`src/api/index.ts`) must invoke this
   * on shutdown so the spawned `npx tavily-mcp` process doesn't leak as an
   * orphan on every restart. */
  close: () => Promise<void>;
}

/**
 * Constructs the `web_search` MCP tool, once, at API startup (`src/api/
 * index.ts`, before `createCoachAgent(...)`). The returned tool is passed
 * as a plain dependency into `generate_ideas`'s factory (Boundary: never
 * added to the outer agent's own `tools: [...]` in `src/agent/index.ts`) —
 * it's bound only inside that tool's own nested, bounded `createAgent`
 * instance, which is what makes "used only by `generate_ideas`" true at the
 * code level, not just a prompt convention.
 */
export async function getWebSearchTool(env: Pick<Env, 'TAVILY_API_KEY'>): Promise<WebSearchToolHandle> {
  const adapter = new MCPAdapter({
    servers: {
      tavily: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'tavily-mcp'],
        env: { TAVILY_API_KEY: env.TAVILY_API_KEY },
      },
    },
  });

  const tools = await adapter.listTools();
  const searchTool = tools.find((candidate) => candidate.name.endsWith(TAVILY_SEARCH_TOOL_NAME_SUFFIX));

  if (!searchTool) {
    throw new Error(`getWebSearchTool: tavily-mcp did not expose a '*${TAVILY_SEARCH_TOOL_NAME_SUFFIX}' tool`);
  }

  return { tool: searchTool, close: () => adapter.close() };
}
