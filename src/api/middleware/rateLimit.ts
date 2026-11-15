import rateLimit, { type Options } from 'express-rate-limit';
import type { Env } from '../../config/env.js';

/**
 * General-tier rate limiter, applied to every route (AD-30).
 */
export function createGeneralRateLimiter(env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX'>) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/**
 * Stricter-tier factory for the LLM-backed, cost-bearing tools
 * (`generate_ideas` / `create_plan`) introduced in Epic 2/3. No route uses
 * this yet in Story 1.1 — only the mechanism is established here so later
 * stories apply it without inventing a second rate-limit pattern.
 */
export function createStrictRateLimiter(
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS'>,
  overrides: Partial<Options> = {},
) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    ...overrides,
  });
}
