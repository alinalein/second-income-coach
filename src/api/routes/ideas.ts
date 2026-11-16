import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { ideasResponseSchema, currencyCodeSchema, type CurrencyCode } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildDiscoveryThreadId, buildIdeasTriggerThreadId } from '../../agent/index.js';
import { detectReplyLanguage } from '../../agent/language.js';
import { getIdeasByUserId } from '../../tools/llm/generate_ideas.js';
import { userSettings } from '../../db/schema/index.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';

export interface IdeasRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS'>;
  db: ReturnType<typeof createDb>['db'];
  agent: CoachAgent;
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
export function createIdeasRouter({ env, db, agent }: IdeasRouterDeps) {
  const router = Router();
  // Intent/Code Map: "generate_ideas is LLM-backed and cost-bearing like
  // intake's POST; reuse the same strict tier."
  const strictLimiter = createStrictRateLimiter(env);

  router.get('/', async (req, res) => {
    const userId = req.session.userId!;

    try {
      const [records, currency] = await Promise.all([getIdeasByUserId(db, userId), getUserCurrency(db, userId)]);
      res.json(ideasResponseSchema.parse({ ideas: records, currency }));
    } catch (error) {
      console.error('[ideas] read failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
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

      const replyLanguage = await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId));
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

      res.json(ideasResponseSchema.parse({ ideas: after, currency }));
    } catch (error) {
      console.error('[ideas] generation failed:', { userId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Ideas could not be generated' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  return router;
}
