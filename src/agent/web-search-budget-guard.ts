import { ToolMessage } from '@langchain/core/messages';
import type { Command } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { ToolCallHandler, ToolCallRequest } from 'langchain';
import type { createDb } from '../db/client.js';
import { applyForcedSearchParams } from '../tools/mcp/web_search.js';
import { incrementAndGetSearchBudgetCount } from '../tools/plain/usage_limits.js';

type Db = ReturnType<typeof createDb>['db'];

/** Story 2.11 (AC2): "a hard cap on the number of searches per run applies
 * (one tunable constant, default 6)." Counts only real network calls —
 * never a cache hit (per-user below, or AD-7's own short-TTL shared cache
 * one layer further in), since a cache hit costs nothing. */
export const MAX_SEARCHES_PER_RUN = 6;

/** Story 2.11 (AC3): "an identical normalized query by the same user within
 * a configurable window (default 24 h)." */
export const PER_USER_QUERY_CACHE_WINDOW_MS = 24 * 60 * 60_000;

interface PerUserCacheEntry {
  content: string;
  expiresAt: number;
}

/**
 * Review fix: a fresh `generate_ideas` call builds a fresh guard hook
 * (`defaultGenerateDrafts`, `generate_ideas.ts`), so defaulting to a new,
 * function-local `Map` here meant the per-user cache never actually
 * survived past the one call that created it — "24h reuse" (AC3) never
 * fired across separate runs (e.g. two "Generate new ideas" clicks), only
 * ever within one run's own retry loop. Module-level and shared across
 * every hook instance, same precedent as `moderation-web-search.ts`'s own
 * `sharedWebSearchCache` — it is still per-*user* only because the cache
 * key itself is `${userId}:${intakeVersion}:${query}` (below), never
 * shared across different users or a changed intake.
 */
const sharedPerUserQueryCache = new Map<string, PerUserCacheEntry>();

export interface WebSearchBudgetGuardOptions {
  userId: string;
  /** Story 2.11 (AC3): "invalidated when intake changes" — folded directly
   * into the cache key (e.g. the intake row's own `updatedAt`), so a
   * changed intake can never hit a stale entry; no separate invalidation
   * pass is needed. */
  intakeVersion: string;
  /** `DAILY_SEARCH_BUDGET` (`src/config/env.ts`). */
  dailySearchBudget: number;
  maxSearchesPerRun?: number;
  cacheWindowMs?: number;
  /** Test-only seam for a deterministic clock. */
  now?: () => number;
  /** Test-only seam — same precedent as `moderation-web-search.ts`'s
   * `options.cache`: inject the cache instance directly to assert on it, or
   * pre-seed a hit. */
  cache?: Map<string, PerUserCacheEntry>;
  /** Test-only seam/observability hook for a cap being hit. */
  onCapHit?: (reason: 'per_run_cap' | 'shared_budget') => void;
  /** Test-only seam: replaces the real Postgres upsert-increment (CLAUDE.md:
   * framework/DB-driver behavior is covered once, for real, in
   * `usage_limits.test.ts` — not re-exercised here through a fake `Db`). */
  incrementSearchBudgetCount?: (db: Db, now: Date) => Promise<number>;
}

function requireToolCallId(id: string | undefined): string {
  if (!id) {
    throw new Error('web_search budget guard: toolCall.id is unexpectedly undefined');
  }
  return id;
}

/** Story 2.11 (AC3): "an identical normalized query" — whitespace/case
 * differences are the same query. */
export function normalizeSearchQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(query ?? null);
}

/** Log hygiene (AD-30): counts/reasons only, never query text or search
 * content. */
function logCapHit(reason: 'per_run_cap' | 'shared_budget', extra: Record<string, unknown>): void {
  console.log('[web-search-budget-guard] cap_hit', { reason, ...extra });
}

