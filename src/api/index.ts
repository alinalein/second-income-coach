import 'dotenv/config';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createApp } from './app.js';

try {
  const env = loadEnv();
  const { db, pool } = createDb(env);
  const app = createApp({ env, db, pool });

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
  if (error instanceof EnvValidationError) {
    // Clear, non-silent failure naming the missing/invalid env var(s), then exit.
    console.error(`[api] startup failed:\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
