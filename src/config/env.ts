import { z } from 'zod';

/**
 * Required/validated environment configuration for the Express backend.
 *
 * I/O matrix row: "Fresh checkout, missing env" — when a required variable is
 * missing or malformed, `loadEnv()` throws a single clear, readable error
 * naming exactly which variable(s) are the problem, and the process exits
 * instead of crashing silently or hanging on a broken connection later.
 */
const DATABASE_URL_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

// Matches the byte-size strings accepted by body-parser's `bytes` dependency,
// e.g. "100kb", "1mb", "512b", "2.5gb", or a bare number of bytes like "1024".
const BODY_LIMIT_PATTERN = /^\d+(\.\d+)?\s?(b|kb|mb|gb|tb)?$/i;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required (see .env.example)' })
    .min(1, 'DATABASE_URL is required (see .env.example)')
    .refine(
      (value) => {
        try {
          return DATABASE_URL_PROTOCOLS.has(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { error: 'DATABASE_URL must be a valid postgres:// connection string' },
    ),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  BODY_LIMIT: z
    .string()
    .min(1)
    .regex(BODY_LIMIT_PATTERN, 'BODY_LIMIT must be a byte-size string, e.g. "100kb" or "1mb"')
    .default('100kb'),
  // Story 1.2: Google OAuth 2.0 (authorization-code flow) + server-side session.
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required (see .env.example)'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required (see .env.example)'),
  GOOGLE_REDIRECT_URI: z.url('GOOGLE_REDIRECT_URI is required and must be a valid URL (see .env.example)'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET is required and must be at least 32 characters (see .env.example)'),
  // Lets a parallel worktree (scripts/new-lane.sh) give its session cookie a
  // distinct name, since cookies are scoped by domain, not port, and two
  // lanes sharing `localhost` in one browser would otherwise clobber each
  // other's session cookie.
  SESSION_COOKIE_NAME: z.string().min(1).default('sic.sid'),
  // Story 1.3: core agent loop (model provider), Mistral Moderation 2, and
  // LangSmith observability. `LANGSMITH_TRACING`/`LANGSMITH_API_KEY`/
  // `LANGSMITH_PROJECT` are read directly off `process.env` by LangChain's
  // own tracing integration (Intent: "no bespoke per-call tracing code") --
  // validated here only so a missing/misconfigured one fails fast and by name
  // at startup, same as every other required var.
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required (see .env.example)'),
  MISTRAL_API_KEY: z.string().min(1, 'MISTRAL_API_KEY is required (see .env.example)'),
  LANGSMITH_TRACING: z.enum(['true', 'false'], {
    error: 'LANGSMITH_TRACING is required and must be "true" or "false" (see .env.example)',
  }),
  LANGSMITH_API_KEY: z.string().min(1, 'LANGSMITH_API_KEY is required (see .env.example)'),
  LANGSMITH_PROJECT: z.string().min(1, 'LANGSMITH_PROJECT is required (see .env.example)'),
  // Story 2.2: the `web_search` MCP tool's provider (Tavily). No degraded
  // mode exists for this capability (Boundary) — unlike AD-20's optional
  // registry providers, this is required at startup like every other key.
  TAVILY_API_KEY: z.string().min(1, 'TAVILY_API_KEY is required (see .env.example)'),
  // Story 2.2: how many ideas `generate_ideas` produces per batch. Bounded
  // 1-5 (same bounded-int precedent as RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS
  // above) — the UI/evaluation logic only ever expects a batch in this
  // range. Defaults to 2.
  IDEAS_PER_BATCH: z.coerce.number().int().min(1).max(5).default(2),
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