/**
 * Story 2.11: the search-budget guard's raw hook, composed as the *outer*
 * `wrapToolCall` ahead of `createWebSearchModerationMiddleware` in
 * `generate_ideas.ts`'s nested agent (`middleware: [budgetGuard,
 * moderation]`) — so `handler` here is "moderation, then the real tool."
 *
 * A per-user cache hit returns already-moderated content directly, without
 * reaching the moderation hook or the real network call at all — AC3's
 * "only moderated results are stored" holds by construction, since the only
 * place this ever writes to the cache is after `handler` (which always runs
 * moderation next) has returned.
 *
 * Approximation, stated honestly: the shared daily search-budget counter
 * increments once per call that reaches this point (i.e. everything this
 * guard's own per-user cache and per-run cap didn't already shortcut) — on
 * the rare occasion AD-7's own short-TTL cache, one layer further in, would
 * also have deduped the same exact-args call, this counts it anyway. That
 * errs conservative (never undercounts real usage), not toward hiding it.
 */
export function createWebSearchBudgetGuardHook(
  db: Db,
  options: WebSearchBudgetGuardOptions,
): (request: ToolCallRequest, handler: ToolCallHandler) => Promise<ToolMessage | Command> {
  const maxSearchesPerRun = options.maxSearchesPerRun ?? MAX_SEARCHES_PER_RUN;
  const cacheWindowMs = options.cacheWindowMs ?? PER_USER_QUERY_CACHE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedPerUserQueryCache;
  const incrementSearchBudgetCount = options.incrementSearchBudgetCount ?? incrementAndGetSearchBudgetCount;
  let realSearchCount = 0;
  let perRunCapLogged = false;

  return async function webSearchBudgetGuardHook(request, handler) {
    const toolCallId = requireToolCallId(request.toolCall.id);
    const args = (request.toolCall.args ?? {}) as Record<string, unknown>;
    const cacheKey = `${options.userId}:${options.intakeVersion}:${normalizeSearchQuery(args.query)}`;

    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return new ToolMessage({ content: cached.content, tool_call_id: toolCallId });
    }

    if (realSearchCount >= maxSearchesPerRun) {
      if (!perRunCapLogged) {
        perRunCapLogged = true;
        logCapHit('per_run_cap', { userId: options.userId, maxSearchesPerRun });
      }
      options.onCapHit?.('per_run_cap');
      // AC2: "the run continues with what it has" — a plain tool result,
      // never a thrown/rejected tool call, so the nested agent keeps going.
      return new ToolMessage({
        content: 'Search limit for this run has been reached. Continue with the results already gathered.',
        tool_call_id: toolCallId,
      });
    }

    const sharedBudgetUsed = await incrementSearchBudgetCount(db, new Date(now()));
    if (sharedBudgetUsed > options.dailySearchBudget) {
      logCapHit('shared_budget', { dailySearchBudget: options.dailySearchBudget, sharedBudgetUsed });
      options.onCapHit?.('shared_budget');
      return new ToolMessage({
        content: "Today's shared search budget is used up. Continue with the results already gathered.",
        tool_call_id: toolCallId,
      });
    }

    realSearchCount += 1;
    // AC1: forced regardless of what the nested model itself requested.
    const forcedRequest: ToolCallRequest = { ...request, toolCall: { ...request.toolCall, args: applyForcedSearchParams(args) } };
    const result = await handler(forcedRequest);

    if (result instanceof ToolMessage) {
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      cache.set(cacheKey, { content, expiresAt: now() + cacheWindowMs });
    }

    return result;
  };
}

/** `createMiddleware`-wrapped form of the hook above, for the nested
 * agent's `middleware: [...]` in `src/tools/llm/generate_ideas.ts`. */
export function createWebSearchBudgetGuardMiddleware(db: Db, options: WebSearchBudgetGuardOptions) {
  return createMiddleware({
    name: 'WebSearchBudgetGuardMiddleware',
    wrapToolCall: createWebSearchBudgetGuardHook(db, options),
  });
}
