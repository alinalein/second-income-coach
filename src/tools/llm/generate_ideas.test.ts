import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { IdeaDraft, IntakeResponse, SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas } from '../../db/schema/index.js';
import { buildIdeasTriggerThreadId } from '../../agent/index.js';
import { upsertIntake } from '../plain/submit_intake.js';
import {
  buildNestedAgentPrompt,
  evaluateSourceTrust,
  extractNumbers,
  handleGenerateIdeas,
  occupationMatchesIdea,
  sourceEvidenceLooksBlockedOrHidden,
  truncateAtWordBoundary,
  type GenerateIdeasDeps,
  type GenerateIdeasRunConfig,
} from './generate_ideas.js';

function intakeArgs(overrides: Partial<SubmitIntakeToolArgs> = {}): SubmitIntakeToolArgs {
  return {
    skillsInterests: 'Woodworking, basic bookkeeping',
    weeklyTimeAvailability: '5_to_10h',
    startingBudgetRange: 'under_100',
    riskTolerance: 'low',
    stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
    country: 'DE',
    failurePattern: 'overwhelm',
    ...overrides,
  };
}

function fakeIntakeResponse(overrides: Partial<IntakeResponse> = {}): IntakeResponse {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ...intakeArgs(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Story 2.2 follow-up fix round 4, fix 4(a): every valid test draft shares
// this exact quote/rate — `DEFAULT_SEARCH_RESULT_TEXTS` below is what
// `quoteMatchesSearchResults` checks it against, and the number inside it
// is what `quoteSupportsRate` checks the stored rate against.
// Story 2.5: the quote now mentions "tutoring" (not just "workers") so the
// default happy-path fixture's title ("Freelance tutoring") genuinely
// matches via `occupationMatchesIdea` — a more realistic default than an
// always-mismatched one, with dedicated mismatch coverage in its own table
// below (`occupationMatchesIdea`).
const DEFAULT_RATE_QUOTE = 'Tutoring work like this typically pays $25.00 an hour.';
const DEFAULT_DEMAND_EVIDENCE_QUOTE = 'Demand for freelance tutoring has grown steadily this year.';
const DEFAULT_SEARCH_RESULT_TEXTS = [
  `Detailed Results:\n\n${DEFAULT_RATE_QUOTE}\nMore context around it.`,
  `Detailed Results:\n\n${DEFAULT_DEMAND_EVIDENCE_QUOTE}\nMore context around it.`,
];

function buildValidDraft(intakeRow: IntakeResponse, overrides: Partial<IdeaDraft> = {}): IdeaDraft {
  return {
    title: 'Freelance tutoring',
    // Round 10: the model's own draft shape — an array of bullets, not one
    // newline-joined string (that's `rationaleSchema`'s *response* shape).
    rationale: ['Fits the few hours you have free each week.', 'Start by listing your skills on one platform.'],
    citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
    ideaType: 'service',
    weeklyTimeCommitment: intakeRow.weeklyTimeAvailability,
    startupCostAmountMinorUnits: 0,
    riskLevel: intakeRow.riskTolerance,
    baselineRateQuote: DEFAULT_RATE_QUOTE,
    baselineRateLowAmountMinorUnits: 2500,
    baselineRateHighAmountMinorUnits: 2500,
    isVendorSource: false,
    rateUnit: 'hour',
    // Story 2.5 (user-reported gap): must match the '$' in DEFAULT_RATE_QUOTE
    // now that `quoteContradictsCurrency` deterministically checks this —
    // this fixture simulates a genuinely USD-sourced rate.
    baselineRateCurrency: 'USD',
    baselineRateCitation: 'https://a.example.com/rates',
    demandEvidenceNote: 'Demand for tutoring help has been rising lately.',
    demandEvidenceCitation: 'https://trend.example.com/demand',
    demandEvidenceQuote: DEFAULT_DEMAND_EVIDENCE_QUOTE,
    growthPath: 'Raise your rate once you have a few regular clients.',
    ...overrides,
  };
}

// Story 2.2 follow-up fix round 2, fix 3: a valid batch now also needs
// >=3 distinct idea types and >=3 distinct citation domains (<=2 ideas per
// domain) — 5 distinct values for each satisfies both with room to spare.
const IDEA_TYPES_FOR_TEST = ['service', 'digital_product', 'content', 'resale_arbitrage', 'teaching_coaching'] as const;
const CITATION_DOMAINS_FOR_TEST = [
  'https://a.example.com/rates',
  'https://b.example.com/rates',
  'https://c.example.com/rates',
  'https://d.example.com/rates',
  'https://e.example.com/rates',
];

// Story 2.5: a distinct domain list (not reused from `CITATION_DOMAINS_FOR_TEST`
// above) so the baseline-rate and demand-evidence diversity checks are
// exercised independently by default — a test that wants insufficient
// diversity for one still has to corrupt it deliberately.
const DEMAND_EVIDENCE_DOMAINS_FOR_TEST = [
  'https://trend-a.example.com/demand',
  'https://trend-b.example.com/demand',
  'https://trend-c.example.com/demand',
  'https://trend-d.example.com/demand',
  'https://trend-e.example.com/demand',
];

function fiveValidDrafts(intakeRow: IntakeResponse, label: string): IdeaDraft[] {
  return Array.from({ length: 5 }, (_, i) =>
    buildValidDraft(intakeRow, {
      title: `${label} ${i + 1}`,
      ideaType: IDEA_TYPES_FOR_TEST[i],
      baselineRateCitation: CITATION_DOMAINS_FOR_TEST[i],
      demandEvidenceCitation: DEMAND_EVIDENCE_DOMAINS_FOR_TEST[i],
    }),
  );
}

// AC addition 1 (`IDEAS_PER_BATCH`): same fixture shape as `fiveValidDrafts`
// above, generalized to any count <=5 — the idea-type/citation-domain
// variety checks it also reuses are soft-only (round 12: never block), so a
// smaller batch needs no special-casing there.
function nValidDrafts(intakeRow: IntakeResponse, label: string, count: number): IdeaDraft[] {
  return Array.from({ length: count }, (_, i) =>
    buildValidDraft(intakeRow, {
      title: `${label} ${i + 1}`,
      ideaType: IDEA_TYPES_FOR_TEST[i],
      baselineRateCitation: CITATION_DOMAINS_FOR_TEST[i],
      demandEvidenceCitation: DEMAND_EVIDENCE_DOMAINS_FOR_TEST[i],
    }),
  );
}

// Pure-function test: the nested agent's prompt is the one deterministic
// channel through which intake content reaches the LLM — I/O matrix: "Two
// intakes differ >=2 fields" -> "Resulting sets differ" depends on the real
// model being grounded in a prompt that actually varies with intake
// content, which is what this asserts (the LLM's own behavior given that
// prompt is framework behavior, out of scope per CLAUDE.md).
describe('buildNestedAgentPrompt (I/O matrix: two intakes differing >=2 fields)', () => {
  it("embeds each intake record's own field values, so differing intakes produce differing prompts", () => {
    const a = fakeIntakeResponse();
    const b = fakeIntakeResponse({ weeklyTimeAvailability: '20h_plus', riskTolerance: 'high' });

    const promptA = buildNestedAgentPrompt(a, 'en');
    const promptB = buildNestedAgentPrompt(b, 'en');

    expect(promptA).not.toBe(promptB);
    expect(promptA).toContain(a.weeklyTimeAvailability);
    expect(promptB).toContain(b.weeklyTimeAvailability);
    expect(promptB).toContain(b.riskTolerance);
  });

  // Story 2.5: the intake's `country` steers a concrete regional source
  // preference (replacing the old reply-language-only heuristic); 'other'
  // falls back to that same reply-language heuristic.
  it("prefers the intake's own country's sources, falling back to the reply language only when country is 'other'", () => {
    const germany = fakeIntakeResponse({ country: 'DE' });
    const other = fakeIntakeResponse({ country: 'other' });

    expect(buildNestedAgentPrompt(germany, 'en')).toContain('located in Germany');
    expect(buildNestedAgentPrompt(other, 'en')).toContain("region implied by this reply's language");
  });
});

// Story 2.2 follow-up fix round 6, fix 6 (AC: "a baseline rate must be
// grounded, not guessed"). Round 12 (user-approved): `evaluateSourceTrust`
// is now a pure *label* — it always returns a value, never `undefined`.
// Whether the retrieved page looks usable at all is a separate, still-hard
// check (`sourceEvidenceLooksBlockedOrHidden`, tested below). Pure-function
// test (CLAUDE.md: "deterministic unit tests for plain-code tools") — no DB
// needed, tier classification/corroboration are both plain code.
describe('evaluateSourceTrust (source-trust tier labeling — never blocks)', () => {
  const ownSourceText = `Detailed Results:\n\n${DEFAULT_RATE_QUOTE}\nMore context around it.`;

  it.each([
    {
      name: 'an official-statistics domain is tier 1, always verified',
      citation: 'https://www.bls.gov/oes/current/oes_stru.htm',
      searchResultTexts: [ownSourceText],
      expected: { tier: 'tier_1', isUnverified: false },
    },
    {
      name: 'an established pay-data provider is tier 2, always verified',
      citation: 'https://www.payscale.com/research/US/Job=Freelance_Tutor/Hourly_Rate',
      searchResultTexts: [ownSourceText],
      expected: { tier: 'tier_2', isUnverified: false },
    },
    {
      // Round 12: labeled honestly, never rejected — see the round-12
      // `handleGenerateIdeas` test proving this is accepted, not blocked.
      name: 'a known blog/forum platform is labeled tier 4, not rejected',
      citation: 'https://www.reddit.com/r/freelance/comments/abc123',
      searchResultTexts: [ownSourceText],
      expected: { tier: 'tier_4', isUnverified: true },
    },
    {
      // Round 15 (user-requested): glassdoor.* (any country TLD) classifies
      // as tier 4 too — this function's own labeling is still correct, even
      // though `sourceEvidenceLooksBlockedOrHidden`'s separate hard check
      // means a glassdoor citation never actually reaches persistence (own
      // test below).
      name: 'a glassdoor citation (any country TLD) is labeled tier 4',
      citation: 'https://www.glassdoor.de/Gehalt/freelance-tutor-gehalt-SRCH_KO0,16.htm',
      searchResultTexts: [ownSourceText],
      expected: { tier: 'tier_4', isUnverified: true },
    },
    {
      name: 'an otherwise-unrecognized domain is tier 3, unverified without a second source',
      citation: 'https://a.example.com/rates',
      searchResultTexts: [ownSourceText],
      expected: { tier: 'tier_3', isUnverified: true },
    },
    {
      name: 'a tier-3 domain is verified once a second, independent source agrees within range',
      citation: 'https://a.example.com/rates',
      searchResultTexts: [ownSourceText, 'A separate industry report: the typical rate is about $26 an hour.'],
      expected: { tier: 'tier_3', isUnverified: false },
    },
  ])('$name', ({ citation, searchResultTexts, expected }) => {
    const draft = buildValidDraft(fakeIntakeResponse(), { baselineRateCitation: citation });

    expect(evaluateSourceTrust(draft, searchResultTexts)).toEqual(expected);
  });
});

// Round 12 (user-approved — moved back to the hard-rules list: "vendor/
// login-wall checks"): the retrieved page the quote came from can't support
// the number it's cited for at all — a login wall, a blurred/masked figure,
// or empty content. Split out of `evaluateSourceTrust` above, which no
// longer gates on any of this.
describe('sourceEvidenceLooksBlockedOrHidden (hard: login wall, blurred/masked, or empty)', () => {
  it.each<{ name: string; citation?: string; searchResultTexts: string[]; expected: boolean }>([
    {
      name: 'a login-walled retrieved result is blocked regardless of tier',
      searchResultTexts: [`Detailed Results:\n\nSign in to see salaries.\n${DEFAULT_RATE_QUOTE}\nMore context.`],
      expected: true,
    },
    {
      name: 'a blurred/masked value in the retrieved result is blocked regardless of tier',
      searchResultTexts: [`Detailed Results:\n\n$** per hour.\n${DEFAULT_RATE_QUOTE}\nMore context.`],
      expected: true,
    },
    {
      // Round 10 (bug fix, user-approved): a real snippet whose only "crime"
      // was bold-formatting a real figure with markdown (`**$25.00** per
      // hour`) must NOT be mistaken for a masked value — the prior patterns
      // false-positived on exactly this (round 9's Step 1 diagnosis,
      // confirmed live). Still verified here after round 12's refactor.
      name: 'markdown-bold formatting around a real figure is not mistaken for masked',
      searchResultTexts: [`Detailed Results:\n\n${DEFAULT_RATE_QUOTE} Shown on the listing as **$25.00** per hour.\nMore context.`],
      expected: false,
    },
    {
      // A genuinely masked value with no currency symbol at all (just the
      // mask characters directly before the time unit) must still be
      // blocked — confirms the digit-adjacency fix didn't weaken real
      // masking detection, only the markdown false positive.
      name: 'a genuinely masked value with no currency symbol is still blocked',
      searchResultTexts: [`Detailed Results:\n\nRate: xxx per hour.\n${DEFAULT_RATE_QUOTE}\nMore context.`],
      expected: true,
    },
    {
      name: 'a normal, fully-readable retrieved result is never blocked',
      searchResultTexts: [`Detailed Results:\n\n${DEFAULT_RATE_QUOTE}\nMore context around it.`],
      expected: false,
    },
    {
      // Round 15 (user-requested, final fix before acceptance): glassdoor.*
      // is always treated as login-walled/masked, regardless of what this
      // specific retrieved page's text actually says — real-world
      // experience is that Glassdoor routinely gates its real figures
      // behind a sign-in/contribute-your-own-data wall, which the fixed
      // phrase list can't reliably catch on every scrape. Uses a
      // non-`.com` TLD (`.co.uk`) deliberately, to prove the match isn't
      // limited to the one domain previously listed in `TIER_2_DOMAINS`.
      name: 'a glassdoor citation is always blocked, on any country TLD, even with otherwise-clean retrieved text',
      citation: 'https://www.glassdoor.co.uk/Salaries/freelance-tutor-salary-SRCH_KO0,16.htm',
      searchResultTexts: [`Detailed Results:\n\n${DEFAULT_RATE_QUOTE}\nMore context around it.`],
      expected: true,
    },
  ])('$name', ({ citation, searchResultTexts, expected }) => {
    const draft = buildValidDraft(fakeIntakeResponse(), citation ? { baselineRateCitation: citation } : {});

    expect(sourceEvidenceLooksBlockedOrHidden(draft.baselineRateCitation, draft.baselineRateQuote, searchResultTexts)).toBe(expected);
  });
});

// Story 2.5 (AC: "its source describes the same activity or occupation as
// the idea (checked deterministically against the quoted passage),
// otherwise the card shows it as unverified") — the fix for the observed
// live problem of a source (e.g. a BLS occupation page) describing a
// different occupation than the idea it was attached to. Pure-function test
// — no DB/model needed.
describe('occupationMatchesIdea (deterministic, non-blocking — labels only)', () => {
  it.each([
    {
      name: 'a quote mentioning a significant word from the title is a match',
      title: 'Freelance Graphic Design',
      quote: 'Freelance graphic designers typically charge $35 per hour for logo work.',
      expected: true,
    },
    {
      name: 'a quote describing a wholly different occupation is a mismatch',
      title: 'Freelance Graphic Design',
      quote: 'Data entry clerks earn $15.00 per hour on average.',
      expected: false,
    },
    {
      name: 'a title with no significant (>=5 letter) word is treated as a match (nothing specific to check)',
      title: 'Pet Sit',
      quote: 'Data entry clerks earn $15.00 per hour on average.',
      expected: true,
    },
  ])('$name', ({ title, quote, expected }) => {
    expect(occupationMatchesIdea(title, quote)).toBe(expected);
  });
});

// Story 2.2 round 10 (bug fix, user-approved): "if a bullet is slightly too
// long, shorten it deterministically at a word boundary instead of failing
// the attempt." Pure-function test — no DB/model needed.
describe('truncateAtWordBoundary', () => {
  it.each([
    { name: 'text already within the limit is returned unchanged', text: 'Short bullet.', maxLength: 140, expected: 'Short bullet.' },
    {
      name: 'text over the limit is cut at the last word boundary at or before it',
      text: 'Shorten this example sentence please',
      maxLength: 20,
      expected: 'Shorten this',
    },
    {
      name: 'a single very-long word with no space falls back to a hard cut (still a real Zod failure afterward, not silently accepted)',
      text: 'a'.repeat(50),
      maxLength: 10,
      expected: 'a'.repeat(10),
    },
  ])('$name', ({ text, maxLength, expected }) => {
    const result = truncateAtWordBoundary(text, maxLength);
    expect(result).toBe(expected);
    expect(result.length).toBeLessThanOrEqual(maxLength);
  });
});

// Live-bug fix (user-reported): a German-sourced quote's decimal comma
// ("26,52 €") was silently misparsed as the integer 2652 (comma always
// treated as an English thousands separator), making `quoteSupportsRate`
// reject a genuinely-matching German rate on every real run that retrieved
// a German-language source. These cases are exactly the two numbers from
// the live failing quote, plus the existing English conventions that must
// keep working unchanged.
describe('extractNumbers (locale-aware decimal/thousands separators)', () => {
  it.each([
    { name: 'German decimal comma (2 digits after)', text: '26,52 €', expected: [26.52] },
    { name: 'German thousands dot (3 digits after)', text: '59.751 €', expected: [59751] },
    { name: 'English decimal point', text: '$24.36 an hour', expected: [24.36] },
    { name: 'English thousands comma (3 digits after)', text: '$1,500 per month', expected: [1500] },
    { name: 'English thousands + decimal', text: '$1,234.56', expected: [1234.56] },
    { name: 'German thousands + decimal', text: '1.234,56 €', expected: [1234.56] },
    { name: 'a vendor range with two plain numbers', text: '$15-$25 per hour', expected: [15, 25] },
  ])('$name', ({ text, expected }) => {
    expect(extractNumbers(text)).toEqual(expected);
  });
});

/**
 * Integration tests against real Postgres (same pattern as
 * `submit_intake.test.ts`/`intake.test.ts`) — `handleGenerateIdeas`'s own
 * deterministic logic (Zod validation, limit/citation checks, atomic
 * persistence) is exercised directly; the nested `createAgent`'s ReAct loop
 * is replaced by `generateDrafts`, a test-only seam (framework behavior is
 * out of scope per CLAUDE.md).
 */
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
  await db.delete(intake).where(eq(intake.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function baseDeps(overrides: Partial<GenerateIdeasDeps> = {}): GenerateIdeasDeps {
  return {
    db,
    model: {} as never,
    webSearchTool: {} as never,
    env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 5 },
    ...overrides,
  };
}

// Story 2.2 follow-up fix 4: the real caller (ideas.ts) now invokes the
// agent on the internal-only `ideas-trigger:` thread, not `discovery:` —
// use that here so every test below exercises the actual real convention.
function configFor(userId: string): GenerateIdeasRunConfig {
  return { configurable: { thread_id: buildIdeasTriggerThreadId(userId) } };
}

// Table-driven (CLAUDE.md): every one of these corrupts attempt 1's batch a
// different way, then supplies a clean batch for attempt 2 — same recovery
// shape (retry once, then persist), different failure branch each time.
// - "raw token leak" replaces the removed `citedIntakeFieldCount`
//   word-boundary regression test (follow-up round 1, fix 3): the rationale
//   must never contain raw intake field names/enum values.
// - "exceeds budget" is the I/O matrix's "Idea would exceed budget/time/risk".
// - "insufficient variety" is follow-up round 2, fix 3's new batch-level
//   check: >=3 distinct idea types and >=3 distinct citation domains.
// - "vendor pricing page" and "quote doesn't support the rate" are follow-up
//   round 4, fix 4(a)/(b)'s new grounding checks.
// - "demand-evidence quote isn't found"/"demand-evidence source is login-
//   walled" are Story 2.5's new hard checks, mirroring the baseline rate's
//   own quote-verification/blocked-source checks exactly.
describe('handleGenerateIdeas (corrupted batch is rejected and retried, then a clean one persists)', () => {
  it.each<{
    name: string;
    corrupt: (drafts: IdeaDraft[]) => IdeaDraft[];
    searchResultTexts?: string[];
    hangFirstAttempt?: boolean;
  }>([
    {
      name: 'rationale leaks a raw intake token',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, rationale: ['Fits your weeklyTimeAvailability.', 'And risk tolerance well.'] })),
    },
    {
      name: 'a draft exceeds the budget ceiling',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, startupCostAmountMinorUnits: 999_00 })),
    },
    {
      name: 'the citation is a vendor pricing page',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, baselineRateCitation: 'https://vendor.example.com/pricing' })),
    },
    {
      name: "the quote doesn't support the stored rate",
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, baselineRateLowAmountMinorUnits: 9900, baselineRateHighAmountMinorUnits: 9900 })),
    },
    {
      // Round 6, fix 6: the retrieved result the quote came from shows a
      // login-wall notice — rejected even though the quote itself still
      // matches and supports the stored rate. Round 12: confirmed still
      // hard (moved back from round 9/10's softened "trust tier" bundle,
      // per the user's explicit "vendor/login-wall checks" hard-rules list).
      name: 'the retrieved source is login-walled',
      corrupt: (drafts) => drafts,
      searchResultTexts: [`Detailed Results:\n\nSign in to see salaries.\n${DEFAULT_RATE_QUOTE}\nMore context.`],
    },
    {
      // Round 7, fix 2 (observed live, not theoretical): attempt 1 hangs
      // past its own wall-clock budget (`draftAttemptTimeoutMs`, a tiny
      // override here so this test doesn't actually wait) — treated as a
      // failed attempt like any other, retried, never left to run past the
      // outer node's own 90s timeout and trigger a whole-turn re-run.
      name: "attempt 1 hangs past its own timeout budget — treated as a failed attempt, not left to run forever",
      corrupt: (drafts) => drafts,
      hangFirstAttempt: true,
    },
    {
      // Story 2.5 (AC: "an idea without sourced evidence is retried, not
      // shown") — the demand-evidence quote gets the exact same hard
      // verbatim-match check as the baseline-rate quote.
      name: "the demand-evidence quote isn't found in any retrieved search result",
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, demandEvidenceQuote: 'This sentence was never actually retrieved.' })),
    },
    {
      // Story 2.5: same `sourceEvidenceLooksBlockedOrHidden` check as the
      // baseline rate, applied to the demand-evidence citation/quote too
      // (AC: "login-walled salary sites ... are never used as a source" —
      // not scoped to the baseline rate alone).
      name: 'the demand-evidence source is login-walled',
      corrupt: (drafts) => drafts,
      searchResultTexts: [
        `Detailed Results:\n\n${DEFAULT_RATE_QUOTE}\nMore context around it.`,
        `Detailed Results:\n\nSign in to see demand data.\n${DEFAULT_DEMAND_EVIDENCE_QUOTE}\nMore context.`,
      ],
    },
    {
      // Story 2.5 (user-reported gap, AD-27): the quote shows '$' but the
      // draft reports the rate as EUR — a genuinely-USD source mislabeled,
      // which would otherwise render as an unconverted, unlabeled "local"
      // EUR figure.
      name: 'the quote currency contradicts the reported baselineRateCurrency',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, baselineRateCurrency: 'EUR' as const })),
    },
  ])('$name', async ({ corrupt, searchResultTexts, hangFirstAttempt }) => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = corrupt(fiveValidDrafts(intakeRow, 'Bad'));
      const generateDrafts = vi.fn();
      if (hangFirstAttempt) {
        // Bug fix regression check: the attempt must receive a real
        // AbortSignal and that signal must actually fire on timeout — the
        // original version of this timeout only stopped *waiting* on a
        // hung attempt, leaving it running in the background and
        // compounding real search/model latency across attempts.
        generateDrafts.mockImplementationOnce(() => new Promise<never>(() => {}));
      } else {
        generateDrafts.mockResolvedValueOnce({ drafts: { ideas: corrupted }, searchResultTexts: searchResultTexts ?? DEFAULT_SEARCH_RESULT_TEXTS });
      }
      generateDrafts.mockResolvedValueOnce({ drafts: { ideas: fiveValidDrafts(intakeRow, 'Good') }, searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS });
      const deps = baseDeps({ generateDrafts, draftAttemptTimeoutMs: hangFirstAttempt ? 50 : undefined });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(2);
      if (hangFirstAttempt) {
        const firstCallSignal = generateDrafts.mock.calls[0]?.[2] as AbortSignal | undefined;
        expect(firstCallSignal).toBeInstanceOf(AbortSignal);
        expect(firstCallSignal?.aborted).toBe(true);
      }
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(5);
    } finally {
      await cleanUp(userId);
    }
  });
});

