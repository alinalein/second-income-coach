import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { config as loadDotenvConfig } from 'dotenv';
import { createDb } from '../db/client.js';
import { createChatModel } from '../agent/model.js';
import { getWebSearchTool } from '../tools/mcp/web_search.js';
import { handleGenerateIdeas } from '../tools/llm/generate_ideas.js';
import { upsertIntake } from '../tools/plain/submit_intake.js';
import { users, intake, ideas } from '../db/schema/index.js';

/**
 * Regression smoke test for `generate_ideas` (found live from a real
 * `502`: "generate_ideas: one draft attempt exceeded its 30000ms
 * budget" — a unit test with an empty DB never saw this, because the
 * query-planning call only gets slow once a user's real idea history has
 * grown). Runs the real pipeline once, end to end, against a seeded,
 * heavy-history fixture user on the TEST database, with the real default
 * model — never mocked — so a genuine latency regression (this one, or a
 * new one) shows up here before it reaches production. Deliberately not
 * a `*.test.ts` file (never picked up by `npm test`'s own glob) — real
 * model/network calls, run on demand via `npm run smoke:ideas`.
 */

// Same pattern as `src/evals/vitest.eval.config.ts`'s own dotenv loading —
// never the `config/loadDotenv.ts` the server uses (that one no-ops under
// `NODE_ENV=test`, which this script's own test-db usage implies). Only
// sets variables not already present in the environment (dotenv's own
// default), so an inline `KEY=value npm run smoke:ideas` always wins.
loadDotenvConfig({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const TEST_DATABASE_URL_FRAGMENT = 'second_income_coach_b_test';
const FIXED_GOOGLE_ID = 'smoke-ideas-fixed-test-user';
const FIXED_EMAIL = 'smoke-ideas@test.local';
const PRE_SEEDED_IDEA_COUNT = 30;
const MIN_IDEAS_EXPECTED = 3;
const TOTAL_BUDGET_MS = 60_000;
const QUERY_PLANNING_BUDGET_MS = 30_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`smoke:ideas: ${name} is required (set it inline, e.g. ${name}=... npm run smoke:ideas)`);
  return value;
}

function loadSmokeEnv() {
  const databaseUrl = requireEnv('DATABASE_URL');
  // Safety: this script writes real rows and must never touch the main
  // database — refuses to run against anything but the test DB, no
  // exception, regardless of what `.env`/the ambient shell happens to set.
  if (!databaseUrl.includes(TEST_DATABASE_URL_FRAGMENT)) {
    throw new Error(
      `smoke:ideas: DATABASE_URL must point at the test database (containing "${TEST_DATABASE_URL_FRAGMENT}"), got a different one. Refusing to run against it.`,
    );
  }
  const webSearchMode = process.env.WEB_SEARCH_MODE;
  if (webSearchMode !== 'stub') {
    throw new Error('smoke:ideas: WEB_SEARCH_MODE must be "stub" — refusing to spend real search credits in a smoke test.');
  }
  return {
    DATABASE_URL: databaseUrl,
    OPENROUTER_API_KEY: requireEnv('OPENROUTER_API_KEY'),
    MISTRAL_API_KEY: requireEnv('MISTRAL_API_KEY'),
    // Never read in stub mode (`getWebSearchTool`'s own early return) —
    // a placeholder is enough; never required to actually be real.
    TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? 'unused-in-smoke-stub-mode',
    IDEAS_PER_BATCH: Number(process.env.IDEAS_PER_BATCH ?? 3),
    DAILY_SEARCH_BUDGET: Number(process.env.DAILY_SEARCH_BUDGET ?? 500),
    WEB_SEARCH_MODE: webSearchMode,
  } as const;
}

const SAMPLE_INTAKE = {
  skillsInterests: 'Woodworking, basic bookkeeping',
  weeklyTimeAvailability: '5_to_10h' as const,
  startingBudgetRange: 'under_100' as const,
  riskTolerance: 'low' as const,
  stoppedBeforeText: 'I got overwhelmed trying to do everything at once.',
  country: 'DE' as const,
  failurePattern: 'overwhelm' as const,
};

/** Intercepts this file's own `console.log` calls for the duration of the
 * real `handleGenerateIdeas` run below, to read back the per-stage
 * `[timing]`/`[diagnosis]` figures that function already logs
 * permanently (Boundary: this script never modifies `generate_ideas.ts`
 * — it only reads what it already prints) — forwarded to the real
 * console unchanged, so a manual run still sees every line live. */
function captureTimingLogs(): { stop: () => { tag: string; data: Record<string, unknown> }[] } {
  const captured: { tag: string; data: Record<string, unknown> }[] = [];
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    if (typeof args[0] === 'string' && (args[0].startsWith('[timing]') || args[0].startsWith('[diagnosis]')) && typeof args[1] === 'object' && args[1] !== null) {
      captured.push({ tag: args[0], data: args[1] as Record<string, unknown> });
    }
  };
  return {
    stop: () => {
      console.log = originalLog;
      return captured;
    },
  };
}

function sumMs(logs: { tag: string; data: Record<string, unknown> }[], tag: string): number {
  return logs.filter((entry) => entry.tag === tag).reduce((sum, entry) => sum + (Number(entry.data.ms) || 0), 0);
}

