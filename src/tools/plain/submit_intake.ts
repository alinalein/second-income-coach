import { eq } from 'drizzle-orm';
import { tool } from 'langchain';
import {
  submitIntakeToolSchema,
  intakeResponseSchema,
  type SubmitIntakeToolArgs,
  type IntakeResponse,
} from '@app/shared';
import type { createDb } from '../../db/client.js';
import { intake } from '../../db/schema/index.js';

type Db = ReturnType<typeof createDb>['db'];
type IntakeRow = typeof intake.$inferSelect;

function toIntakeResponse(row: IntakeRow): IntakeResponse {
  return intakeResponseSchema.parse({
    id: row.id,
    skillsInterests: row.skillsInterests,
    weeklyTimeAvailability: row.weeklyTimeAvailability,
    startingBudgetRange: row.startingBudgetRange,
    riskTolerance: row.riskTolerance,
    stoppedBeforeText: row.stoppedBeforeText,
    failurePattern: row.failurePattern,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * AC2/AC3/AC4: upserts the one `intake` row for `userId` (Design Notes: "one
 * row per user ... upsert on resubmit"). `args` is already Zod-validated by
 * the caller (`submitIntakeToolSchema`) — this function never re-derives or
 * re-classifies anything, it only persists.
 */
export async function upsertIntake(db: Db, userId: string, args: SubmitIntakeToolArgs): Promise<IntakeResponse> {
  const [row] = await db
    .insert(intake)
    .values({ userId, ...args })
    .onConflictDoUpdate({
      target: intake.userId,
      set: { ...args, updatedAt: new Date() },
    })
    .returning();

  return toIntakeResponse(row!);
}

/** AC5: the plain read `GET /api/intake` uses to prefill the form — never a
 * LangChain tool (Boundary: "no `get_intake` agent tool"). */
export async function getIntakeByUserId(db: Db, userId: string): Promise<IntakeResponse | undefined> {
  const [row] = await db.select().from(intake).where(eq(intake.userId, userId)).limit(1);
  return row ? toIntakeResponse(row) : undefined;
}

/**
 * `src/agent/index.ts:62-64`: `buildDiscoveryThreadId(userId) = \`discovery:${userId}\`;`.
 * Duplicated locally rather than imported (Code Map instruction — this file
 * is a plain tool, not part of the agent module) — derives `userId` by
 * stripping that same prefix back off the thread id `tool()` hands this
 * function via `config.configurable.thread_id` (Boundary: "`userId` is
 * derived server-side from the session-rooted thread id — never trusted as
 * a model-supplied tool argument").
 */
const DISCOVERY_THREAD_PREFIX = 'discovery:';

export function deriveUserIdFromThreadId(threadId: string | undefined): string | undefined {
  if (!threadId || !threadId.startsWith(DISCOVERY_THREAD_PREFIX)) return undefined;
  const userId = threadId.slice(DISCOVERY_THREAD_PREFIX.length);
  return userId.length > 0 ? userId : undefined;
}

export interface SubmitIntakeToolRunConfig {
  configurable?: { thread_id?: string };
}

/**
 * The tool's own deterministic logic (AD-4: "never makes its own LLM call"),
 * factored out of the `tool()` adapter below so it's unit-testable without
 * constructing a LangChain `StructuredTool`. `args` has already passed
 * `submitIntakeToolSchema` validation by the time `tool()` invokes `func`
 * (`DynamicStructuredTool` parses against `schema` before calling it); this
 * re-validates anyway so the determinism/validation boundary doesn't rely on
 * that framework behavior alone.
 */
export async function handleSubmitIntake(
  db: Db,
  config: SubmitIntakeToolRunConfig | undefined,
  args: SubmitIntakeToolArgs,
): Promise<IntakeResponse> {
  const userId = deriveUserIdFromThreadId(config?.configurable?.thread_id);
  if (!userId) {
    throw new Error('submit_intake: no userId derivable from the current thread id');
  }

  const parsed = submitIntakeToolSchema.parse(args);
  return upsertIntake(db, userId, parsed);
}

/**
 * AD-4: `submit_intake` as a deterministic plain-code tool. The agent
 * classifies `failurePattern` while constructing this call (Intent) — the
 * tool itself only validates and persists, it never calls a model. Wired
 * into `createCoachAgent`'s `tools: [...]` in `src/agent/index.ts`.
 */
export function createSubmitIntakeTool(db: Db) {
  return tool(
    async (args: SubmitIntakeToolArgs, config: SubmitIntakeToolRunConfig) => {
      const record = await handleSubmitIntake(db, config, args);
      return JSON.stringify(record);
    },
    {
      name: 'submit_intake',
      description:
        'Call this exactly once per turn when the user has provided their intake answers: skills/interests, ' +
        'weekly time availability, starting budget range, risk tolerance, and a free-text answer about what has ' +
        "stopped them from succeeding at a second income before. Classify that free-text answer yourself into " +
        'exactly one failurePattern value: "overwhelm" (too much to do/figure out at once), ' +
        '"loses_interest_once_routine" (starts strong, drops off once it stops being novel), ' +
        '"gets_stuck_no_next_step" (stalls not knowing what to do next), "life_disruption" (an external event — ' +
        'work, family, health — derailed it), or "forgets_deprioritizes" (it simply slips, no specific blocker). ' +
        'Pick the single best-fitting value; never invent a new one.',
      schema: submitIntakeToolSchema,
    },
  );
}
