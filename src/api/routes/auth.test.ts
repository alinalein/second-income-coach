import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { authSessionSchema } from '@app/shared';
import { createAuthRouter, type AuthOAuthClient } from './auth.js';
import { createDb } from '../../db/client.js';
import { users, userSettings } from '../../db/schema/index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach';

const testEnv = {
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:5173/api/auth/google/callback',
  CORS_ORIGIN: 'http://localhost:5173',
};

type AppDb = Parameters<typeof createAuthRouter>[0]['db'];

/** A minimal app (plain in-memory express-session, not connect-pg-simple) —
 * this file tests the auth route's own request-handling logic, not the
 * session-store wiring already covered in session.test.ts/app.test.ts. */
function buildTestApp(db: AppDb, oauthClient: AuthOAuthClient) {
  const app = express();
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/auth', createAuthRouter({ env: testEnv, db, oauthClient }));
  return app;
}

function fakeOauthClient(overrides: Partial<AuthOAuthClient> = {}): AuthOAuthClient {
  return {
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock=1'),
    getToken: vi.fn(),
    verifyIdToken: vi.fn(),
    ...overrides,
  } as unknown as AuthOAuthClient;
}

function fakeDb() {
  return {} as unknown as AppDb;
}

describe('createAuthRouter /google/callback', () => {
  // I/O matrix: "Google OAuth failure/denial" -> "Redirect to sign-in view
  // with a neutral error" / "No stack trace or secret leaked".
  it('redirects to /?auth_error=1 when Google reports an error', async () => {
    const app = buildTestApp(fakeDb(), fakeOauthClient());

    const res = await request(app).get('/api/auth/google/callback?error=access_denied');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same I/O matrix row — an OAuth `state` that doesn't match the one this
  // server issued (missing/forged) is rejected the same neutral way.
  it('redirects to /?auth_error=1 when the callback state does not match the session', async () => {
    const app = buildTestApp(fakeDb(), fakeOauthClient());
    const agent = request.agent(app);
    await agent.get('/api/auth/google');

    const res = await agent.get('/api/auth/google/callback?code=some-code&state=forged-state');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // AC: "sign-in + backfill rows" / I/O matrix: "First-ever sign-in" ->
  // "users + user_settings rows created transactionally; session cookie set;
  // authenticated view renders" — exercised through the full route (state
  // round-trip, token exchange, ID-token verification, DB upsert, session
  // set), with a fake OAuth client (no real Google call) against real Postgres.
  it('creates user+settings rows, sets the session, and redirects home on a valid callback', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    const { db, pool } = createDb({ DATABASE_URL });

    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: googleId, email, email_verified: true, name: 'Test User', picture: null }),
      }),
    });

    const app = buildTestApp(db, oauthClient);
    const agent = request.agent(app);

    await agent.get('/api/auth/google');
    const generateAuthUrlMock = oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>;
    const issuedState = (generateAuthUrlMock.mock.calls[0]?.[0] as { state: string }).state;

    try {
      const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/`);
      expect(res.headers['set-cookie']).toBeDefined();

      const [userRow] = await db.select().from(users).where(eq(users.googleId, googleId));
      expect(userRow).toBeDefined();
      const [settingsRow] = await db.select().from(userSettings).where(eq(userSettings.userId, userRow!.id));
      expect(settingsRow).toBeDefined();

      // AC: "authenticated view renders" — GET /session's success path,
      // signed in via the callback above, returns the user matching the
      // shared schema the frontend's useAuthStatus() hook parses.
      const sessionRes = await agent.get('/api/auth/session');
      expect(sessionRes.status).toBe(200);
      const parsed = authSessionSchema.safeParse(sessionRes.body);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.user).toMatchObject({ id: userRow!.id, email, name: 'Test User' });
    } finally {
      const [userRow] = await db.select().from(users).where(eq(users.googleId, googleId));
      if (userRow) {
        await db.delete(userSettings).where(eq(userSettings.userId, userRow.id));
        await db.delete(users).where(eq(users.id, userRow.id));
      }
      await pool.end();
    }
  });

  // I/O matrix: "Google OAuth failure/denial" — the token exchange itself
  // failing (network error, invalid code) is caught and redirected neutrally,
  // never thrown.
  it('redirects to /?auth_error=1 when the token exchange rejects', async () => {
    const oauthClient = fakeOauthClient({ getToken: vi.fn().mockRejectedValue(new Error('exchange failed')) });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same row — ID-token verification rejecting (bad signature/audience).
  it('redirects to /?auth_error=1 when ID-token verification rejects', async () => {
    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockRejectedValue(new Error('invalid token')),
    });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same row — a token exchange that resolves without an id_token.
  it('redirects to /?auth_error=1 when the token response has no id_token', async () => {
    const oauthClient = fakeOauthClient({ getToken: vi.fn().mockResolvedValue({ tokens: {}, res: null }) });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same row — a verified payload missing `sub`.
  it('redirects to /?auth_error=1 when the verified payload has no sub', async () => {
    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({ email: 'a@example.com', email_verified: true }),
      }),
    });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same row — a verified payload missing `email`.
  it('redirects to /?auth_error=1 when the verified payload has no email', async () => {
    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: 'some-sub', email_verified: true }),
      }),
    });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });

  // Same row — an unverified email is rejected the same neutral way as any
  // other invalid payload, never used to create/match a user.
  it('redirects to /?auth_error=1 when the verified payload has email_verified: false', async () => {
    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: 'some-sub', email: 'a@example.com', email_verified: false }),
      }),
    });
    const app = buildTestApp(fakeDb(), oauthClient);
    const agent = request.agent(app);
    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    const res = await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${testEnv.CORS_ORIGIN}/?auth_error=1`);
  });
});

describe('createAuthRouter /logout', () => {
  // POST /api/auth/logout had zero coverage — signs in via the same fake-OAuth
  // fixture, logs out, and confirms both the cookie and the session are gone.
  it('signs out: 204 + cleared cookie, and a follow-up /session then 401s', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    const { db, pool } = createDb({ DATABASE_URL });

    const oauthClient = fakeOauthClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'fake-id-token' }, res: null }),
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: googleId, email, email_verified: true, name: 'Test User', picture: null }),
      }),
    });

    const app = buildTestApp(db, oauthClient);
    const agent = request.agent(app);

    await agent.get('/api/auth/google');
    const issuedState = (oauthClient.generateAuthUrl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].state;

    try {
      await agent.get(`/api/auth/google/callback?code=test-code&state=${issuedState}`);

      const logoutRes = await agent.post('/api/auth/logout');
      expect(logoutRes.status).toBe(204);
      const clearedCookie = (logoutRes.headers['set-cookie'] as string[] | undefined)?.find((c) =>
        c.startsWith('sic.sid='),
      );
      expect(clearedCookie).toBeDefined();
      expect(clearedCookie).toMatch(/sic\.sid=;/);

      const sessionRes = await agent.get('/api/auth/session');
      expect(sessionRes.status).toBe(401);
    } finally {
      const [userRow] = await db.select().from(users).where(eq(users.googleId, googleId));
      if (userRow) {
        await db.delete(userSettings).where(eq(userSettings.userId, userRow.id));
        await db.delete(users).where(eq(users.id, userRow.id));
      }
      await pool.end();
    }
  });
});