async function main(): Promise<void> {
  const env = loadSmokeEnv();
  const { db, pool } = createDb(env);
  const model = createChatModel(env);
  const { tool: webSearchTool, close: closeWebSearchTool } = await getWebSearchTool(env);

  let userId: string | undefined;
  let exitCode = 0;

  try {
    // Self-healing: a prior crashed run may have left this fixed identity
    // behind without cleaning up — clear it before seeding fresh, rather
    // than failing on a unique-constraint collision.
    const stale = await db.select({ id: users.id }).from(users).where(eq(users.googleId, FIXED_GOOGLE_ID));
    for (const row of stale) {
      await db.delete(ideas).where(eq(ideas.userId, row.id));
      await db.delete(intake).where(eq(intake.userId, row.id));
      await db.delete(users).where(eq(users.id, row.id));
    }

    const [user] = await db
      .insert(users)
      .values({ googleId: FIXED_GOOGLE_ID, email: FIXED_EMAIL, name: 'Smoke Test User', picture: null })
      .returning();
    userId = user!.id;

    await upsertIntake(db, userId, SAMPLE_INTAKE);

    // Root cause being guarded against: `existingTitles` (every idea this
    // user has ever been shown) feeds the query-planning prompt — this
    // pre-seeds a heavy, long-running-user-shaped history so a future
    // regression (the cap removed, or a new unbounded growth elsewhere)
    // shows up here, not only in production after weeks of real usage.
    await db.insert(ideas).values(
      Array.from({ length: PRE_SEEDED_IDEA_COUNT }, (_, i) => ({
        userId: userId!,
        status: 'suggested' as const,
        title: `Pre-seeded smoke-test idea number ${i + 1} about something fairly ordinary`,
        rationale: 'Fits your week.\nStart today.',
        citedIntakeFields: ['weeklyTimeAvailability', 'riskTolerance', 'startingBudgetRange'],
        ideaType: 'service' as const,
        weeklyTimeCommitment: '5_to_10h' as const,
        startupCostAmountMinorUnits: 0,
        startupCostCurrency: 'EUR' as const,
        riskLevel: 'low' as const,
        baselineRateQuote: 'Workers in this field earn $25.00 an hour on average.',
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

    const capture = captureTimingLogs();
    const runStart = performance.now();
    let ideaCount = 0;
    let runError: Error | undefined;
    try {
      const result = await handleGenerateIdeas(
        { db, model, webSearchTool, env },
        { configurable: { thread_id: `ideas-trigger:${userId}` } },
        { replyLanguage: 'en' },
      );
      ideaCount = result.length;
    } catch (error) {
      runError = error instanceof Error ? error : new Error(String(error));
    }
    const totalMs = Math.round(performance.now() - runStart);
    const logs = capture.stop();

    const queryPlanningMs = sumMs(logs, '[timing] generate_ideas query_planning_total');
    const searchRoundMs = sumMs(logs, '[timing] generate_ideas shared_search_round_total');
    const writingCallsMs = logs.filter((entry) => entry.tag === '[timing] generate_ideas idea_write').map((entry) => Number(entry.data.ms) || 0);
    const attemptMsTotal = sumMs(logs, '[diagnosis] generate_ideas idea_attempt_result');
    const writingMsTotal = writingCallsMs.reduce((sum, ms) => sum + ms, 0);
    // Derived, not directly logged (Boundary: no new log added to
    // `generate_ideas.ts`) — every attempt's own total minus its writing
    // call's own total leaves intake re-read + validation + any retry's
    // own re-search, summed across the whole run (never claimed as an
    // exact isolated per-call figure).
    const validationAndOverheadMs = Math.max(0, attemptMsTotal - writingMsTotal);

    console.log('\n=== generate_ideas smoke test ===');
    console.log(`ideas returned: ${ideaCount}`);
    console.log(`query planning: ${queryPlanningMs} ms`);
    console.log(`searches (shared round): ${searchRoundMs} ms`);
    writingCallsMs.forEach((ms, i) => console.log(`writing call ${i + 1}: ${ms} ms`));
    console.log(`validation + intake re-read (derived, summed across all attempts): ${validationAndOverheadMs} ms`);
    console.log(`total: ${totalMs} ms`);

    if (runError) {
      console.error(`FAIL: handleGenerateIdeas threw: ${runError.message}`);
      exitCode = 1;
    }
    if (ideaCount < MIN_IDEAS_EXPECTED) {
      console.error(`FAIL: expected at least ${MIN_IDEAS_EXPECTED} ideas, got ${ideaCount}`);
      exitCode = 1;
    }
    if (totalMs > TOTAL_BUDGET_MS) {
      console.error(`FAIL: total ${totalMs}ms exceeded the ${TOTAL_BUDGET_MS}ms budget`);
      exitCode = 1;
    }
    if (queryPlanningMs > QUERY_PLANNING_BUDGET_MS) {
      console.error(`FAIL: query planning ${queryPlanningMs}ms exceeded the ${QUERY_PLANNING_BUDGET_MS}ms budget`);
      exitCode = 1;
    }
    if (exitCode === 0) console.log('PASS');
  } finally {
    if (userId) {
      await db.delete(ideas).where(eq(ideas.userId, userId));
      await db.delete(intake).where(eq(intake.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await closeWebSearchTool();
    await pool.end();
  }

  process.exitCode = exitCode;
}

void main();
