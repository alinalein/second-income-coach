import { ToolMessage } from '@langchain/core/messages';
import type { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { ToolCallHandler, ToolCallRequest } from 'langchain';
import type { Env } from '../config/env.js';
import { defaultClassify, type ClassifyText } from './moderation.js';

/**
 * AD-7: "`web_search` gets a short-TTL `CachePolicy` ... Moderation
 * screening (AD-11) must complete before any `web_search` result is written
 * to this cache." Boundary: `createAgent`'s compiled graph has no per-tool
 * `setNodeDefaults` seam, so this hand-rolled cache replaces the literal
 * `CachePolicy` AD-7 describes, at the one call site (this hook) it applies
 * to. 5 minutes is a reasonable starting TTL for a market-rate lookup that
 * repeats across users/sessions — not a tuned/measured value.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  content: string;
  expiresAt: number;
}

export interface WebSearchModerationOptions {
  /** Test-only seam — see `ClassifyText`. */
  classify?: ClassifyText;
  cacheTtlMs?: number;
  /** Test-only seam for a deterministic clock. */
  now?: () => number;
  /** Test-only seam: inject the cache instance directly to assert on it, or
   * to pre-seed a hit. */
  cache?: Map<string, CacheEntry>;
}

function isFlagged(categories: Record<string, boolean>): boolean {
  return Object.values(categories).some((value) => value === true);
}

const WEB_SEARCH_FLAGGED_PLACEHOLDER = '[content removed by moderation]';

/** The literal label `tavily-mcp`'s own `formatResults`/`formatCrawlResults`
 * puts ahead of the per-result blocks (verified directly against the
 * installed `tavily-mcp` package's source, not assumed from its docs) — one
 * blank-line-separated `Title: .../URL: .../Content: ...` block per result,
 * optionally followed by an `Images:` section. */
const RESULTS_MARKER = 'Detailed Results:';
const IMAGES_MARKER = '\nImages:';
const BLOCK_SPLIT_PATTERN = /\n\n(?=Title: )/;

interface TextBlockResult {
  prefix: string;
  blocks: string[];
  suffix: string;
}

function splitIntoResultBlocks(rawText: string): TextBlockResult | undefined {
  const markerIndex = rawText.indexOf(RESULTS_MARKER);
  if (markerIndex === -1) return undefined;

  const prefix = rawText.slice(0, markerIndex + RESULTS_MARKER.length);
  const afterMarker = rawText.slice(markerIndex + RESULTS_MARKER.length);

  const imagesIndex = afterMarker.indexOf(IMAGES_MARKER);
  const resultsText = imagesIndex === -1 ? afterMarker : afterMarker.slice(0, imagesIndex);
  const suffix = imagesIndex === -1 ? '' : afterMarker.slice(imagesIndex);

  const blocks = resultsText
    .split(BLOCK_SPLIT_PATTERN)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return blocks.length > 0 ? { prefix, blocks, suffix } : undefined;
}

/**
 * AD-11: "`wrapToolCall` around `web_search` screens untrusted external
 * search results before they re-enter model context ... clean up/strip the
 * flagged portion rather than rejecting the whole search, log." `web_search`
 * is `tavily-mcp`'s `tavily_search` tool, whose result is one `Title: .../
 * URL: .../Content: ...` text block per search hit under a `Detailed
 * Results:` header — "the flagged portion" is interpreted at that
 * granularity: each block is classified individually, and only the flagged
 * ones are dropped, so a single bad search hit never fails the whole tool
 * call. Content that doesn't match this shape (defensive fallback) is
 * classified whole and replaced with a neutral placeholder when flagged —
 * still a returned `ToolMessage`, never a rejected/thrown tool call.
 *
 * Defense-in-depth: the block split itself trusts literal text markers
 * (`Detailed Results:`, `Title:`, `\nImages:`) with no protection if an
 * untrusted `Content:` field happens to contain those exact substrings, and
 * a trailing `Images:` section is never individually classified at all. A
 * whole-text `classify()` call is one of the checks below as a safety net —
 * if the full raw text alone trips moderation, this falls back straight to
 * full-text redaction instead of trusting the (possibly-confusable)
 * per-block split.
 *
 * Latency (Story 2.2 follow-up fix 1b): the whole-text safety-net check and
 * every per-block check are the exact same set of `classify()` calls as
 * before — none removed, none merged (each checks genuinely different
 * input) — just started together via `Promise.all` instead of `await`ed one
 * at a time, so this function's own latency is bounded by its single
 * slowest classify call instead of their sum. Measured against a real
 * search result with several blocks, this was the dominant cost inside one
 * `web_search` tool call (see the spec's Spec Change Log for before/after
 * numbers).
 */
