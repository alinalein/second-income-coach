import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createTrajectoryMatchEvaluator,
  createTrajectoryLLMAsJudge,
  TRAJECTORY_ACCURACY_PROMPT,
  type EvaluatorResult,
  type FlexibleChatCompletionMessage,
} from 'agentevals';
import { loadEvalEnv } from './env.js';
import { buildEvalAgent, runFixtureTurn } from './harness.js';
import { createJudgeModels } from './judges.js';
import { EVAL_MODEL_IDS, JUDGE_MODEL_IDS, TRAJECTORY_ACCURACY_TARGET, type JudgeModelId } from './constants.js';

/**
 * Story 6.2 (AC1): the committed, versioned fixture shape every file under
 * `src/evals/fixtures/*.json` follows. `referenceTrajectory` is a plain
 * `FlexibleChatCompletionMessage[]` (agentevals' own term) — OpenAI
 * chat-completion-shaped dicts, never LangChain `BaseMessage` instances
 * (JSON can't hold those); `agentevals` normalizes both this and the real
 * `BaseMessage[]` trajectory `runFixtureTurn` returns into the same shape
 * before comparing them.
 */
interface Fixture {
  id: string;
  type: 'deterministic' | 'quality';
  language: 'en' | 'de';
  toolUnderTest: string;
  input: { role: 'human'; content: string }[];
  /** Required for `type: 'deterministic'`; absent for `type: 'quality'`
   * (Intent: "no reference required to pass structurally" for a quality
   * case). */
  referenceTrajectory?: FlexibleChatCompletionMessage[];
}

const evalsDir = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = path.join(evalsDir, 'fixtures');
const resultsPath = path.join(evalsDir, 'results', 'trajectory-results.json');

/** A malformed fixture must fail loudly and specifically — naming the exact
 * file and field — rather than either crashing with a bare JSON/TS error
 * that doesn't say which of the 17 files is at fault, or (worse) silently
 * reaching `fixture.referenceTrajectory!`'s non-null assertion as
 * `undefined` for a `deterministic` case missing its reference. */
