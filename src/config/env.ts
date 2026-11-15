import { z } from 'zod';

/**
 * Required/validated environment configuration for the Express backend.
 *
 * I/O matrix row: "Fresh checkout, missing env" — when a required variable is
 * missing or malformed, `loadEnv()` throws a single clear, readable error
 * naming exactly which variable(s) are the problem, and the process exits
 * instead of crashing silently or hanging on a broken connection later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required (see .env.example)' })
    .min(1, 'DATABASE_URL is required (see .env.example)'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  BODY_LIMIT: z.string().min(1).default('100kb'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid or missing environment variables:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses and validates `process.env`. Throws `EnvValidationError` — naming
 * every offending variable — rather than returning a partially-valid object.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  return result.data;
}
