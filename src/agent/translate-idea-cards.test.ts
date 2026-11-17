import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createDb } from '../db/client.js';
import { users, ideas, ideaTranslations } from '../db/schema/index.js';
import { translateIdeaCards } from './translate-idea-cards.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const { db, pool } = createDb({ DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function createTestUser(): Promise<string> {
  const googleId = `test-${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ googleId, email: `${googleId}@example.com`, name: 'Test User', picture: null })
    .returning();
  return user!.id;
}

async function cleanUp(userId: string) {
  await db.delete(ideas).where(eq(ideas.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

const BASE_IDEA_FIELDS = {
  status: 'suggested' as const,
  citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
  ideaType: 'service' as const,
  weeklyTimeCommitment: '5_to_10h' as const,
  startupCostAmountMinorUnits: 0,
  startupCostCurrency: 'EUR',
  riskLevel: 'low' as const,
  baselineRateLowAmountMinorUnits: 2500,
  baselineRateHighAmountMinorUnits: 2500,
  isVendorSource: false,
  rateUnit: 'hour' as const,
  baselineRateCurrency: 'USD',
  sourceTrustTier: 'tier_3' as const,
  isRateUnverified: false,
};

/** A citation/quote marker distinctive enough that its presence in a
 * captured prompt string unambiguously proves the Boundary violated — never
 * a word that could appear incidentally in translated prose. */
const QUOTE_MARKER = 'QUOTE-MARKER-ZX91';
const CITATION_MARKER = 'https://quote-marker-zx91.example.com/rates';

async function insertIdea(userId: string, overrides: Partial<typeof ideas.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(ideas)
    .values({
      userId,
      title: 'Freelance tutoring',
      rationale: 'Fits the time you have free each week.\nStart by listing one lesson type online.',
      baselineRateQuote: `Tutoring like this pays about ${QUOTE_MARKER} $25 an hour.`,
      baselineRateCitation: CITATION_MARKER,
      demandEvidenceNote: 'Demand for tutoring has risen lately.',
      demandEvidenceCitation: 'https://trend.example.com/demand',
      demandEvidenceQuote: `Demand data shows ${QUOTE_MARKER} growth.`,
      growthPath: 'Raise your rate once you have a few regular clients.',
      language: 'en',
      ...BASE_IDEA_FIELDS,
      ...overrides,
    })
    .returning({ id: ideas.id });
  return row!.id;
}

/** A model stub whose `invoke` always throws — proves the model is never
 * even called (e.g. on a cache hit). */
function unreachableModel(): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => {
        throw new Error('model must not be called');
      }),
    }),
  } as unknown as BaseChatModel;
}

/** A model stub that echoes back a translated version of exactly the ideas
 * it's asked about, read out of its own prompt text so the test doesn't
 * have to hardcode idea ids ahead of time. */
function echoModel(capturedPrompts: string[], invokeCount: { count: number }, translate: (title: string) => string = (t) => `DE: ${t}`): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async (messages: BaseMessage[]) => {
        invokeCount.count += 1;
        const promptText = typeof messages[0]?.content === 'string' ? messages[0].content : JSON.stringify(messages[0]?.content);
        capturedPrompts.push(promptText);
        const ideaIds = [...promptText.matchAll(/ideaId: (\S+)/g)].map((match) => match[1]!);
        return {
          translations: ideaIds.map((ideaId) => ({
            ideaId,
            title: translate('Freelance tutoring'),
            rationale: ['Passt zu deiner freien Zeit.', 'Starte mit einer Unterrichtsart online.'],
            demandEvidenceNote: 'Die Nachfrage ist zuletzt gestiegen.',
            growthPath: 'Erhöhe deinen Satz, sobald du feste Kunden hast.',
          })),
        };
      }),
    }),
  } as unknown as BaseChatModel;
}

const fakeEnv = { MISTRAL_API_KEY: 'test-key' };
const passClassify = async () => ({});

describe('translateIdeaCards (AC2: one batched call, cached per idea+language)', () => {
  it('makes exactly one model call for a batch of cache misses, then persists a row per idea+language', async () => {
    const userId = await createTestUser();
    try {
      const ideaIdA = await insertIdea(userId, { title: 'Idea A' });
      const ideaIdB = await insertIdea(userId, { title: 'Idea B' });
      const prompts: string[] = [];
      const invokeCount = { count: 0 };

      const translations = await translateIdeaCards(
        db,
        echoModel(prompts, invokeCount),
        fakeEnv,
        [ideaIdA, ideaIdB],
        'de',
        new AbortController().signal,
        { classify: passClassify },
      );

      expect(invokeCount.count).toBe(1); // one batched call, not one per idea
      expect(translations).toHaveLength(2);
      expect(translations.map((t) => t.title)).toEqual(['DE: Freelance tutoring', 'DE: Freelance tutoring']);

      const rows = await db
        .select()
        .from(ideaTranslations)
        .where(and(inArray(ideaTranslations.ideaId, [ideaIdA, ideaIdB]), eq(ideaTranslations.language, 'de')));
      expect(rows.map((row) => row.ideaId).sort()).toEqual([ideaIdA, ideaIdB].sort());
    } finally {
      await cleanUp(userId);
    }
  });

  it('never calls the model again for an idea+language already cached', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      await db.insert(ideaTranslations).values({
        ideaId,
        language: 'de',
        title: 'Cached title',
        rationale: 'Cached line 1.\nCached line 2.',
        demandEvidenceNote: 'Cached note.',
        growthPath: 'Cached growth.',
      });
      const translations = await translateIdeaCards(db, unreachableModel(), fakeEnv, [ideaId], 'de', new AbortController().signal, {
        classify: passClassify,
      });

      expect(translations).toEqual([
        { ideaId, language: 'de', title: 'Cached title', rationale: 'Cached line 1.\nCached line 2.', demandEvidenceNote: 'Cached note.', growthPath: 'Cached growth.' },
      ]);
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('translateIdeaCards (Boundary: quotes/citations/numbers are never sent to the model)', () => {
  it("the prompt never contains baselineRateQuote/demandEvidenceQuote/citation text", async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const prompts: string[] = [];
      const invokeCount = { count: 0 };

      await translateIdeaCards(db, echoModel(prompts, invokeCount), fakeEnv, [ideaId], 'de', new AbortController().signal, {
        classify: passClassify,
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain(QUOTE_MARKER);
      expect(prompts[0]).not.toContain(CITATION_MARKER);
    } finally {
      await cleanUp(userId);
    }
  });
});

/** A model stub whose structured output always omits every requested
 * translation — proves the "model omitted a translation for idea X" throw
 * branch (the loop checking every `translatable` idea has a matching
 * `translatedById` entry). */
function emptyTranslationModel(): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: vi.fn(async () => ({ translations: [] })),
    }),
  } as unknown as BaseChatModel;
}

// Table-driven (CLAUDE.md): three different failure causes, identical
// assertion shape — throws, persists nothing, card stays in its stored
// language. AD-11 output moderation, the fixed per-call timeout/abort, and
// the model omitting a requested translation are each a distinct failure
// branch of this security/correctness-relevant path, so each gets its own
// row here rather than being skipped.
describe('translateIdeaCards (Boundary: one attempt, no retry — failure persists nothing)', () => {
  it.each<{
    name: string;
    signal: () => AbortSignal;
    classify?: () => Promise<Record<string, boolean>>;
    model?: () => BaseChatModel;
  }>([
    {
      name: 'moderation rejects the translated batch',
      signal: () => new AbortController().signal,
      classify: async () => ({ hate_and_discrimination: true }),
    },
    {
      name: 'the call is already aborted (mirrors a timeout/client-disconnect)',
      signal: () => AbortSignal.abort(new Error('simulated timeout')),
    },
    {
      name: 'the model returns fewer translations than requested',
      signal: () => new AbortController().signal,
      model: () => emptyTranslationModel(),
    },
  ])('$name', async ({ signal, classify, model }) => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId);
      const prompts: string[] = [];
      const invokeCount = { count: 0 };

      await expect(
        translateIdeaCards(db, model ? model() : echoModel(prompts, invokeCount), fakeEnv, [ideaId], 'de', signal(), {
          classify: classify ?? passClassify,
        }),
      ).rejects.toThrow();

      const rows = await db.select().from(ideaTranslations).where(eq(ideaTranslations.ideaId, ideaId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

describe('translateIdeaCards (AC1: a null source field is translated as null, never invented)', () => {
  it('returns demandEvidenceNote/growthPath as null when the source idea has no value for them', async () => {
    const userId = await createTestUser();
    try {
      const ideaId = await insertIdea(userId, { demandEvidenceNote: null, demandEvidenceCitation: null, demandEvidenceQuote: null, growthPath: null });
      const prompts: string[] = [];
      const invokeCount = { count: 0 };
      const nullAwareModel: BaseChatModel = {
        withStructuredOutput: () => ({
          invoke: vi.fn(async (messages: BaseMessage[]) => {
            invokeCount.count += 1;
            const promptText = typeof messages[0]?.content === 'string' ? messages[0].content : '';
            prompts.push(promptText);
            return {
              translations: [
                { ideaId, title: 'DE: Freelance tutoring', rationale: ['Zeile 1.', 'Zeile 2.'], demandEvidenceNote: null, growthPath: null },
              ],
            };
          }),
        }),
      } as unknown as BaseChatModel;

      const [translation] = await translateIdeaCards(db, nullAwareModel, fakeEnv, [ideaId], 'de', new AbortController().signal, {
        classify: passClassify,
      });

      expect(translation?.demandEvidenceNote).toBeNull();
      expect(translation?.growthPath).toBeNull();
    } finally {
      await cleanUp(userId);
    }
  });
});
