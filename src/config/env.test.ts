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

  it('applies defaults and succeeds when only the required vars are present', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      ...requiredStory12Vars,
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.BODY_LIMIT).toBe('100kb');
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
});
