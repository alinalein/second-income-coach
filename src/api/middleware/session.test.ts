import { describe, expect, it } from 'vitest';
import { buildSessionCookieOptions } from './session.js';

// Intent: "a Postgres-backed HttpOnly/Secure/SameSite=Lax session cookie" —
// asserts the exact cookie attribute contract without exercising the rest of
// express-session/connect-pg-simple (framework behaviour we don't re-test).
describe('buildSessionCookieOptions (AD: HttpOnly/Secure/SameSite=Lax session cookie)', () => {
  it('is HttpOnly and SameSite=Lax regardless of environment', () => {
    const options = buildSessionCookieOptions({ NODE_ENV: 'development' });

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('is Secure in production', () => {
    const options = buildSessionCookieOptions({ NODE_ENV: 'production' });

    expect(options.secure).toBe(true);
  });

  it('is not Secure outside production, so the cookie still works over local-dev HTTP', () => {
    const options = buildSessionCookieOptions({ NODE_ENV: 'development' });

    expect(options.secure).toBe(false);
  });
});
