import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ideasResponseSchema,
  currencyCodeSchema,
  replyLanguageSchema,
  translateIdeasRequestSchema,
  translateIdeasResponseSchema,
  type CurrencyCode,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildDiscoveryThreadId, buildIdeasTriggerThreadId } from '../../agent/index.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { createChatModel } from '../../agent/model.js';
import { TRANSLATION_MODEL_ID } from '../../agent/registry.js';
import { translateIdeaCards as defaultTranslateIdeaCards } from '../../agent/translate-idea-cards.js';
import { getIdeasByUserId } from '../../tools/llm/generate_ideas.js';
import { setIdeaStatus, IdeaNotFoundError, settableIdeaStatusSchema } from '../../tools/plain/set_idea_status.js';
import { userSettings } from '../../db/schema/index.js';
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
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  db: ReturnType<typeof createDb>['db'];
  agent: CoachAgent;
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
 * Message the internal-only `ideas-trigger:` thread sees for a "generate my
 * ideas" request (Boundary: reaches `generate_ideas` only via
 * `agent.invoke()`, same precedent as `intake.ts`'s
 * `buildIntakeAgentMessage` — never calling the tool's persistence logic
 * directly from this HTTP route). The reply language is stated explicitly
 * (detected server-side above) rather than left for the model to infer from
 * "the conversation" — this thread *has* no conversation; it exists only
 * for this one instruction. The agent still supplies `replyLanguage` as its
 * own tool-call argument (AD-4), it is just no longer guessing which value
 * to pass.
 */
function buildGenerateIdeasAgentMessage(replyLanguage: 'de' | 'en'): string {
  const languageName = replyLanguage === 'de' ? 'German' : 'English';
  return (
    `Please generate my 5 tailored income ideas now by calling generate_ideas. The user's reply language is ` +
    `${languageName} ("${replyLanguage}") — pass that as replyLanguage.`
  );
}

/**
 * `createIdeasRouter`: `GET /` (AC1 — plain read, never a LangChain tool)
 * and `POST /generate` (AC1/AC3/AC9 — strict-limited, invokes the agent on
 * the discovery thread, re-reads the row count before/after). Mirrors
 * `createIntakeRouter`'s shape (Code Map), adapted to a row-count
 * before/after check instead of an `updatedAt` comparison, since this is an
 * insert of new rows rather than an upsert of one row.
 */
export function createIdeasRouter({ env, db, agent, translateIdeaCards: translateIdeaCardsOverride }: IdeasRouterDeps) {
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
      const [records, currency] = await Promise.all([getIdeasByUserId(db, userId), getUserCurrency(db, userId)]);
      // AC3/AC5: a rejected idea is persisted (status change only, never a
      // delete) but never shown again — filtered here in the route, not in
      // `getIdeasByUserId` itself (that stays the one untouched plain read
      // `POST /generate`'s own before/after id-set check also relies on).
      const visibleRecords = records.filter((idea) => idea.status !== 'rejected');
      res.json(ideasResponseSchema.parse({ ideas: visibleRecords, currency }));
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
    // Story 2.2 follow-up fix 4: the trigger runs on its own internal-only
    // thread, never the user's visible discovery thread — that thread is
    // only *read* below (never written to) to detect a reply language.
    const triggerThreadId = buildIdeasTriggerThreadId(userId);

    // Round 9, fix (b): a request-scoped `AbortController` — aborted when
    // the client disconnects (the browser's own `GENERATE_TIMEOUT_MS`
    // abort, a closed tab, a lost connection), so the server stops doing
    // real work for a caller that's already gone instead of continuing the
    // run in the background. `agent.invoke`'s `config.signal` propagates
    // through LangGraph's own node execution (confirmed directly in
    // `@langchain/langgraph`'s source: `_runWithRetry`/`_initializeAbort
    // Signals` compose it into every node's own config) and through
    // `@langchain/core`'s `tool()`/`ToolNode` into `generate_ideas`'s own
    // `config.signal` (`generate_ideas.ts`'s `GenerateIdeasRunConfig`),
    // where it's combined with that tool's own per-attempt timeout.
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('generate_ideas: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      // Round 10 ("Generate new ideas" open item): `generate_ideas` now
      // *replaces* the existing `suggested` batch (deletes old `suggested`
      // rows, inserts 5 new ones, in one transaction — `generate_ideas.ts`)
      // rather than only ever appending, so the old before/after row-COUNT
      // diff (`after.length === before + 5`) can no longer tell "it ran
      // this turn" apart from "a stale batch of 5 was already there and
      // this turn failed, leaving it untouched" — both look like "still 5
      // suggested rows". Comparing the *set of ids* instead: a real
      // replace always produces entirely new ids (`gen_random_uuid()`), so
      // any overlap with the pre-call id set means nothing actually
      // happened this turn.
      const beforeSuggestedIds = new Set((await getIdeasByUserId(db, userId)).filter((idea) => idea.status === 'suggested').map((idea) => idea.id));

      // Story 2.7 (AC4): the button's own request body, when present and
      // valid, wins outright — never overridden by the discovery thread's
      // detected language. Only a bodyless/invalid request falls back to
      // the pre-Story-2.7 detection.
      const bodyParseResult = generateIdeasRequestSchema.safeParse(req.body ?? {});
      const explicitLanguage = bodyParseResult.success ? bodyParseResult.data.language : undefined;
      const replyLanguage = explicitLanguage ?? (await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId)));
      await agent.invoke(
        { messages: [new HumanMessage(buildGenerateIdeasAgentMessage(replyLanguage))] },
        { configurable: { thread_id: triggerThreadId }, signal: abortController.signal },
      );

      const [after, currency] = await Promise.all([getIdeasByUserId(db, userId), getUserCurrency(db, userId)]);
      const afterSuggested = after.filter((idea) => idea.status === 'suggested');
      const regenerated = afterSuggested.length === 5 && afterSuggested.every((idea) => !beforeSuggestedIds.has(idea.id));

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
      res.json(ideasResponseSchema.parse({ ideas: visibleAfter, currency }));
    } catch (error) {
      console.error('[ideas] generation failed:', { userId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Ideas could not be generated' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  return router;
}
