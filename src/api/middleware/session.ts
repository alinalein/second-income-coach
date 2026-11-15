import type { Pool } from 'pg';
import session, { type CookieOptions } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Env } from '../../config/env.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    oauthState?: string;
  }
}

const ROLLING_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — Design Notes: "not specified upstream"

/**
 * Cookie options for the session-id cookie (Intent: "a Postgres-backed
 * HttpOnly/Secure/SameSite=Lax session cookie"). Extracted as a pure function
 * so the shape can be asserted directly without exercising the rest of
 * express-session (AD: session cookie attributes).
 *
 * `secure` is conditioned on `NODE_ENV` (true in production, false otherwise)
 * rather than always-on: a browser silently drops a `Secure` cookie set over
 * plain HTTP, and local dev / CI run the Express API over HTTP. Production
 * (and any TLS-terminating deploy, matching the `trust proxy` setting in
 * app.ts) always gets `Secure: true`.
 */
export function buildSessionCookieOptions(env: Pick<Env, 'NODE_ENV'>): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ROLLING_SESSION_MAX_AGE_MS,
  };
}

/**
 * Postgres-backed session store (Design Notes: "express-session +
 * connect-pg-simple against the existing Postgres instance (no new infra)"),
 * with a rolling 30-day expiry so an active session is extended on each
 * request (AC: "closes and reopens the app within the session's validity,
 * then they remain signed in").
 */
export function createSessionMiddleware(
  env: Pick<Env, 'NODE_ENV' | 'SESSION_SECRET' | 'SESSION_COOKIE_NAME'>,
  pool: Pool,
) {
  const PgSession = connectPgSimple(session);

  return session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: env.SESSION_SECRET,
    name: env.SESSION_COOKIE_NAME,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: buildSessionCookieOptions(env),
  });
}
