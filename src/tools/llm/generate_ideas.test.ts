import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { RATIONALE_LINE_MAX_LENGTH, type IdeaDraft, type IntakeResponse, type SubmitIntakeToolArgs } from '@app/shared';
import { createDb } from '../../db/client.js';
import { users, intake, ideas } from '../../db/schema/index.js';
import { buildIdeasTriggerThreadId } from '../../agent/index.js';
import { upsertIntake } from '../plain/submit_intake.js';
import {
  buildQueryPlanningPrompt,
  evaluateSourceTrust,
  extractNumbers,
  getIdeasByUserId,
  handleGenerateIdeas,
  looksLikeSearchServiceErrorText,
  occupationMatchesIdea,
  sourceEvidenceLooksBlockedOrHidden,
  truncateAtWordBoundary,
  type GenerateIdeasDeps,
  type GenerateIdeasRunConfig,
  type QueryPlan,
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

// Pure-function test: the query-planning prompt is the one deterministic
// channel through which intake content reaches the LLM — I/O matrix: "Two
// intakes differ >=2 fields" -> "Resulting sets differ" depends on the real
// model being grounded in a prompt that actually varies with intake
// content, which is what this asserts (the LLM's own behavior given that
// prompt is framework behavior, out of scope per CLAUDE.md).
describe('buildQueryPlanningPrompt (I/O matrix: two intakes differing >=2 fields)', () => {
  it("embeds each intake record's own field values, so differing intakes produce differing prompts", () => {
    const a = fakeIntakeResponse();
    const b = fakeIntakeResponse({ weeklyTimeAvailability: '20h_plus', riskTolerance: 'high' });

    const promptA = buildQueryPlanningPrompt(a, 'en', 2, []);
    const promptB = buildQueryPlanningPrompt(b, 'en', 2, []);

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

    expect(buildQueryPlanningPrompt(germany, 'en', 2, [])).toContain('located in Germany');
    expect(buildQueryPlanningPrompt(other, 'en', 2, [])).toContain("region implied by this reply's language");
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

// Live bug (lane B log): a Tavily auth/quota failure comes back as a
// normal, successful tool result (plain text), never a thrown exception —
// the fail-fast `SearchServiceUnavailableError` check never saw it. Pure-
// function test — no DB/model/agent needed.
describe('looksLikeSearchServiceErrorText (deterministic — treats an error-shaped result as a failed search)', () => {
  it.each([
    { name: 'unauthorized/missing-or-invalid API key', text: 'Unauthorized: missing or invalid API key.' },
    { name: 'usage limit exceeded', text: 'Usage limit exceeded. Please upgrade your plan to continue searching.' },
    { name: 'HTTP 429 status text', text: 'Error: request failed with status code 429 (Too Many Requests).' },
  ])('$name', ({ text }) => {
    expect(looksLikeSearchServiceErrorText(text)).toBe(true);
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

// Story 2.6 (third speed round): `planQueries` is called once per run;
// `query` is one of the fixed, predictable strings below, so a test that
// needs a specific search result for the discovery query vs. an idea's own
// rate query can tell them apart.
function fakePlanQueries() {
  return vi.fn().mockImplementation(async (_intakeRow: unknown, _lang: unknown, count: number) => ({
    discoveryQueries: ['demand query'],
    ideaSeeds: Array.from({ length: count }, (_, i) => ({ angle: `angle ${i + 1}`, rateQuery: `rate query ${i + 1}` })),
  }) satisfies QueryPlan);
}

/** Defaults to the one shared happy-path search-result text for every
 * query; `resolve` lets a test return different text for the discovery
 * query vs. a specific idea's rate query (both fixed strings, see
 * `fakePlanQueries`). */
function fakeSearchWeb(resolve: (query: string) => string = () => DEFAULT_SEARCH_RESULT_TEXTS.join('\n\n')) {
  return vi.fn().mockImplementation(async (query: string) => resolve(query));
}

// Story 2.6 (third speed round): `writeIdea` is called once per idea, in
// parallel across the batch — order-independent (slots may call it in any
// order), so this hands out one draft per call from a shared pool instead
// of returning the whole batch in one call.
function poolWriteIdeaMock(drafts: IdeaDraft[]) {
  const queue = [...drafts];
  return vi.fn().mockImplementation(async () => {
    const draft = queue.shift();
    if (!draft) throw new Error('poolWriteIdeaMock: pool exhausted — test requested more drafts than provided');
    return draft;
  });
}

function baseDeps(overrides: Partial<GenerateIdeasDeps> = {}): GenerateIdeasDeps {
  return {
    db,
    model: {} as never,
    webSearchTool: {} as never,
    env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 5, DAILY_SEARCH_BUDGET: 500 },
    planQueries: fakePlanQueries(),
    searchWeb: fakeSearchWeb(),
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
    corruptFirstRateSearch?: string;
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
      // Story 2.6 (third speed round): the retry re-searches this idea's
      // own rate query, so only the *first* rate-query result is corrupted
      // here — the retry's own fresh search comes back clean.
      name: 'the retrieved source is login-walled',
      corrupt: (drafts) => drafts,
      corruptFirstRateSearch: `Detailed Results:\n\nSign in to see salaries.\n${DEFAULT_RATE_QUOTE}\nMore context.`,
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
      // Story 2.5 (user-reported gap, AD-27): the quote shows '$' but the
      // draft reports the rate as EUR — a genuinely-USD source mislabeled,
      // which would otherwise render as an unconverted, unlabeled "local"
      // EUR figure.
      name: 'the quote currency contradicts the reported baselineRateCurrency',
      corrupt: (drafts) => drafts.map((draft) => ({ ...draft, baselineRateCurrency: 'EUR' as const })),
    },
  ])('$name', async ({ corrupt, corruptFirstRateSearch, hangFirstAttempt }) => {
    // Story 2.6 (third speed round): each idea now retries on its own,
    // independent attempt loop — a single-idea batch (`IDEAS_PER_BATCH: 1`)
    // exercises that one slot's own loop exactly like the old whole-batch
    // loop did when the batch itself was the unit of retry.
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = corrupt([buildValidDraft(intakeRow, { title: 'Bad' })])[0]!;
      const writeIdea = vi.fn();
      if (hangFirstAttempt) {
        // Bug fix regression check: the attempt must receive a real
        // AbortSignal and that signal must actually fire on timeout — the
        // original version of this timeout only stopped *waiting* on a
        // hung attempt, leaving it running in the background and
        // compounding real search/model latency across attempts.
        writeIdea.mockImplementationOnce(() => new Promise<never>(() => {}));
      } else {
        writeIdea.mockResolvedValueOnce(corrupted);
      }
      writeIdea.mockResolvedValueOnce(buildValidDraft(intakeRow, { title: 'Good' }));
      let rateSearchCount = 0;
      const searchWeb = fakeSearchWeb((query) => {
        if (query !== 'rate query 1') return DEFAULT_SEARCH_RESULT_TEXTS[1]!;
        rateSearchCount += 1;
        return rateSearchCount === 1 && corruptFirstRateSearch ? corruptFirstRateSearch : DEFAULT_SEARCH_RESULT_TEXTS[0]!;
      });
      const deps = baseDeps({
        env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 1, DAILY_SEARCH_BUDGET: 500 },
        searchWeb,
        writeIdea,
        draftAttemptTimeoutMs: hangFirstAttempt ? 50 : undefined,
      });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(1);
      expect(writeIdea).toHaveBeenCalledTimes(2);
      if (hangFirstAttempt) {
        const firstCallSignal = writeIdea.mock.calls[0]?.[6] as AbortSignal | undefined;
        expect(firstCallSignal).toBeInstanceOf(AbortSignal);
        expect(firstCallSignal?.aborted).toBe(true);
      }
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.5: same `sourceEvidenceLooksBlockedOrHidden` check as the
// baseline rate, applied to the demand-evidence citation/quote too (AC:
// "login-walled salary sites ... are never used as a source" — not scoped
// to the baseline rate alone). Story 2.6 (third speed round) design
// consequence: the shared discovery search runs exactly once for the
// whole batch and is never retried per idea — unlike a corrupted rate
// query (which a per-idea retry re-searches and can recover from), a
// login-walled shared discovery source stays blocked for every attempt of
// every idea, so the run fails outright rather than recovering on retry.
describe('handleGenerateIdeas (Story 2.5 + third speed round: a login-walled shared discovery source fails the whole run, never recovers on retry)', () => {
  it('exhausts every idea\'s retries and writes zero rows when the one shared discovery result is login-walled', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const writeIdea = vi.fn().mockResolvedValue(buildValidDraft(intakeRow, { title: 'Idea' }));
      const searchWeb = fakeSearchWeb((query) =>
        query === 'demand query' ? `Detailed Results:\n\nSign in to see demand data.\n${DEFAULT_DEMAND_EVIDENCE_QUOTE}\nMore context.` : DEFAULT_SEARCH_RESULT_TEXTS[0]!,
      );
      const deps = baseDeps({ env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 1, DAILY_SEARCH_BUDGET: 500 }, searchWeb, writeIdea });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow();

      // Both attempts for the one idea run (the shared discovery search is
      // never refetched between them), and both fail the same way.
      expect(writeIdea).toHaveBeenCalledTimes(2);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanUp(userId);
    }
  });
});

// I/O matrix: "No intake row" -> "Tool errors, zero rows written".
describe('handleGenerateIdeas (I/O matrix: no intake row)', () => {
  it('throws and never plans, searches, or writes when the user has no intake row', async () => {
    const userId = await createTestUser();
    try {
      const planQueries = vi.fn();
      const searchWeb = vi.fn();
      const writeIdea = vi.fn();
      const deps = baseDeps({ planQueries, searchWeb, writeIdea });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow(/intake/);

      expect(planQueries).not.toHaveBeenCalled();
      expect(searchWeb).not.toHaveBeenCalled();
      expect(writeIdea).not.toHaveBeenCalled();
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
        writeIdea: poolWriteIdeaMock(fiveValidDrafts(intakeRow, 'Idea')),
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
        env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: count, DAILY_SEARCH_BUDGET: 500 },
        writeIdea: poolWriteIdeaMock(nValidDrafts(intakeRow, 'Idea', count)),
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

// Story 2.4 AC1/AC2: "Generate new ideas" now *appends* to every existing
// idea of any status instead of replacing the `suggested` batch — insert-
// only, nothing ever deleted. Real DB, real transaction — the route-level
// id-set detection (`ideas.ts`) has its own separate test; this is the
// actual insert-only write behavior plus the excludeTitles exclusion.
describe('handleGenerateIdeas (Story 2.4: regenerating appends, never deletes or repeats a title)', () => {
  it('keeps every existing idea (suggested and bookmarked) and inserts 5 new ones with no repeated title', async () => {
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

      const writeIdea = poolWriteIdeaMock(fiveValidDrafts(intakeRow, 'New'));
      const deps = baseDeps({ writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(result.every((idea) => idea.id !== oldSuggested!.id && idea.id !== bookmarked!.id)).toBe(true);
      const rows = await db.select().from(ideas).where(eq(ideas.userId, userId));
      // Story 2.4: nothing is ever deleted — 5 new suggested + the 2 old
      // rows (old suggested + bookmarked) survive untouched.
      expect(rows).toHaveLength(7);
      expect(rows.some((row) => row.id === bookmarked!.id && row.status === 'bookmarked')).toBe(true);
      expect(rows.some((row) => row.id === oldSuggested!.id && row.status === 'suggested')).toBe(true);
      // No repeated title across the whole set (old + new).
      const titles = rows.map((row) => row.title);
      expect(new Set(titles).size).toBe(titles.length);
      // Story 2.4: the model is told about every existing title up front —
      // the one server-side DB read Boundary requires, never a model-facing
      // schema field.
      expect(writeIdea).toHaveBeenCalledWith(
        expect.objectContaining({ id: intakeRow.id }),
        'en',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.arrayContaining(['Old idea', 'Kept idea']),
        expect.any(AbortSignal),
      );
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
      const writeIdea = poolWriteIdeaMock(corrupted);
      const deps = baseDeps({ writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(writeIdea).toHaveBeenCalledTimes(5); // 5 slots, no retry — each accepted on its own first attempt
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
      const writeIdea = poolWriteIdeaMock(corrupted);
      const deps = baseDeps({ writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(writeIdea).toHaveBeenCalledTimes(5);
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
    // Single-idea batch: this invariant is a per-slot property under the
    // new per-idea design, so one slot proves it deterministically (5
    // parallel slots each exhausting 2 attempts would too, just less
    // predictably ordered).
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const corrupted = { ...buildValidDraft(intakeRow, { title: 'Bad' }), baselineRateCitation: 'https://vendor.example.com/pricing' };
      const writeIdea = vi.fn().mockResolvedValue(corrupted);
      const deps = baseDeps({
        env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 1, DAILY_SEARCH_BUDGET: 500 },
        writeIdea,
      });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow();

      expect(writeIdea).toHaveBeenCalledTimes(2);
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
      const rateResultText = `Detailed Results:\n\n${mismatchedRateQuote}\nMore context around it.`;
      const demandResultText = `Detailed Results:\n\n${mismatchedDemandQuote}\nMore context around it.`;
      const writeIdea = poolWriteIdeaMock(drafts);
      const searchWeb = fakeSearchWeb((query) => (query === 'demand query' ? demandResultText : rateResultText));
      const deps = baseDeps({ searchWeb, writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(writeIdea).toHaveBeenCalledTimes(5); // 5 slots, never blocks — each accepted on its own first attempt
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
  it('throws without planning, searching, or writing when config.signal is already aborted', async () => {
    const userId = await createTestUser();
    try {
      await upsertIntake(db, userId, intakeArgs());
      const planQueries = vi.fn();
      const searchWeb = vi.fn();
      const writeIdea = vi.fn();
      const deps = baseDeps({ planQueries, searchWeb, writeIdea });
      const controller = new AbortController();
      controller.abort(new Error('client disconnected'));

      await expect(
        handleGenerateIdeas(deps, { ...configFor(userId), signal: controller.signal }, { replyLanguage: 'en' }),
      ).rejects.toThrow();

      expect(planQueries).not.toHaveBeenCalled();
      expect(searchWeb).not.toHaveBeenCalled();
      expect(writeIdea).not.toHaveBeenCalled();
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
      const writeIdea = vi.fn().mockResolvedValue({ title: '' });
      const deps = baseDeps({ env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 1, DAILY_SEARCH_BUDGET: 500 }, writeIdea });

      await expect(handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' })).rejects.toThrow();

      expect(writeIdea).toHaveBeenCalledTimes(2);
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
      // 25 * 6 + 3 = 153 chars, well over the Story 2.6 AC3 100-char
      // per-bullet limit (`RATIONALE_LINE_MAX_LENGTH`), with a word boundary
      // every 6 characters to truncate cleanly against.
      const longBullet = `${'Alpha '.repeat(25)}end`;
      expect(longBullet.length).toBeGreaterThan(RATIONALE_LINE_MAX_LENGTH);
      const drafts = fiveValidDrafts(intakeRow, 'Idea').map((draft, index) =>
        index === 0 ? { ...draft, rationale: [longBullet, 'Start by listing your skills on one platform.'] } : draft,
      );
      const writeIdea = poolWriteIdeaMock(drafts);
      const deps = baseDeps({ writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(5);
      expect(writeIdea).toHaveBeenCalledTimes(5);
      for (const idea of result) {
        for (const line of idea.rationale.split('\n')) {
          expect(line.length).toBeLessThanOrEqual(RATIONALE_LINE_MAX_LENGTH);
        }
      }
      const truncatedRationale = result.map((idea) => idea.rationale).find((rationale) => longBullet.startsWith(rationale.split('\n')[0]!));
      expect(truncatedRationale).toBeDefined();
    } finally {
      await cleanUp(userId);
    }
  });
});

// Review fix (Story 2.4's insert-only persistence means an old row can
// never be deleted): a row written under a since-shrunk cap
// (`RATIONALE_LINE_MAX_LENGTH`/etc, `shared/schemas/ideas.ts`) must never
// take down this user's entire `GET /api/ideas` read — `getIdeasByUserId`
// skips just that row instead of letting `ideaResponseSchema.parse()` throw.
describe('getIdeasByUserId (review fix: a row that now fails schema validation is skipped, not thrown)', () => {
  it('returns the valid rows and silently skips one whose rationale now exceeds the current cap', async () => {
    const userId = await createTestUser();
    try {
      const oversizedRationale = `${'x'.repeat(RATIONALE_LINE_MAX_LENGTH + 10)}\nSecond line.`;
      await db.insert(ideas).values({
        userId,
        status: 'suggested',
        title: 'Legacy idea from before the cap shrank',
        rationale: oversizedRationale,
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
        baselineRateCitation: 'https://legacy.example.com/rates',
        sourceTrustTier: 'tier_3',
        isRateUnverified: false,
      });
      const [validRow] = await db
        .insert(ideas)
        .values({
          userId,
          status: 'suggested',
          title: 'Still-valid idea',
          rationale: 'Fits your week.\nStart today.',
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
          baselineRateCitation: 'https://valid.example.com/rates',
          sourceTrustTier: 'tier_3',
          isRateUnverified: false,
        })
        .returning();

      const result = await getIdeasByUserId(db, userId);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(validRow!.id);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Review fix: Story 2.4's insert-only persistence means a user's row count
// only ever grows — `existingTitles` must stay bounded, not read every
// title the user has ever had, so this proves the cap is actually applied
// at the DB query, not just a documentation comment.
describe('handleGenerateIdeas (review fix: excludeTitles is capped, not unbounded)', () => {
  it('passes at most 50 titles as excludeTitles even when the user has more than 50 existing ideas', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const rowCount = 55;
      await db.insert(ideas).values(
        Array.from({ length: rowCount }, (_, i) => ({
          userId,
          status: 'suggested' as const,
          title: `Existing idea ${i + 1}`,
          rationale: 'Fits your week.\nStart today.',
          citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
          ideaType: 'service' as const,
          weeklyTimeCommitment: '5_to_10h' as const,
          startupCostAmountMinorUnits: 0,
          startupCostCurrency: 'EUR' as const,
          riskLevel: 'low' as const,
          baselineRateQuote: DEFAULT_RATE_QUOTE,
          baselineRateLowAmountMinorUnits: 2500,
          baselineRateHighAmountMinorUnits: 2500,
          isVendorSource: false,
          rateUnit: 'hour' as const,
          baselineRateCurrency: 'EUR' as const,
          baselineRateCitation: 'https://a.example.com/rates',
          sourceTrustTier: 'tier_3' as const,
          isRateUnverified: false,
        })),
      );
      const writeIdea = poolWriteIdeaMock(fiveValidDrafts(intakeRow, 'New'));
      const deps = baseDeps({ writeIdea });

      await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      const excludeTitles = writeIdea.mock.calls[0]?.[5] as string[] | undefined;
      expect(excludeTitles).toHaveLength(50);
    } finally {
      await cleanUp(userId);
    }
  });
});

// Story 2.6 (third speed round, final AC): the nested ReAct agent is
// replaced by an explicit pipeline — one planning call, a direct search
// round, then one writing call per idea, no tool-calling loop anywhere.
describe('handleGenerateIdeas (Story 2.6 third round: explicit pipeline, no agent loop)', () => {
  it('plans once and writes once per idea — a bounded number of model calls (1 planning + N writing)', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs());
      const planQueries = fakePlanQueries();
      const writeIdea = poolWriteIdeaMock(nValidDrafts(intakeRow, 'Idea', 3));
      const deps = baseDeps({ env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 3, DAILY_SEARCH_BUDGET: 500 }, planQueries, writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(3);
      expect(planQueries).toHaveBeenCalledTimes(1); // exactly one planning call for the whole batch
      expect(writeIdea).toHaveBeenCalledTimes(3); // exactly one writing call per idea, no retries
    } finally {
      await cleanUp(userId);
    }
  });

  it('runs the shared discovery search exactly once for the whole batch, even when one idea retries its own rate-query search', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const badDraft = { ...buildValidDraft(intakeRow, { title: 'Bad' }), baselineRateCitation: 'https://vendor.example.com/pricing' };
      let writeCount = 0;
      const writeIdea = vi.fn().mockImplementation(async () => {
        writeCount += 1;
        return writeCount === 1 ? badDraft : buildValidDraft(intakeRow, { title: `Good ${writeCount}` });
      });
      const searchWeb = fakeSearchWeb();
      const deps = baseDeps({ env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 2, DAILY_SEARCH_BUDGET: 500 }, searchWeb, writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(2);
      const discoveryCalls = searchWeb.mock.calls.filter((call) => call[0] === 'demand query');
      expect(discoveryCalls).toHaveLength(1); // never refetched by a per-idea retry
    } finally {
      await cleanUp(userId);
    }
  });

  it('retries only the one idea that failed a hard check, never redoing a sibling idea that already succeeded', async () => {
    const userId = await createTestUser();
    try {
      const intakeRow = await upsertIntake(db, userId, intakeArgs({ startingBudgetRange: 'under_100' }));
      const badDraft = { ...buildValidDraft(intakeRow, { title: 'Bad' }), baselineRateCitation: 'https://vendor.example.com/pricing' };
      let callCount = 0;
      // Exactly the first call (whichever of the two parallel slots gets
      // there first — order-independent) returns a hard-failing draft;
      // every other call, including that slot's own retry, returns a
      // valid one. A whole-batch retry would need a full extra round for
      // *both* ideas (4 calls); per-idea retry needs exactly one extra
      // call (3).
      const writeIdea = vi.fn().mockImplementation(async () => {
        callCount += 1;
        return callCount === 1 ? badDraft : buildValidDraft(intakeRow, { title: `Good ${callCount}` });
      });
      const deps = baseDeps({ env: { MISTRAL_API_KEY: 'test-key', IDEAS_PER_BATCH: 2, DAILY_SEARCH_BUDGET: 500 }, writeIdea });

      const result = await handleGenerateIdeas(deps, configFor(userId), { replyLanguage: 'en' });

      expect(result).toHaveLength(2);
      expect(writeIdea).toHaveBeenCalledTimes(3);
    } finally {
      await cleanUp(userId);
    }
  });
});

