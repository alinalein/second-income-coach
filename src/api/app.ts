import bytes from 'bytes';
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
 *    (enforced as a blanket Content-Length check ahead of any body parser, so
 *    it applies regardless of content type, not just the JSON parser below)
 *
 * Built as a factory (not a top-level `listen()`) so tests can construct the
 * app against injected deps without binding a real port or a real database.
 */
export function createApp({ env, db }: AppDeps) {
  const app = express();

  // Behind a reverse proxy (Cloud Run, or any future load balancer), trust the
  // first hop's X-Forwarded-For so the rate limiter (and any future IP-based
  // logic) resolves the real client IP instead of the proxy's.
  app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(createCorsMiddleware(env));
  app.use(createGeneralRateLimiter(env));

  const maxBodyBytes = bytes.parse(env.BODY_LIMIT) ?? Number.POSITIVE_INFINITY;
  app.use((req, res, next) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      res.status(413).json({ error: 'Bad request' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: env.BODY_LIMIT }));

  app.use('/api/health', createHealthRouter({ db }));

  // Centralized error handler. Oversized bodies and malformed JSON surface
  // here as errors from the body parser — this is what keeps the process
  // alive with a generic response instead of crashing (I/O matrix: "Oversized
  // request body"). A rejected CORS origin (CorsOriginError, status 403) is
  // distinguished from an actual server failure (500).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express requires 4-arg signature to register an error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      (err as { status?: number; statusCode?: number } | undefined)?.status ??
      (err as { statusCode?: number } | undefined)?.statusCode ??
      500;
    const message = status === 500 ? 'Internal server error' : status === 403 ? 'Forbidden' : 'Bad request';
    res.status(status).json({ error: message });
  });

  return app;
}
