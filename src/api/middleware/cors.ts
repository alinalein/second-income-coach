import cors from 'cors';
import type { Env } from '../../config/env.js';

/**
 * Same-origin CORS (AD-30): deny-by-default, allowlisting only the
 * configured frontend origin (the Vite dev proxy locally; the single
 * same-origin Express service in production) — never a wildcard.
 */
export function createCorsMiddleware(env: Pick<Env, 'CORS_ORIGIN'>) {
  const allowedOrigins = new Set([env.CORS_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173']);

  return cors({
    origin(origin, callback) {
      // No Origin header (e.g. same-origin requests, curl, server-to-server) is allowed through;
      // any browser cross-origin request must match the allowlist exactly.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
  });
}
