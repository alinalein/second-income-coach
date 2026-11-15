import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createGeneralRateLimiter } from './middleware/rateLimit.js';
import { createHealthRouter } from './routes/health.js';

export interface AppDeps {
  env: Env;
  db: ReturnType<typeof createDb>['db'];
}

/**
 * Express app factory (AD-30 security baseline):
 *  - `helmet` for security headers
 *  - same-origin `cors` (deny-by-default allowlist)
 *  - `express-rate-limit`, general tier, on every route
 *  - a configured request body-size limit, rejected before any route handler runs
 *
 * Built as a factory (not a top-level `listen()`) so tests can construct the
 * app against injected deps without binding a real port or a real database.
 */
export function createApp({ env, db }: AppDeps) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createCorsMiddleware(env));
  app.use(createGeneralRateLimiter(env));
  app.use(express.json({ limit: env.BODY_LIMIT }));

  app.use('/api/health', createHealthRouter({ db }));

  // Centralized error handler. Oversized bodies and malformed JSON surface
  // here as errors from the body parser — this is what keeps the process
  // alive with a generic response instead of crashing (I/O matrix: "Oversized
  // request body").
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express requires 4-arg signature to register an error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      (err as { status?: number; statusCode?: number } | undefined)?.status ??
      (err as { statusCode?: number } | undefined)?.statusCode ??
      500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Bad request' });
  });

  return app;
}
