import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defense (Intent: "CSRF defense = SameSite=Lax + an Origin-header check
 * on mutations — no separate CSRF-token mechanism"). Only state-changing
 * requests are checked; a `SameSite=Lax` cookie already isn't attached to a
 * cross-site navigation-less request, so this is the second, independent
 * layer named in the Intent, not a replacement for it.
 *
 * I/O matrix: "Cross-origin mutation" -> "Rejected" / "Distinct 4xx, not a
 * generic 500" — responds directly with 403 rather than throwing, same as
 * the explicit status check already used for oversized bodies in app.ts.
 */
export function createRequireSameOrigin(env: Pick<Env, 'CORS_ORIGIN' | 'NODE_ENV'>) {
  const allowedOrigins = new Set([env.CORS_ORIGIN]);
  if (env.NODE_ENV !== 'production') {
    // `5173`/`5183`/`5193` are this story's documented parallel-worktree
    // `WEB_PORT` values (spec-1-2 Spec Change Log) — same list as cors.ts.
    for (const port of ['5173', '5183', '5193']) {
      allowedOrigins.add(`http://localhost:${port}`);
      allowedOrigins.add(`http://127.0.0.1:${port}`);
    }
  }

  return function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
