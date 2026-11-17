import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import {
  ideasWithPlanResponseSchema,
  currencyCodeSchema,
  replyLanguageSchema,
  translateIdeasRequestSchema,
  translateIdeasResponseSchema,
  type CurrencyCode,
  type IdeaResponse,
  type GenerateLimitStatus,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildDiscoveryThreadId, buildIdeasTriggerThreadId } from '../../agent/index.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { createChatModel } from '../../agent/model.js';
import { TRANSLATION_MODEL_ID } from '../../agent/registry.js';
import { translateIdeaCards as defaultTranslateIdeaCards } from '../../agent/translate-idea-cards.js';
import {
  getIdeasByUserId,
  handleGenerateIdeas,
  SearchServiceUnavailableError,
  type GenerateIdeasDeps,
} from '../../tools/llm/generate_ideas.js';
import { setIdeaStatus, IdeaNotFoundError, settableIdeaStatusSchema } from '../../tools/plain/set_idea_status.js';
import {
  getUserGenerationCount,
  incrementAndGetUserGenerationCount,
  refundUserGeneration,
  getSearchBudgetCount,
  getNextUtcResetIso,
  isUnlimitedUser,
} from '../../tools/plain/usage_limits.js';
import { userSettings, plans } from '../../db/schema/index.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';

/** AC1/AC3: the body `POST /:id/status` accepts — just the new status; the
 * target idea comes from the `:id` route param, validated separately as a
 * UUID below. */
const setIdeaStatusRequestSchema = z.object({ status: settableIdeaStatusSchema });

/** Story 2.7 (AC4): `POST /generate`'s optional body — when the client
 * supplies `language` (the UI's own `i18n.language`, the button-triggered
 * path), it is used directly as `replyLanguage`, skipping
 * `detectUserReplyLanguage` below entirely. `.partial()` keeps this
 * backward-compatible with a bodyless/pre-Story-2.7 call (falls back to the
 * old detection), and a malformed value is treated the same as "not
 * supplied" rather than a 400 — this is a UX nicety, not a security
 * boundary, so a client bug degrades to the old behavior instead of
 * failing the request. */
const generateIdeasRequestSchema = z.object({ language: replyLanguageSchema }).partial();

export interface IdeasRouterDeps {
  env: Pick<
    Env,
    | 'RATE_LIMIT_WINDOW_MS'
    | 'OPENROUTER_API_KEY'
    | 'MISTRAL_API_KEY'
    | 'IDEAS_PER_BATCH'
    | 'DAILY_SEARCH_BUDGET'
    | 'DAILY_GENERATIONS_PER_USER'
    | 'UNLIMITED_USER_EMAILS'
  >;
  db: ReturnType<typeof createDb>['db'];
  /** Story 2.10: `generate_ideas` itself is no longer invoked through this —
   * `handleGenerateIdeas` is called directly below. Still `ideasAgent`
   * (longer node timeout), used only for `detectUserReplyLanguage`
   * (`.getState`). */
  agent: CoachAgent;
  /** Story 2.10: the shared chat model `handleGenerateIdeas` calls directly
   * — same `Deps`/`Config`/`Args` shape `generate_ideas.ts`'s own tool
   * wrapper (`createGenerateIdeasTool`) already used. */
  model: BaseChatModel;
  /** Story 2.10: the shared `web_search` MCP tool, passed through to the
   * same direct `handleGenerateIdeas` call. */
  webSearchTool: DynamicStructuredTool;
  /** Test-only seam: same DI precedent as `GenerateIdeasDeps.generateDrafts`
   * (`generate_ideas.ts`) — replaces the real nested-agent draft call with a
   * fake. */
  generateDrafts?: GenerateIdeasDeps['generateDrafts'];
  /** Test-only seam — same DI precedent as `GenerateIdeasDeps.generateDrafts`
   * (`generate_ideas.ts`): lets a test replace the real model-backed
   * `translateIdeaCards` call with a fake, so `POST /translate`'s own
   * routing/ownership-check/error-mapping logic is exercised without a real
   * OpenRouter call. Defaults to the real implementation. */
  translateIdeaCards?: typeof defaultTranslateIdeaCards;
}

