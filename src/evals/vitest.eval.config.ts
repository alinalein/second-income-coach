import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Story 6.2 Boundary: "Build `src/evals/` as a Vitest-based harness, run
 * only via `npm run eval` — separate Vitest config/glob so it never joins
 * the default `npm test`/CI suite." `src/vitest.config.ts` only ever picks
 * up `**\/*.test.ts`, which no file under `src/evals/` matches, but this
 * sibling config is the one `package.json`'s `eval` script points at
 * explicitly, and is the only config that knows about `*.eval.ts` at all.
 *
 * `root` is pinned to this file's own directory (not left to default to
 * `process.cwd()`) so the `include` glob below resolves the same way
 * whether this is invoked with `cwd` at `src/` (the `npm run eval` script,
 * which `npm --workspace=src` always runs from inside `src/`) or at the
 * repo root (this spec's own one-off verification command: `npx vitest run
 * --config src/evals/vitest.eval.config.ts -t "..."`, run from the repo
 * root).
 */
const evalsDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    root: evalsDir,
    environment: 'node',
    include: ['**/*.eval.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Real model (and judge-model) API calls over the network, several per
    // case/model — comfortably longer than the default 5s unit-test budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