async function moderateSearchResult(
  rawText: string,
  classify: ClassifyText,
): Promise<{ text: string; flaggedCount: number }> {
  const parsed = splitIntoResultBlocks(rawText);

  const [wholeTextCategories, blockCategories] = await Promise.all([
    classify(rawText),
    parsed ? Promise.all(parsed.blocks.map((block) => classify(block))) : Promise.resolve([]),
  ]);

  if (isFlagged(wholeTextCategories)) {
    return { text: WEB_SEARCH_FLAGGED_PLACEHOLDER, flaggedCount: 1 };
  }

  if (!parsed) {
    return { text: rawText, flaggedCount: 0 };
  }

  let flaggedCount = 0;
  const keptBlocks: string[] = [];

  parsed.blocks.forEach((block, index) => {
    if (isFlagged(blockCategories[index]!)) {
      flaggedCount += 1; // AD-11: strip just this flagged result, keep the rest.
      return;
    }
    keptBlocks.push(block);
  });

  const text = `${parsed.prefix}\n\n${keptBlocks.join('\n\n')}${parsed.suffix}`;
  return { text, flaggedCount };
}

/**
 * Boundary: "No log destination ... ever contains raw user message text —
 * only flags/categories/ids/lengths." Same hygiene rule as
 * `logModerationIncident` in `moderation.ts`, applied locally here since
 * `web_search_result_flagged` isn't one of that function's fixed event
 * names (jailbreak/PII/unsafe-output are user/assistant-turn concepts;
 * this is a tool-result concept).
 */
function logWebSearchFlagged(flaggedCount: number, length: number): void {
  console.warn('[moderation] web_search_result_flagged', { flaggedCount, length });
}

/** `toolCall.id` pairs a `ToolMessage` back to its originating call in the
 * message history — defaulting a missing one to `''` would silently break
 * that pairing. This should be unreachable via the real `createAgent`/
 * `ToolNode` dispatch (which always assigns an id), so failing loudly here
 * is safer than a silent empty-string fallback. */
function requireToolCallId(id: string | undefined): string {
  if (!id) {
    throw new Error('web_search moderation hook: toolCall.id is unexpectedly undefined');
  }
  return id;
}

/**
 * Story 2.2 follow-up fix 1c: a single module-level cache, shared by every
 * `createWebSearchModerationHook` call that doesn't inject its own (tests
 * always inject one via `options.cache`, for isolation). Previously each
 * `generate_ideas` invocation built its own fresh `Map` (inside
 * `defaultGenerateDrafts`'s per-call `createWebSearchModerationMiddleware`),
 * so a cache hit could only ever happen *within* one call's own ~6-iteration
 * run, never across different users'/calls' identical-query lookups — this
 * is what AD-7 actually asks for ("market-rate lookups repeat across
 * users/sessions"). The 5-minute TTL (`DEFAULT_CACHE_TTL_MS`) bounds how
 * stale a shared, cross-call result can be.
 */
const sharedWebSearchCache = new Map<string, CacheEntry>();

/**
 * The raw `(request, handler) => ...` hook (Design Notes: exported both raw
 * — for direct unit testing with fakes — and `createMiddleware`-wrapped,
 * below). On a cache hit (same query, within the TTL), `handler` — the real
 * `web_search` MCP call — is never invoked and the result is never
 * re-moderated (AD-7: the cached value is always already-moderated). On a
 * miss, the real call runs, its result is moderated, and only the
 * already-moderated text is written to the cache.
 */
export function createWebSearchModerationHook(
  env: Pick<Env, 'MISTRAL_API_KEY'>,
  options: WebSearchModerationOptions = {},
): (request: ToolCallRequest, handler: ToolCallHandler) => Promise<ToolMessage | Command> {
  const classify = options.classify ?? defaultClassify(env);
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedWebSearchCache;

  return async function webSearchModerationHook(request, handler) {
    const toolCallId = requireToolCallId(request.toolCall.id);
    // Key on the full args object (depth/max-results/topic/etc., not just
    // `query`) — `JSON.stringify(undefined)` is the literal value
    // `undefined` (not a string), so `?? {}` keeps this a proper string key
    // even when `args` itself is undefined.
    const cacheKey = JSON.stringify(request.toolCall.args ?? {});

    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return new ToolMessage({ content: cached.content, tool_call_id: toolCallId });
    }

    const result = await handler(request);
    // A `Command` (advanced control flow) carries no external-search text to
    // moderate or cache — pass it through untouched.
    if (!(result instanceof ToolMessage)) return result;

    const rawText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const { text: moderatedText, flaggedCount } = await moderateSearchResult(rawText, classify);

    if (flaggedCount > 0) {
      logWebSearchFlagged(flaggedCount, rawText.length);
    }

    cache.set(cacheKey, { content: moderatedText, expiresAt: now() + ttlMs });

    return new ToolMessage({ content: moderatedText, tool_call_id: toolCallId });
  };
}

/**
 * `createMiddleware`-wrapped form of the hook above, for the nested agent's
 * `middleware: [...]` in `src/tools/llm/generate_ideas.ts`.
 */
export function createWebSearchModerationMiddleware(
  env: Pick<Env, 'MISTRAL_API_KEY'>,
  options: WebSearchModerationOptions = {},
) {
  return createMiddleware({
    name: 'WebSearchModerationMiddleware',
    wrapToolCall: createWebSearchModerationHook(env, options),
  });
}