type Db = IdeasRouterDeps['db'];

/** AD-27: "`set_currency` defaults to EUR" — same default applied here when
 * a row is somehow missing/malformed, so this route never 500s on it. */
async function getUserCurrency(db: Db, userId: string): Promise<CurrencyCode> {
  const [row] = await db.select({ currency: userSettings.currency }).from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  const parsed = currencyCodeSchema.safeParse(row?.currency);
  return parsed.success ? parsed.data : 'EUR';
}

/**
 * Story 2.11 (AC5/AC6): read-only — never increments anything itself, so
 * it's safe to call from `GET /` on every page load. Used there (so the
 * generate button is disabled *before* the user ever clicks it) and again
 * after `POST /generate` runs (so its response reflects the now-updated
 * counts). The shared budget is checked first: if it's gone, that's true
 * for every user regardless of their own count, so it's the more honest
 * reason to report.
 */
async function computeGenerateLimitStatus(
  db: Db,
  env: Pick<Env, 'DAILY_SEARCH_BUDGET' | 'DAILY_GENERATIONS_PER_USER' | 'UNLIMITED_USER_EMAILS'>,
  userId: string,
  now: Date = new Date(),
): Promise<GenerateLimitStatus> {
  const [userGenerationsUsed, sharedSearchesUsed, unlimited] = await Promise.all([
    getUserGenerationCount(db, userId, now),
    getSearchBudgetCount(db, now),
    isUnlimitedUser(db, userId, env),
  ]);

  if (sharedSearchesUsed >= env.DAILY_SEARCH_BUDGET) {
    return { blocked: true, reason: 'shared_budget', limit: null, resetsAt: getNextUtcResetIso(now) };
  }
  // Story 2.11 follow-up: an unlimited user skips only this check — the
  // shared budget check above still applies to them unchanged.
  if (!unlimited && userGenerationsUsed >= env.DAILY_GENERATIONS_PER_USER) {
    return { blocked: true, reason: 'user_limit', limit: env.DAILY_GENERATIONS_PER_USER, resetsAt: getNextUtcResetIso(now) };
  }
  return { blocked: false, reason: null, limit: null, resetsAt: null };
}

/**
 * Story 2.8 AC5: derived, read-only `hasPlan` flag — a plain join against
 * the `plans` table (`plans.ideaId` is already a unique FK,
 * `src/db/schema/plans.ts:20-23` — no migration needed). Computed here,
 * not in `generate_ideas.ts` (Design Notes): the Boundary against touching
 * the idea-generation backend is about the LLM-backed write path, and this
 * route already shapes its own response (e.g. the `status !== 'rejected'`
 * filter), so a derived read-only join belongs at the same layer.
 */
async function attachHasPlan(db: Db, userId: string, records: IdeaResponse[]): Promise<Array<IdeaResponse & { hasPlan: boolean }>> {
  const planRows = await db.select({ ideaId: plans.ideaId }).from(plans).where(eq(plans.userId, userId));
  const ideaIdsWithPlan = new Set(planRows.map((row) => row.ideaId));
  return records.map((idea) => ({ ...idea, hasPlan: ideaIdsWithPlan.has(idea.id) }));
}

/**
 * Story 2.2 follow-up fix 4: the user's discovery thread is read-only here
 * — its last human message is used purely to *detect* a reply language
 * server-side (AD-25's own mechanism, `detectReplyLanguage`), never to
 * supply intake data. `generate_ideas` itself still reads intake directly
 * from Postgres by user id (`getIntakeByUserId`, `generate_ideas.ts`) —
 * this function has no bearing on that at all. Falls back to `'en'`
 * (Story 1.4/AD-25's own established default) when the discovery thread
 * has no human message yet.
 *
 * Exported since round 7 (speed, AD-7): `intake.ts`'s own trigger reuses
 * this exact same detection to pick the reply language its intake-save
 * prefetch (`generate_ideas.ts`'s `prefetchSearchResults`) plans searches
 * in, rather than duplicating the logic.
 */
