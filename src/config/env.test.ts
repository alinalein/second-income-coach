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

  it('applies defaults and succeeds when only the required var is present', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.BODY_LIMIT).toBe('100kb');
  });

  it('rejects a non-numeric PORT with a clear issue', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        PORT: 'not-a-number',
      }),
    ).toThrow(EnvValidationError);
  });
});
