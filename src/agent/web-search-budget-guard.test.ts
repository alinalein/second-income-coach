import { describe, expect, it, vi } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import type { ToolCallHandler, ToolCallRequest } from 'langchain';
import { createWebSearchBudgetGuardHook, normalizeSearchQuery, type WebSearchBudgetGuardOptions } from './web-search-budget-guard.js';

function fakeRequest(query: string, id = 'call-1'): ToolCallRequest {
  return {
    toolCall: { id, name: 'tavily_search', args: { query } },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  } as unknown as ToolCallRequest;
}

// The hook now defaults to one module-level shared cache (review fix — see
// the hook's own comment), so every test here injects its own isolated
// `Map` by default, same precedent as `moderation-web-search.test.ts`: no
// test collides with another test's cache entry for the same
// userId/intakeVersion/query.
function baseOptions(overrides: Partial<WebSearchBudgetGuardOptions> = {}): WebSearchBudgetGuardOptions {
  return {
    userId: 'user-1',
    intakeVersion: '2026-01-01T00:00:00.000Z',
    dailySearchBudget: 1000,
    incrementSearchBudgetCount: vi.fn().mockResolvedValue(1),
    cache: new Map(),
    ...overrides,
  };
}

// Story 2.11 AC3: "an identical normalized query" is the same query
// regardless of whitespace/case.
describe('normalizeSearchQuery (Story 2.11 AC3: query normalization)', () => {
  it.each([
    ['freelance writer rates', '  Freelance   Writer Rates  ', 'freelance writer rates'],
    ['already normalized', 'already normalized', 'already normalized'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeSearchQuery(input)).toBe(expected);
  });
});