export async function detectUserReplyLanguage(agent: CoachAgent, discoveryThreadId: string): Promise<'de' | 'en'> {
  try {
    const state = await agent.getState({ configurable: { thread_id: discoveryThreadId } });
    const messages = (state.values.messages ?? []) as BaseMessage[];
    const lastHuman = [...messages].reverse().find((message) => message._getType() === 'human');
    return lastHuman?.text ? detectReplyLanguage(lastHuman.text) : 'en';
  } catch {
    return 'en';
  }
}

/**
 * `createIdeasRouter`: `GET /` (AC1 — plain read, never a LangChain tool)
 * and `POST /generate` (AC1/AC3/AC9 — strict-limited; Story 2.10: calls
 * `handleGenerateIdeas` directly, no `agent.invoke`, then re-reads the id
 * set before/after). Mirrors `createIntakeRouter`'s shape (Code Map),
 * adapted to a row-count before/after check instead of an `updatedAt`
 * comparison, since this is an insert of new rows rather than an upsert of
 * one row.
 */
export function createIdeasRouter({
  env,
  db,
  agent,
  model,
  webSearchTool,
  generateDrafts,
  translateIdeaCards: translateIdeaCardsOverride,
}: IdeasRouterDeps) {
  const router = Router();
  const translateIdeaCardsFn = translateIdeaCardsOverride ?? defaultTranslateIdeaCards;
  // Intent/Code Map: "generate_ideas is LLM-backed and cost-bearing like
  // intake's POST; reuse the same strict tier."
  const strictLimiter = createStrictRateLimiter(env);
  // Story 2.7: built once (same precedent as `src/api/index.ts`'s own
  // `chatModel`, shared across turns rather than reconstructed per
  // request) — never user-selectable (`TRANSLATION_MODEL_ID`'s own
  // `category: 'translation'`), reuses the already-required
  // `OPENROUTER_API_KEY`, no new env var.
  const translationModel = createChatModel(env, TRANSLATION_MODEL_ID);

  router.get('/', async (req, res) => {
    const userId = req.session.userId!;

    try {
      const [records, currency, generateLimit] = await Promise.all([
        getIdeasByUserId(db, userId),
        getUserCurrency(db, userId),
        computeGenerateLimitStatus(db, env, userId),
      ]);
      // AC3/AC5: a rejected idea is persisted (status change only, never a
      // delete) but never shown again — filtered here in the route, not in
      // `getIdeasByUserId` itself (that stays the one untouched plain read
      // `POST /generate`'s own before/after id-set check also relies on).
      const visibleRecords = records.filter((idea) => idea.status !== 'rejected');
      const visibleRecordsWithPlan = await attachHasPlan(db, userId, visibleRecords);
      res.json(ideasWithPlanResponseSchema.parse({ ideas: visibleRecordsWithPlan, currency, generateLimit }));
    } catch (error) {
      console.error('[ideas] read failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  // AC1/AC2/AC3/AC4/AC5: the one plain, deterministic status-change route —
  // `setIdeaStatus` is never agent-registered (AD-4). `:id` is validated as
  // a UUID and the body against `settableIdeaStatusSchema`; either failure
  // is a 400 with no row changes. An unknown-or-foreign idea id is a 404
  // (`IdeaNotFoundError`); any other failure (e.g. a lost DB connection) is
  // a 503, same vocabulary as `GET /` above.
  router.post('/:id/status', async (req, res) => {
    const userId = req.session.userId!;

    const idParseResult = z.uuid().safeParse(req.params.id);
    const bodyParseResult = setIdeaStatusRequestSchema.safeParse(req.body);
    if (!idParseResult.success || !bodyParseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    try {
      await setIdeaStatus(db, userId, idParseResult.data, bodyParseResult.data.status);
      res.status(204).end();
    } catch (error) {
      if (error instanceof IdeaNotFoundError) {
        res.status(404).json({ error: 'Idea not found' });
        return;
      }
      console.error('[ideas] status update failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  // Story 2.7: batch-translates a set of the caller's own ideas into
  // `language`, backed by `translateIdeaCards`'s own immutable
  // per-(idea, language) cache. No rate-limit tier beyond the general one
  // (`createGeneralRateLimiter`, applied app-wide) — unlike `generate_ideas`/
  // `create_plan`, this reuses a never-displayed, zero-priced registry
  // entry and is itself cached after the first call per idea+language, so
  // it doesn't need the strict/cost-bearing tier those do.
  router.post('/translate', async (req, res) => {
    const userId = req.session.userId!;

    const parseResult = translateIdeasRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const { ideaIds, language } = parseResult.data;

    // Ownership check (Code Map): every requested id must be one of this
    // user's own ideas — same 404 vocabulary as `POST /:id/status`'s
    // `IdeaNotFoundError`, never silently filtered or 200'd for a foreign id.
    const ownIds = new Set((await getIdeasByUserId(db, userId)).map((idea) => idea.id));
    if (!ideaIds.every((id) => ownIds.has(id))) {
      res.status(404).json({ error: 'Idea not found' });
      return;
    }

    // Same request-scoped abort-on-disconnect pattern as `POST /generate`
    // below (`:161-163`) — `translateIdeaCards` combines this with its own
    // fixed per-call timeout internally.
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('translate_idea_cards: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      const translations = await translateIdeaCardsFn(db, translationModel, env, ideaIds, language, abortController.signal);
      res.json(translateIdeasResponseSchema.parse({ translations }));
    } catch (error) {
      // Boundary: "Failure/abort/moderation-reject persists nothing; cards
      // keep their stored language" — a generic 502 either way, same
      // vocabulary as `POST /generate`'s own failure path.
      console.error('[ideas] translate failed:', { userId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Translation failed' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  router.post('/generate', strictLimiter, async (req, res) => {
    const userId = req.session.userId!;
    const now = new Date();

    // Story 2.11 (AC5/AC6/AC7): the server enforces the limits — the UI's
    // own disabled button is only a convenience. Shared budget first (read-
    // only: it isn't this call's to spend down before even starting), then
    // the per-user count (an atomic upsert-increment: this call always
    // counts as one of today's attempts, win or lose).
    const sharedSearchesUsed = await getSearchBudgetCount(db, now);
    if (sharedSearchesUsed >= env.DAILY_SEARCH_BUDGET) {
      res.status(429).json({ error: 'limit_reached', reason: 'shared_budget', limit: null, resetsAt: getNextUtcResetIso(now) });
      return;
    }
    const [userGenerationsUsed, unlimited] = await Promise.all([
      incrementAndGetUserGenerationCount(db, userId, now),
      isUnlimitedUser(db, userId, env),
    ]);
    if (!unlimited && userGenerationsUsed > env.DAILY_GENERATIONS_PER_USER) {
      res.status(429).json({ error: 'limit_reached', reason: 'user_limit', limit: env.DAILY_GENERATIONS_PER_USER, resetsAt: getNextUtcResetIso(now) });
      return;
    }

    // Story 2.2 follow-up fix 4: the trigger runs on its own internal-only
    // thread, never the user's visible discovery thread — that thread is
    // only *read* below (never written to) to detect a reply language.
    const triggerThreadId = buildIdeasTriggerThreadId(userId);

    // Round 9, fix (b): a request-scoped `AbortController` — aborted when
    // the client disconnects (the browser's own `GENERATE_TIMEOUT_MS`
    // abort, a closed tab, a lost connection), so the server stops doing
    // real work for a caller that's already gone instead of continuing the
    // run in the background. Story 2.10: this signal is now passed straight
    // into `handleGenerateIdeas`'s own `config.signal`
    // (`generate_ideas.ts`'s `GenerateIdeasRunConfig`) below — no
    // `agent.invoke`/LangGraph node in between anymore — where it's combined
    // with that tool's own per-attempt timeout (`withDraftAttemptTimeout`).
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('generate_ideas: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      // Story 2.4 AC1/AC2: `generate_ideas` now *appends* to the existing
      // batch (insert-only, never deletes any status — `generate_ideas.ts`)
      // instead of replacing the `suggested` batch, so the before/after
      // check is now over every existing idea's id (every status), not just
      // `suggested` — a real run always produces entirely new ids
      // (`gen_random_uuid()`), on top of (not instead of) whatever already
      // existed, so comparing the *set of all ids* still tells "it ran this
      // turn" apart from "nothing happened this turn" the same way the old
      // suggested-only id set did for a replace.
      const beforeIds = new Set((await getIdeasByUserId(db, userId)).map((idea) => idea.id));

      // Story 2.7 (AC4): the button's own request body, when present and
      // valid, wins outright — never overridden by the discovery thread's
      // detected language. Only a bodyless/invalid request falls back to
      // the pre-Story-2.7 detection.
      const bodyParseResult = generateIdeasRequestSchema.safeParse(req.body ?? {});
      const explicitLanguage = bodyParseResult.success ? bodyParseResult.data.language : undefined;
      const replyLanguage = explicitLanguage ?? (await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId)));

      // Story 2.10: `handleGenerateIdeas` called directly — the same
      // exported function `generate_ideas.ts`'s own tool wrapper calls, same
      // `Deps`/`Config`/`Args` shape, no `agent.invoke` around it.
      await handleGenerateIdeas(
        { db, model, webSearchTool, env, generateDrafts },
        { configurable: { thread_id: triggerThreadId }, signal: abortController.signal },
        { replyLanguage },
      );

      const [after, currency] = await Promise.all([getIdeasByUserId(db, userId), getUserCurrency(db, userId)]);
      // Story 2.4 AC1: `regenerated` is now "exactly IDEAS_PER_BATCH brand-
      // new ids appeared" — an append, not a replace, so the old
      // `afterSuggested.length === env.IDEAS_PER_BATCH` formula (which
      // assumed the suggested count was always reset to exactly the batch
      // size) no longer holds once a previous run's suggested ideas are
      // still there too.
      const newIds = after.filter((idea) => !beforeIds.has(idea.id));
      const regenerated = newIds.length === env.IDEAS_PER_BATCH;

      if (!regenerated) {
        // I/O matrix: "Agent doesn't call the tool" / a tool error (e.g. no
        // intake row) -> generic error, no partial rows ever reported as
        // success.
        res.status(502).json({ error: 'Ideas could not be generated' });
        return;
      }

      // Bug fix: this response replaces the client's entire `ideas` list
      // (Round 13), so it must apply the same AC3/AC5 "never show a
      // rejected idea" filter `GET /` applies above — without it, a
      // previously-rejected idea (never deleted, only status-changed)
      // reappeared on every "Generate new ideas" click.
      const visibleAfter = after.filter((idea) => idea.status !== 'rejected');
      const [visibleAfterWithPlan, generateLimit] = await Promise.all([
        attachHasPlan(db, userId, visibleAfter),
        computeGenerateLimitStatus(db, env, userId, now),
      ]);
      res.json(ideasWithPlanResponseSchema.parse({ ideas: visibleAfterWithPlan, currency, generateLimit }));
    } catch (error) {
      // Fail-fast (every web_search call this round failed): a distinct,
      // specific error the client maps to a clear message — never the
      // generic one below — and existing `ideas` rows are left completely
      // untouched (`handleGenerateIdeas` throws this before any DB write).
      if (error instanceof SearchServiceUnavailableError) {
        // The attempt was already counted at entry; give it back (the user did nothing wrong).
        await refundUserGeneration(db, userId, now).catch(() => undefined);
        res.status(503).json({ error: 'search_unavailable' });
        return;
      }
      console.error('[ideas] generation failed:', { userId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Ideas could not be generated' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  return router;
}
