import { MCPAdapter } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { tool } from 'langchain';
import { z } from 'zod';
import type { Env } from '../../config/env.js';

/**
 * Story 2.11 (AC1): the cheapest settings this app ever issues to Tavily —
 * applied regardless of what the nested model itself requests. `max_results`
 * is Tavily's own schema minimum (`tavily-mcp`'s `max_results` has
 * `minimum: 5`), the smallest value the API accepts, not an arbitrary guess.
 * One config constant, per the AC.
 */
export const FORCED_SEARCH_PARAMS = {
  search_depth: 'basic',
  include_raw_content: false,
  max_results: 5,
} as const;

/**
 * Pure and deterministically testable (AC1, CLAUDE.md): merges the forced
 * settings over whatever args the nested model supplied, so they always win
 * — `query` and any other field the model set (`country`, `time_range`, ...)
 * pass through untouched. Applied at the single call site that dispatches a
 * real search (`src/agent/web-search-budget-guard.ts`).
 */
export function applyForcedSearchParams(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, ...FORCED_SEARCH_PARAMS };
}

/** Same post-`MCPAdapter.listTools()` prefixed name the live tool ends up
 * with (`TAVILY_SEARCH_TOOL_NAME_SUFFIX` below) — kept identical so nothing
 * downstream needs to know which mode is active. */
const STUB_SEARCH_TOOL_NAME = 'tavily_tavily_search';

/** `.passthrough()`: the nested model may still pass `search_depth`/
 * `max_results`/etc (ignored in stub mode, same as a live call would ignore
 * them once `applyForcedSearchParams` overrides them) — only `query` is
 * actually used to build the canned response. */
const stubSearchArgsSchema = z.object({ query: z.string() }).passthrough();

/**
 * Story 2.11 (AC4): `WEB_SEARCH_MODE=stub` — fixed, canned results, no
 * network call, no Tavily credit spent. Shaped like a real `tavily-mcp`
 * result (`Detailed Results:` / `Title:` / `URL:` / `Content:` blocks, see
 * `src/agent/moderation-web-search.ts`'s own block-split parsing) so the
 * rest of the pipeline sees the same text shape a live call would return.
 */
function buildStubSearchTool(): DynamicStructuredTool {
  return tool(
    ({ query }: { query: string }) =>
      `Detailed Results:\n\nTitle: Stub result for "${query}"\nURL: https://example.com/stub-search-result\n` +
      `Content: Fixed WEB_SEARCH_MODE=stub result for "${query}" — no network call was made and no Tavily ` +
      'credit was spent. A typical rate for this kind of work is around $25 per hour.',
    {
      name: STUB_SEARCH_TOOL_NAME,
      description: 'Stub web search (WEB_SEARCH_MODE=stub) — fixed canned results, no network call.',
      schema: stubSearchArgsSchema,
    },
  ) as unknown as DynamicStructuredTool;
}

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
export async function getWebSearchTool(env: Pick<Env, 'TAVILY_API_KEY' | 'WEB_SEARCH_MODE'>): Promise<WebSearchToolHandle> {
  // Story 2.11 (AC4): stub mode never spawns the real `tavily-mcp` process
  // at all — not just a canned response on top of a real connection — so
  // dev/test runs spend zero Tavily credits and need no real API key.
  if (env.WEB_SEARCH_MODE === 'stub') {
    return { tool: buildStubSearchTool(), close: () => Promise.resolve() };
  }

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
