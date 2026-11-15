import cors from 'cors';
import type { Env } from '../../config/env.js';

/** Thrown when an Origin fails the allowlist — carries `.status` so the
 * centralized error handler (app.ts) can resolve it to 403, not a generic 500. */
export class CorsOriginError extends Error {
  readonly status = 403;

  constructor(origin: string) {
    super(`Origin ${origin} is not allowed by CORS policy`);
    this.name = 'CorsOriginError';
  }
}

/**
 * Same-origin CORS (AD-30): deny-by-default, allowlisting only the
 * configured frontend origin (the Vite dev proxy locally; the single
 * same-origin Express service in production) — never a wildcard. The
 * hardcoded local Vite dev origins are only added outside production.
 */
export function createCorsMiddleware(env: Pick<Env, 'CORS_ORIGIN' | 'NODE_ENV'>) {
  const allowedOrigins = new Set([env.CORS_ORIGIN]);
  if (env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }

  return cors({
    origin(origin, callback) {
      // No Origin header (e.g. same-origin requests, curl, server-to-server) is allowed through;
      // any browser cross-origin request must match the allowlist exactly.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new CorsOriginError(origin));
    },
    credentials: true,
  });
}