describe('createWebSearchBudgetGuardHook', () => {
  // Story 2.11 AC1: "a thin wrapper ... forces the cheapest search settings
  // ... regardless of what the nested model asks for."
  it('AC1: forces the cheap search params onto the handler call regardless of the requested args', async () => {
    const handler: ToolCallHandler = vi.fn(async (req) => new ToolMessage({ content: JSON.stringify(req.toolCall.args), tool_call_id: 'call-1' }));
    const hook = createWebSearchBudgetGuardHook({} as never, baseOptions());

    await hook(fakeRequest('freelance rates'), handler);

    const calledWith = (handler as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ToolCallRequest;
    expect(calledWith.toolCall.args).toMatchObject({ query: 'freelance rates', search_depth: 'basic', include_raw_content: false, max_results: 5 });
  });

  // Story 2.11 AC2: "a hard cap on the number of searches per run applies
  // ... the run continues with what it has once the cap is reached, and the
  // cap hit is logged."
  it('AC2: once the per-run cap is reached, further calls skip the handler and log the hit instead of erroring', async () => {
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: 'real result', tool_call_id: 'call-1' }));
    const onCapHit = vi.fn();
    const hook = createWebSearchBudgetGuardHook({} as never, baseOptions({ maxSearchesPerRun: 2, onCapHit }));

    await hook(fakeRequest('query a', 'call-1'), handler);
    await hook(fakeRequest('query b', 'call-2'), handler);
    const third = await hook(fakeRequest('query c', 'call-3'), handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(third).toBeInstanceOf(ToolMessage);
    expect((third as ToolMessage).content).not.toBe('real result');
    expect(onCapHit).toHaveBeenCalledWith('per_run_cap');
  });

  // Story 2.11 AC6: the shared daily search budget degrades a run the same
  // way the per-run cap does, mid-run.
  it('AC6: once the shared Postgres search budget is exhausted, further calls skip the handler the same way', async () => {
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: 'real result', tool_call_id: 'call-1' }));
    const onCapHit = vi.fn();
    const incrementSearchBudgetCount = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(6);
    const hook = createWebSearchBudgetGuardHook({} as never, baseOptions({ dailySearchBudget: 5, incrementSearchBudgetCount, onCapHit }));

    const first = await hook(fakeRequest('query a', 'call-1'), handler);
    const second = await hook(fakeRequest('query b', 'call-2'), handler);

    expect(first).toBeInstanceOf(ToolMessage);
    expect((first as ToolMessage).content).toBe('real result');
    expect(handler).toHaveBeenCalledTimes(1);
    expect((second as ToolMessage).content).not.toBe('real result');
    expect(onCapHit).toHaveBeenCalledWith('shared_budget');
  });

  // Story 2.11 AC3: per-user, 24h-windowed, normalized-query cache — never
  // shared across users, invalidated by a changed intake version, and only
  // ever holds a result that already came back from `handler` (i.e.
  // already-moderated, since moderation is the next link in the chain).
  it.each([
    {
      case: 'same user/query/intake within the window',
      optionsOverride: {},
      secondRequest: fakeRequest('freelance rates', 'call-2'),
      expectSecondHandlerCall: false,
    },
    {
      case: 'a different user',
      optionsOverride: { userId: 'user-2' },
      secondRequest: fakeRequest('freelance rates', 'call-2'),
      expectSecondHandlerCall: true,
    },
    {
      case: 'a changed intake version',
      optionsOverride: { intakeVersion: '2026-02-01T00:00:00.000Z' },
      secondRequest: fakeRequest('freelance rates', 'call-2'),
      expectSecondHandlerCall: true,
    },
    {
      case: 'the exact same query normalized differently',
      optionsOverride: {},
      secondRequest: fakeRequest('  FREELANCE   rates  ', 'call-2'),
      expectSecondHandlerCall: false,
    },
  ])('AC3: $case -> handler called again on the second request: $expectSecondHandlerCall', async ({ optionsOverride, secondRequest, expectSecondHandlerCall }) => {
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: 'real result', tool_call_id: 'call-1' }));
    const sharedCache = new Map();

    // First call always establishes the cache entry under the base options.
    const firstHook = createWebSearchBudgetGuardHook({} as never, baseOptions({ cache: sharedCache }));
    await firstHook(fakeRequest('freelance rates', 'call-1'), handler);
    expect(handler).toHaveBeenCalledTimes(1);

    // Second call reuses the same cache but under a fresh hook instance —
    // each `generate_ideas` call builds its own guard, but the test needs a
    // *second* hook here only because the per-run cap counter is per-hook;
    // the per-user cache (`sharedCache`) is what this case actually checks.
    const secondHook = createWebSearchBudgetGuardHook({} as never, baseOptions({ cache: sharedCache, ...optionsOverride }));
    await secondHook(secondRequest, handler);

    expect(handler).toHaveBeenCalledTimes(expectSecondHandlerCall ? 2 : 1);
  });

  it('AC3: a cache hit expires after the configured window, causing a real call again', async () => {
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: 'real result', tool_call_id: 'call-1' }));
    let currentTime = 0;
    const cache = new Map();
    const hook = createWebSearchBudgetGuardHook({} as never, baseOptions({ cache, cacheWindowMs: 1000, now: () => currentTime }));

    await hook(fakeRequest('freelance rates', 'call-1'), handler);
    currentTime += 1001; // just past the window
    await hook(fakeRequest('freelance rates', 'call-2'), handler);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  // Review fix regression test: a fresh `generate_ideas` call builds a
  // fresh hook instance (`defaultGenerateDrafts`), so this is the one case
  // that must use the *real* default (no `cache` option at all) — proving
  // the cache genuinely survives across two separate hook instances, not
  // just across two calls into the same one.
  it('AC3: the real default cache (no option supplied) persists across two separate hook instances', async () => {
    const handler: ToolCallHandler = vi.fn(async () => new ToolMessage({ content: 'real result', tool_call_id: 'call-1' }));
    const uniqueUserId = `user-${Math.random()}`;

    const firstHook = createWebSearchBudgetGuardHook({} as never, {
      userId: uniqueUserId,
      intakeVersion: '2026-01-01T00:00:00.000Z',
      dailySearchBudget: 1000,
      incrementSearchBudgetCount: vi.fn().mockResolvedValue(1),
    });
    await firstHook(fakeRequest('freelance rates', 'call-1'), handler);

    const secondHook = createWebSearchBudgetGuardHook({} as never, {
      userId: uniqueUserId,
      intakeVersion: '2026-01-01T00:00:00.000Z',
      dailySearchBudget: 1000,
      incrementSearchBudgetCount: vi.fn().mockResolvedValue(1),
    });
    await secondHook(fakeRequest('freelance rates', 'call-2'), handler);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