function assertFixtureShape(fileName: string, data: unknown): asserts data is Fixture {
  const fail = (reason: string): never => {
    throw new Error(`src/evals/fixtures/${fileName}: ${reason}`);
  };
  if (typeof data !== 'object' || data === null) fail('must be a JSON object');
  const fixture = data as Partial<Fixture>;

  if (typeof fixture.id !== 'string' || fixture.id.length === 0) fail('missing or invalid "id" (expected a non-empty string)');
  if (fixture.type !== 'deterministic' && fixture.type !== 'quality') {
    fail(`"type" must be "deterministic" or "quality", got ${JSON.stringify(fixture.type)}`);
  }
  if (fixture.language !== 'en' && fixture.language !== 'de') {
    fail(`"language" must be "en" or "de", got ${JSON.stringify(fixture.language)}`);
  }
  if (typeof fixture.toolUnderTest !== 'string' || fixture.toolUnderTest.length === 0) {
    fail('missing or invalid "toolUnderTest" (expected a non-empty string)');
  }
  if (!Array.isArray(fixture.input) || fixture.input.length === 0 || typeof fixture.input[0]?.content !== 'string') {
    fail('"input" must be a non-empty array of {role, content} messages');
  }
  if (fixture.type === 'deterministic' && !Array.isArray(fixture.referenceTrajectory)) {
    fail('type "deterministic" requires a "referenceTrajectory" array');
  }
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
      } catch (error) {
        throw new Error(`src/evals/fixtures/${name}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      assertFixtureShape(name, data);
      return data;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const fixtures = loadFixtures();
const env = loadEvalEnv();
const judgeModels = createJudgeModels(env);

/** One scored row per (model, case) for a deterministic case, or per
 * (model, case, judge) for a quality case (AC3/AC4: "results record which
 * judge scored which model"). */
interface ResultRow {
  modelId: string;
  caseId: string;
  caseType: Fixture['type'];
  language: Fixture['language'];
  toolUnderTest: string;
  judgeId?: JudgeModelId;
  score: EvaluatorResult['score'] | null;
  comment?: string;
  error?: string;
  langsmithProject?: string;
  langsmithRunId?: string;
}

const resultRows: ResultRow[] = [];

async function runDeterministicCase(modelId: string, fixture: Fixture): Promise<ResultRow> {
  const base = { modelId, caseId: fixture.id, caseType: fixture.type, language: fixture.language, toolUnderTest: fixture.toolUnderTest };

  try {
    // `buildEvalAgent` itself inside the `try` — a synchronous construction
    // failure must still produce a recorded error row, not silently drop
    // this (model, case) from the results file.
    const evalAgent = buildEvalAgent(modelId, env);
    const threadId = `discovery:eval-${fixture.id}-${modelId}`;
    const outputs = await runFixtureTurn(evalAgent, threadId, [new HumanMessage(fixture.input[0]!.content)]);
    // Boundaries: "createTrajectoryMatchEvaluator with toolArgsMatchMode:
    // 'exact'" — trajectoryMatchMode left at its library default (strict),
    // no judge model involved (AC2).
    const evaluator = createTrajectoryMatchEvaluator({ toolArgsMatchMode: 'exact' });
    const result = await evaluator({ outputs, referenceOutputs: fixture.referenceTrajectory! });
    return {
      ...base,
      score: result.score,
      comment: result.comment,
      langsmithProject: env.LANGSMITH_PROJECT,
      langsmithRunId: evalAgent.getLastRunId(),
    };
  } catch (error) {
    return { ...base, score: null, error: error instanceof Error ? error.message : String(error) };
  }
}

interface QualityTrajectory {
  outputs?: BaseMessage[];
  langsmithRunId?: string;
  error?: string;
}

/** One real target-model turn per (model, fixture) — memoized so the two
 * judges in `JUDGE_MODEL_IDS` score the exact same sampled trajectory
 * instead of each triggering their own independent (and independently
 * priced) model run. Safe because Vitest runs `it`s within one `describe`
 * sequentially, so the first judge's call always populates the cache before
 * the second judge's call reads it. */
const qualityTrajectoryCache = new Map<string, Promise<QualityTrajectory>>();

function getOrGenerateQualityTrajectory(modelId: string, fixture: Fixture): Promise<QualityTrajectory> {
  const cacheKey = `${modelId}::${fixture.id}`;
  const cached = qualityTrajectoryCache.get(cacheKey);
  if (cached) return cached;

  const generated = (async (): Promise<QualityTrajectory> => {
    try {
      const evalAgent = buildEvalAgent(modelId, env);
      const threadId = `discovery:eval-${fixture.id}-${modelId}`;
      const outputs = await runFixtureTurn(evalAgent, threadId, [new HumanMessage(fixture.input[0]!.content)]);
      return { outputs, langsmithRunId: evalAgent.getLastRunId() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();
  qualityTrajectoryCache.set(cacheKey, generated);
  return generated;
}

async function runQualityCase(modelId: string, fixture: Fixture, judgeId: JudgeModelId): Promise<ResultRow> {
  const base = {
    modelId,
    caseId: fixture.id,
    caseType: fixture.type,
    language: fixture.language,
    toolUnderTest: fixture.toolUnderTest,
    judgeId,
  };

  const generation = await getOrGenerateQualityTrajectory(modelId, fixture);
  if (generation.outputs === undefined) {
    return { ...base, score: null, error: generation.error };
  }

  try {
    // AC3/AC4: only one of the two pinned judges ever scores a quality
    // case, built via `createChatModel`/`createJudgeModels` (OpenRouter),
    // passed as `judge` — never the `model: "provider:id"` string form.
    const evaluator = createTrajectoryLLMAsJudge({ prompt: TRAJECTORY_ACCURACY_PROMPT, judge: judgeModels[judgeId] });
    const result = await evaluator({ outputs: generation.outputs });
    return {
      ...base,
      score: result.score,
      comment: result.comment,
      langsmithProject: env.LANGSMITH_PROJECT,
      langsmithRunId: generation.langsmithRunId,
    };
  } catch (error) {
    // I/O matrix: "judge call failure recorded as an error row, run
    // continues to next case" — never rethrown. Each judge still gets its
    // own try/catch here even though the trajectory itself is shared, so
    // one judge's failure never affects the other's row.
    return { ...base, score: null, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ModelAccuracy {
  modelId: string;
  deterministicCaseCount: number;
  passedCaseCount: number;
  accuracy: number;
  meetsTarget: boolean;
}

/** AC5: 80% tool-call accuracy as a per-model (never aggregate) figure,
 * computed only from the deterministic (`toolArgsMatchMode: 'exact'`) rows
 * — quality-case judge scores are recorded separately (`resultRows`
 * themselves) and never folded into this figure. The actual number is
 * always included, even when it's below `TRAJECTORY_ACCURACY_TARGET`. */
function aggregatePerModelAccuracy(rows: ResultRow[]): ModelAccuracy[] {
  return EVAL_MODEL_IDS.map((modelId) => {
    const deterministicRows = rows.filter((row) => row.modelId === modelId && row.caseType === 'deterministic');
    const passedCaseCount = deterministicRows.filter((row) => row.score === true).length;
    const accuracy = deterministicRows.length > 0 ? passedCaseCount / deterministicRows.length : 0;
    return {
      modelId,
      deterministicCaseCount: deterministicRows.length,
      passedCaseCount,
      accuracy,
      meetsTarget: accuracy >= TRAJECTORY_ACCURACY_TARGET,
    };
  });
}

describe('trajectory eval suite (Story 6.2, AD-23)', () => {
  for (const modelId of EVAL_MODEL_IDS) {
    for (const fixture of fixtures) {
      if (fixture.type === 'deterministic') {
        // Verification: filtering on one of these test names (`-t`) is the
        // one real-API-call check for this build session — never the full
        // matrix below.
        it(`${modelId} :: ${fixture.id}`, async () => {
          const row = await runDeterministicCase(modelId, fixture);
          resultRows.push(row);
          // Structural assertion only (AC5: "the actual number is always
          // written even below target") — a low/false score is a real,
          // recorded measurement, not a test failure. Only an evaluator
          // crash (caught above as `row.error`) is a build problem.
          expect(row.error).toBeUndefined();
        });
      } else {
        for (const judgeId of JUDGE_MODEL_IDS) {
          it(`${modelId} :: ${fixture.id} :: ${judgeId}`, async () => {
            const row = await runQualityCase(modelId, fixture, judgeId);
            resultRows.push(row);
            // No assertion on `row.error` here — a judge-call failure is
            // itself a valid, recorded outcome for a quality case (I/O
            // matrix), not a test failure.
          });
        }
      }
    }
  }

  // Runs last (Vitest executes `it`s within one `describe` in declaration
  // order): writes the one results file only once every case/model/judge
  // combination above has already pushed its row — an interrupted run
  // never reaches this point, so it never leaves a stale/partial file (I/O
  // matrix).
  it('writes the aggregated per-model results file', () => {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          trajectoryAccuracyTarget: TRAJECTORY_ACCURACY_TARGET,
          perModelAccuracy: aggregatePerModelAccuracy(resultRows),
          rows: resultRows,
        },
        null,
        2,
      ),
    );
  });
});
