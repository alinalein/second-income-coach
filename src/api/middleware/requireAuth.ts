import type { NextFunction, Request, Response } from 'express';

/**
 * Session auth-gate (Intent: "an auth gate on every non-health route").
 *
 * I/O matrix: "Unauthenticated API call" -> "401 before the route handler
 * runs" / "No capability leaked" — this responds directly, before `next()` is
 * ever called, so no downstream handler logic (including any DB access) runs
 * for a missing or invalid session.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
