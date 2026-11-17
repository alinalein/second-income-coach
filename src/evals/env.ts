import type { Env } from '../config/env.js';

export type EvalEnv = Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY' | 'LANGSMITH_PROJECT' | 'IDEAS_PER_BATCH'>;

/**
 * Story 6.2: reads directly off `process.env` — deliberately never
 * `src/config/env.ts`'s `loadEnv()`, which also requires every unrelated
 * production variable (Google OAuth, session secret, Postgres, Tavily, ...)
 * this eval harness never touches, and which the spec's own one-off
 * verification command (`OPENROUTER_API_KEY=<key> LANGSMITH_TRACING=false
 * npx vitest run --config src/evals/vitest.eval.config.ts -t "..."`)
 * deliberately does not set. Only `OPENROUTER_API_KEY` is actually required
 * here — every evaluated model and both judges route through it
 * (Boundary). `MISTRAL_API_KEY`/`IDEAS_PER_BATCH` are accepted for
 * type-shape parity with `Env` but never actually read: `src/evals/
 * harness.ts`'s `buildEvalAgent` always supplies its own pass-through
 * `classify` (short-circuits `createModerationMiddleware`'s only use of
 * `MISTRAL_API_KEY`) and its own explicit `tools: [...]` (so
 * `createCoachAgent`'s default `createGenerateIdeasTool(...)`, the only
 * reader of `IDEAS_PER_BATCH`, is never constructed).
 */
export function loadEvalEnv(source: NodeJS.ProcessEnv = process.env): EvalEnv {
  const openRouterApiKey = source.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required to run the trajectory eval suite (see .env.example).');
  }

  return {
    OPENROUTER_API_KEY: openRouterApiKey,
    MISTRAL_API_KEY: source.MISTRAL_API_KEY ?? 'unused-in-trajectory-eval',
    LANGSMITH_PROJECT: source.LANGSMITH_PROJECT ?? 'unset',
    IDEAS_PER_BATCH: 2,
  };
}