// I/O matrix: "No intake row" -> "Tool errors, zero rows written".
describe('handleGenerateIdeas (I/O matrix: no intake row)', () => {
  it('throws and never calls the nested agent when the user has no intake row', async () => {
    const userId = await createTestUser();
    try {
      const generateDrafts = vi.fn();
      const deps = baseDeps({ generateDrafts });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow(/intake/);

      expect(generateDrafts).not.toHaveBeenCalled();
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

// I/O matrix: "Happy path" -> "Exactly 5 ideas inserted atomically, each
// citing >=3 fields" (AC1). Table-driven over `replyLanguage` (Story 2.7
// AC4: written once at generation time from the tool's own argument) — the
// 'en'/'de' cases are otherwise identical, so they share this one test.
describe('handleGenerateIdeas (I/O matrix: happy path)', () => {
  it.each(['en', 'de'] as const)('persists exactly 5 ideas atomically, each citing at least 3 intake fields (replyLanguage=%s)', async (replyLanguage) => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const deps = baseDeps({
        generateDrafts: vi.fn().mockResolvedValue({
          drafts: { ideas: fiveValidDrafts(intakeRow, 'Idea') },
          searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS,
        }),
      });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage });

      expect(result).toHaveLength(5);
      for (const idea of result) {
        // Round 6, fix 6: every persisted idea carries a real source-trust
        // tier — this fixture's domains (a-e.example.com) are all the tier-3
        // residual bucket, unverified since each has only its own source
        // text (no second, independent corroborating result).
        expect(idea.sourceTrustTier).toBe('tier_3');
        expect(idea.isRateUnverified).toBe(true);
        // >=3 distinct fields is now a Zod rule (shared/schemas/ideas.ts's
        // citedIntakeFields), not a prose substring count.
        expect(idea.citedIntakeFields.length).toBeGreaterThanOrEqual(3);
        expect(new Set(idea.citedIntakeFields).size).toBe(idea.citedIntakeFields.length);
        // Story 2.7 (AC4): persisted straight from the tool's own argument.
        expect(idea.language).toBe(replyLanguage);
      }
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(5);
    } finally {
      await cleanUp(userId);
    }
  });
});

// AC addition 1: `IDEAS_PER_BATCH` controls exactly how many ideas a run
// persists — table-driven over two distinct configured values, same
// real-Postgres pattern as the happy-path test above.
describe('handleGenerateIdeas (IDEAS_PER_BATCH controls the persisted batch size)', () => {
  it.each([2, 3])('persists exactly %i ideas when IDEAS_PER_BATCH is %i', async (count) => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const deps = baseDeps({
        env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: count },
        generateDrafts: vi.fn().mockResolvedValue({
          drafts: { ideas: nValidDrafts(intakeRow, 'Idea', count) },
          searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS,
        }),
      });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(count);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(count);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.2 round 10 (open item, epics.md Story 2.2 AC: "Generate new
// ideas" replaces the current `suggested` batch, keeping any bookmarked/
// rejected idea). Real DB, real transaction — the route-level id-set
// detection (`ideas.ts`) has its own separate test; this is the actual
// delete+insert behavior.
describe('handleGenerateIdeas (round 10: regenerating replaces the suggested batch, keeps other statuses)', () => {
  it('deletes the old suggested rows and inserts 5 new ones, leaving a bookmarked idea untouched', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const [oldSuggested] = await db
        .insert(ideas)
        .values({
          userId,
          status: 'suggested',
          title: 'Old idea',
          rationale: 'Old rationale line one.\nOld rationale line two.',
          citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
          ideaType: 'service',
          weeklyTimeCommitment: '5_to_10h',
          startupCostAmountMinorUnits: 0,
          startupCostCurrency: 'EUR',
          riskLevel: 'low',
          baselineRateQuote: DEFAULT_RATE_QUOTE,
          baselineRateLowAmountMinorUnits: 2500,
          baselineRateHighAmountMinorUnits: 2500,
          isVendorSource: false,
          rateUnit: 'hour',
          baselineRateCurrency: 'EUR',
          baselineRateCitation: 'https://old.example.com/rates',
          sourceTrustTier: 'tier_3',
          isRateUnverified: false,
        })
        .returning();
      const [bookmarked] = await db
        .insert(ideas)
        .values({
          userId,
          status: 'bookmarked',
          title: 'Kept idea',
          rationale: 'Kept rationale line one.\nKept rationale line two.',
          citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
          ideaType: 'service',
          weeklyTimeCommitment: '5_to_10h',
          startupCostAmountMinorUnits: 0,
          startupCostCurrency: 'EUR',
          riskLevel: 'low',
          baselineRateQuote: DEFAULT_RATE_QUOTE,
          baselineRateLowAmountMinorUnits: 2500,
          baselineRateHighAmountMinorUnits: 2500,
          isVendorSource: false,
          rateUnit: 'hour',
          baselineRateCurrency: 'EUR',
          baselineRateCitation: 'https://kept.example.com/rates',
          sourceTrustTier: 'tier_3',
          isRateUnverified: false,
        })
        .returning();

      const deps = baseDeps({
        generateDrafts: vi.fn().mockResolvedValue({
          drafts: { ideas: fiveValidDrafts(intakeRow, 'New') },
          searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS,
        }),
      });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(result.every((idea) => idea.id !== oldSuggested!.id)).toBe(true);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(6); // 5 new suggested + the 1 kept bookmarked
      expect(rows.some((row) => row.id === bookmarked!.id && row.status === 'bookmarked')).toBe(true);
      expect(rows.some((row) => row.id === oldSuggested!.id)).toBe(false);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.2 round 12 (user-approved — "a batch that passes all hard rules is
// accepted on the first attempt ... soft rules must never trigger a
// retry"): idea-type variety and citation-domain spread/cap no longer block
// at all, on any attempt — a hard-valid batch missing them is accepted and
// persisted on attempt 1, only logged. Table-driven (CLAUDE.md): one row per
// distinct soft rule.
describe('handleGenerateIdeas (round 12: soft rules never block — a hard-valid batch is accepted on the first attempt)', () => {
  it.each<{
    name: string;
    corrupt: (drafts: IdeaDraft[]) => IdeaDraft[];
  }>([
    {
      name: 'insufficient idea-type variety is accepted on the first attempt',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, ideaType: 'service' as const })),
    },
    {
      name: 'insufficient citation-domain spread/cap is accepted on the first attempt',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, baselineRateCitation: 'https://a.example.com/rates' })),
    },
    {
      // Story 2.5: the demand-evidence citations' own domain diversity —
      // same soft (log-only, never-blocking) treatment as the baseline
      // rate's, consistent with round 12's own lesson and this story's "do
      // not add retries" instruction.
      name: 'insufficient demand-evidence citation-domain spread is accepted on the first attempt',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, demandEvidenceCitation: 'https://trend.example.com/demand' })),
    },
  ])('$name', async ({ corrupt }) => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = corrupt(fiveValidDrafts(intakeRow, 'SoftMiss'));
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: corrupted }, searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS });
      const deps = baseDeps({ generateDrafts });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(1); // no retry — accepted immediately
    } finally {
      await cleanUp(userId);
    }
  });

  // Round 12 (user-approved — "never store a lower-trust source as tier_3",
  // carried forward unchanged from round 10): a tier-4 citation is also a
  // soft (never-blocking) rule — accepted on the first attempt, labeled
  // with the real tier_4, never collapsed into a higher-looking tier.
  it('a tier-4 citation is accepted on the first attempt, labeled with the real tier_4', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = fiveValidDrafts(intakeRow, 'Tier4').map((draft) => ({
        ...draft,
        baselineRateCitation: 'https://www.reddit.com/r/freelance/comments/abc',
      }));
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: corrupted }, searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS });
      const deps = baseDeps({ generateDrafts });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(1);
      for (const idea of result) {
        expect(idea.sourceTrustTier).toBe('tier_4');
        expect(idea.isRateUnverified).toBe(true);
      }
    } finally {
      await cleanUp(userId);
    }
  });

  // Round 12 (user-approved — "vendor/login-wall checks" moved back to the
  // hard-rules list): unlike tier-4 classification above, a login-walled/
  // blurred/empty *retrieved page* still blocks and retries (see "the
  // retrieved source is login-walled" in the corrupted-batch table above) —
  // it can't support the number it's cited for at all, a correctness
  // problem, not a confidence one.
  it('a hard-rule failure (e.g. a vendor-pricing-page citation) still blocks on both attempts — never degrades', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = fiveValidDrafts(intakeRow, 'Bad').map((draft) => ({
        ...draft,
        baselineRateCitation: 'https://vendor.example.com/pricing',
      }));
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: corrupted }, searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS });
      const deps = baseDeps({ generateDrafts });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow();

      expect(generateDrafts).toHaveBeenCalledTimes(2);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.5 (AC: "its source describes the same activity or occupation as
// the idea ... otherwise the card shows it as unverified") — the regression
// test for the observed live problem: a high-trust (tier 1/2) source that
// describes a *different* occupation than the idea must still be persisted
// (never rejected for this reason alone), but labeled unverified rather
// than shown with the same unqualified confidence as a genuinely matching
// official source.
describe('handleGenerateIdeas (Story 2.5: an occupation mismatch is persisted, labeled unverified, never blocks)', () => {
  it('a tier-1 source describing a different occupation than the idea is accepted on the first attempt but marked unverified', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const mismatchedRateQuote = 'Data entry clerks earn $25.00 an hour on average.';
      // Review fix (verification-gap #12): also deliberately mismatched on
      // the demand-evidence side (not just relying on the baseline mismatch
      // alone) — this is what actually exercises and proves
      // `isDemandEvidenceUnverified`, which no test previously asserted
      // `true` for anywhere.
      const mismatchedDemandQuote = 'Demand for pet-grooming services has grown steadily this year.';
      const drafts = fiveValidDrafts(intakeRow, 'Mismatch').map((draft) => ({
        ...draft,
        title: 'Freelance Graphic Design',
        baselineRateCitation: 'https://www.bls.gov/oes/current/report.htm',
        baselineRateQuote: mismatchedRateQuote,
        demandEvidenceQuote: mismatchedDemandQuote,
      }));
      const searchResultTexts = [
        `Detailed Results:\n\n${mismatchedRateQuote}\nMore context around it.`,
        `Detailed Results:\n\n${mismatchedDemandQuote}\nMore context around it.`,
      ];
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: drafts }, searchResultTexts });
      const deps = baseDeps({ generateDrafts });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(1); // never blocks — accepted immediately
      for (const idea of result) {
        expect(idea.sourceTrustTier).toBe('tier_1'); // the domain itself is still genuinely tier 1
        expect(idea.isRateUnverified).toBe(true); // but labeled unverified due to the occupation mismatch
        expect(idea.isDemandEvidenceUnverified).toBe(true); // same treatment for the demand-evidence side
      }
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.2 round 9, fix (b)/(d): an already-aborted caller signal (the
// client disconnected, or — since fix (a) removed the outer node's whole-
// turn retry — the outer node's own now-terminal timeout) must stop the
// attempt loop immediately, never start a new attempt on behalf of a caller
// that's already gone.
describe('handleGenerateIdeas (round 9: an already-aborted external signal stops the loop immediately)', () => {
  it('throws without calling generateDrafts when config.signal is already aborted', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, intakeArgs());
      const generateDrafts = vi.fn();
      const deps = baseDeps({ generateDrafts });
      const controller = new AbortController();
      controller.abort(new Error('client disconnected'));

      await expect(
        handleGenerateIdeas(deps, { ...configFor(userId), signal: controller.signal }, { replyLanguage: 'en' }),
      ).rejects.toThrow();

      expect(generateDrafts).not.toHaveBeenCalled();
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

// I/O matrix: "Nested LLM output fails Zod" -> "Never written; retried or
// surfaced as error" (AD-4).
describe('handleGenerateIdeas (I/O matrix: nested LLM output fails Zod)', () => {
  it('retries once, then throws and writes zero rows when output never passes Zod validation', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, intakeArgs());
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: [{ title: '' }] }, searchResultTexts: [] });
      const deps = baseDeps({ generateDrafts });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow();

      expect(generateDrafts).toHaveBeenCalledTimes(2);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.2 round 10 (bug fix, user-approved): an over-length rationale
// bullet is a *correction* (shortened at a word boundary), not a validation
// failure — round 9's Step 1 diagnosis found this costing a whole attempt
// in a real run. Distinct from the genuinely-malformed-shape case above
// (empty title, etc.), which must still fail — this proves the correction
// doesn't swallow real shape problems, only fixes length.
describe('handleGenerateIdeas (round 10: an over-length rationale bullet is shortened, not rejected)', () => {
  it('succeeds on the first attempt with every rationale line within the limit', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      // 25 * 6 + 3 = 153 chars, well over the 140-char per-bullet limit, with
      // a word boundary every 6 characters to truncate cleanly against.
      const longBullet = `${'Alpha '.repeat(25)}end`;
      expect(longBullet.length).toBeGreaterThan(140);
      const drafts = fiveValidDrafts(intakeRow, 'Idea').map((draft, index) =>
        index === 0 ? { ...draft, rationale: [longBullet, 'Start by listing your skills on one platform.'] } : draft,
      );
      const generateDrafts = vi.fn().mockResolvedValue({ drafts: { ideas: drafts }, searchResultTexts: DEFAULT_SEARCH_RESULT_TEXTS });
      const deps = baseDeps({ generateDrafts });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(generateDrafts).toHaveBeenCalledTimes(1);
      for (const idea of result) {
        for (const line of idea.rationale.split('\n')) {
          expect(line.length).toBeLessThanOrEqual(140);
        }
      }
      const truncatedRationale = result.map((idea) => idea.rationale).find((rationale) => longBullet.startsWith(rationale.split('\n')[0]!));
      expect(truncatedRationale).toBeDefined();
    } finally {
      await cleanUp(userId);
    }
  });
});

