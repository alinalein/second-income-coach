import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

// I/O matrix: "Fresh checkout, missing env" -> "Clear error naming the missing
// required env var(s)" / "No silent crash or hang".
describe('loadEnv (I/O matrix: fresh checkout, missing env)', () => {
  it('throws EnvValidationError naming DATABASE_URL when it is missing', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);

    try {
      loadEnv({});
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.join('\n')).toContain('DATABASE_URL');
    }
  });

  const requiredStory12Vars = {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
    SESSION_SECRET: 'session-secret-at-least-32-characters-long',
  };

  const requiredStory13Vars = {
    OPENROUTER_API_KEY: 'openrouter-key',
    MISTRAL_API_KEY: 'mistral-key',
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: 'langsmith-key',
    LANGSMITH_PROJECT: 'test-project',
  };

  const requiredStory22Vars = {
    TAVILY_API_KEY: 'tavily-key',
  };

  it('applies defaults and succeeds when only the required vars are present', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      ...requiredStory12Vars,
      ...requiredStory13Vars,
      ...requiredStory22Vars,
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.BODY_LIMIT).toBe('100kb');
    // Story 2.11 AC4/AC7: "live" is the default in production/the demo;
    // the two daily limits default generous enough that dev never hits them.
    expect(env.WEB_SEARCH_MODE).toBe('live');
    expect(env.DAILY_SEARCH_BUDGET).toBe(500);
    expect(env.DAILY_GENERATIONS_PER_USER).toBe(50);
    // Story 2.11 follow-up: empty by default -> nobody exempt.
    expect(env.UNLIMITED_USER_EMAILS).toBe('');
  });

  // Story 2.11 AC4: "the mode is one env variable documented in
  // .env.example, validated at startup" (CLAUDE.md).
  it('rejects a WEB_SEARCH_MODE value that is neither "live" nor "stub"', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        ...requiredStory12Vars,
        ...requiredStory13Vars,
        ...requiredStory22Vars,
        WEB_SEARCH_MODE: 'turbo',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a non-numeric PORT with a clear issue', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        ...requiredStory12Vars,
        PORT: 'not-a-number',
      }),
    ).toThrow(EnvValidationError);
  });

  // CLAUDE.md external-service rule: every story that introduces an external
  // service adds its variable to the startup validation, and missing it fails
  // the same clear, named-variable way as any other required var.
  it('throws EnvValidationError naming the Story 1.2 Google OAuth/session vars when missing', () => {
    try {
      loadEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('GOOGLE_CLIENT_ID');
      expect(issues).toContain('GOOGLE_CLIENT_SECRET');
      expect(issues).toContain('GOOGLE_REDIRECT_URI');
      expect(issues).toContain('SESSION_SECRET');
    }
  });

  // AC: "Given this story's env vars, when the backend starts without one
  // configured, then src/config/env.ts fails fast, naming exactly which
  // variable is missing" (spec-1-3) — same external-service rule as above,
  // for the model/moderation/observability vars this story adds.
  it('throws EnvValidationError naming the Story 1.3 model/moderation/observability vars when missing', () => {
    try {
      loadEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db', ...requiredStory12Vars });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('OPENROUTER_API_KEY');
      expect(issues).toContain('MISTRAL_API_KEY');
      expect(issues).toContain('LANGSMITH_TRACING');
      expect(issues).toContain('LANGSMITH_API_KEY');
      expect(issues).toContain('LANGSMITH_PROJECT');
    }
  });

  // Story 2.2 (CLAUDE.md external-service rule / Boundary: "TAVILY_API_KEY
  // is required at startup — no degraded mode exists for this capability").
  it('throws EnvValidationError naming TAVILY_API_KEY when missing', () => {
    try {
      loadEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        ...requiredStory12Vars,
        ...requiredStory13Vars,
      });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.join('\n')).toContain('TAVILY_API_KEY');
    }
  });
});
