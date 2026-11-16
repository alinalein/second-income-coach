import '../config/loadDotenv.js';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createCheckpointer } from '../agent/checkpointer.js';
import { createCoachAgent } from '../agent/index.js';
import { createApp } from './app.js';

const CHECKPOINTER_SETUP_TIMEOUT_MS = 10_000;

class StartupTimeoutError extends Error {}

/**
 * Bounds a startup step that talks to an external dependency so an
 * unreachable/slow instance (e.g. Postgres not running) fails fast with a
 * clear message, instead of `await`ing forever — the same "fail fast and
 * loud" behavior every other startup error in this file already has.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StartupTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

try {
  const env = loadEnv();
  const { db, pool } = createDb(env);

  // Intent: "`PostgresSaver.setup()` runs once, idempotently, at API
  // startup (its own schema — not a Drizzle migration)."
  const checkpointer = createCheckpointer(env);
  await withTimeout(checkpointer.setup(), CHECKPOINTER_SETUP_TIMEOUT_MS, 'Checkpointer setup');
  // Story 5.1: `db` lets the agent resolve each turn's personality/model
  // from `user_settings` (AD-20).
  const agent = createCoachAgent({ env, checkpointer, db });

  const app = createApp({ env, db, pool, agent });

  const server = app.listen(env.PORT, () => {
    console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    // Same clean "startup failed" messaging as an env error, e.g. EADDRINUSE —
    // instead of crashing with a raw Node stack trace.
    console.error(`[api] startup failed:\n${error.message}`);
    process.exit(1);
  });
} catch (error) {
  if (error instanceof EnvValidationError || error instanceof StartupTimeoutError) {
    // Clear, non-silent failure (missing/invalid env var, or a startup
    // dependency that didn't respond in time), then exit.
    console.error(`[api] startup failed:\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
