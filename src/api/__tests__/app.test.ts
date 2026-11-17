import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../app.js';
import type { Env } from '../../config/env.js';

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    CORS_ORIGIN: 'http://localhost:5173',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 100,
    BODY_LIMIT: '1kb',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters',
    SESSION_COOKIE_NAME: 'sic.sid',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    MISTRAL_API_KEY: 'test-mistral-key',
    LANGSMITH_TRACING: 'false',
    LANGSMITH_API_KEY: 'test-langsmith-key',
    LANGSMITH_PROJECT: 'test-project',
    TAVILY_API_KEY: 'test-tavily-key',
    IDEAS_PER_BATCH: 5,
    ...overrides,
  };
}

type AppDb = Parameters<typeof createApp>[0]['db'];
type AppAgent = Parameters<typeof createApp>[0]['agent'];

function fakeDb(execute: AppDb['execute'] = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] })) {
  return { execute } as unknown as AppDb;
}

// No test in this file authenticates, so the session store (connect-pg-simple)
// never actually issues a query against this pool — express-session only
// touches the store for a request carrying a valid signed session cookie.
function fakePool() {
  return { query: vi.fn(), on: vi.fn() } as unknown as Pool;
}

// None of this file's tests reach the chat router (all gated behind
// requireAuth, which every test here hits unauthenticated) — a minimal fake
// is enough; `src/api/routes/chat.test.ts` covers the router's own behavior.
function fakeAgent() {
  return { invoke: vi.fn(), getState: vi.fn() } as unknown as AppAgent;
}

type AppChatModel = Parameters<typeof createApp>[0]['chatModel'];
type AppWebSearchTool = Parameters<typeof createApp>[0]['webSearchTool'];

// Story 2.10: `AppDeps` gained `chatModel`/`webSearchTool` (threaded into
// the ideas/plans routes' direct `handleGenerateIdeas`/`handleCreatePlan`
// calls) — no test in this file reaches either path (all gated behind
// `requireAuth`, which every test here hits unauthenticated), so never-
// called stubs are enough.
function fakeChatModel() {
  return {} as unknown as AppChatModel;
}

function fakeWebSearchTool() {
  return {} as unknown as AppWebSearchTool;
}

describe('createApp', () => {
  // AC: "the Express backend ... both start successfully with TypeScript,
  // Zod, and the shared schema package wired" — /api/health responds using
  // the shared healthStatusSchema.
  it('GET /api/health returns an ok status built from the shared schema', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'ok', service: 'api' }));
  });

  // AC: "the Express app, when it starts, then helmet, same-origin cors,
  // express-rate-limit, and a body-size limit are all active" (helmet slice).
  it('sets baseline security headers via helmet', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // I/O matrix: "Oversized request body" -> "Request rejected before the
  // route handler runs" / "Generic error response, process stays up".
  it('rejects an oversized request body with a generic error, before any route handler runs', async () => {
    const app = createApp({ env: testEnv({ BODY_LIMIT: '10b' }), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send({ payload: 'x'.repeat(1000) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Bad request' });
  });

  // AC: same-origin CORS — a disallowed browser origin is rejected as a 403
  // (client policy rejection), not conflated with a 500 server failure.
  it('rejects a request from a disallowed CORS origin with 403', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  // AC: same-origin CORS — the allow branch (an origin matching CORS_ORIGIN)
  // is let through, with the matching Access-Control-Allow-Origin header.
  it('allows a request from the configured CORS_ORIGIN', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  // AC: "express-rate-limit ... active" — a request beyond the configured
  // window limit is rejected with 429.
  it('returns 429 once the general rate limit is exceeded', async () => {
    const app = createApp({ env: testEnv({ RATE_LIMIT_MAX: 1 }), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  // AC: "the Postgres access layer, when configured, then it connects
  // through Drizzle ORM" — /api/health/db success branch.
  it('GET /api/health/db returns ok when the db check succeeds', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

    const res = await request(app).get('/api/health/db');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'ok', service: 'db' }));
  });

  // Same route's error branch — a failing db check must not crash the
  // process and must report a 503/error status.
  it('GET /api/health/db returns 503/error when the db check fails', async () => {
    const app = createApp({
      env: testEnv(),
      db: fakeDb(vi.fn().mockRejectedValue(new Error('connection refused'))),
      pool: fakePool(),
      agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool(),
    });

    const res = await request(app).get('/api/health/db');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ status: 'error', service: 'db' }));
  });

  // AC: "the Express app, when any route other than /api/health* is hit
  // without a valid session, then it responds 401 before any handler logic
  // runs." — exercised against both an existing gated route (auth/session)
  // and a route that doesn't exist at all, proving the gate is a blanket
  // fallback, not a per-route allowlist.
  describe('auth gate (AC: 401 before any handler logic runs)', () => {
    it('rejects an unauthenticated request to a gated auth route with 401', async () => {
      const db = fakeDb();
      const app = createApp({ env: testEnv(), db, pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

      const res = await request(app).get('/api/auth/session');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
      // No handler logic ran: the gate short-circuited before any DB lookup.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated request to an undefined route with 401, not 404', async () => {
      const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

      const res = await request(app).get('/api/does-not-exist');

      expect(res.status).toBe(401);
    });

    it('does not gate /api/health or /api/health/db', async () => {
      const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

      const health = await request(app).get('/api/health');
      const healthDb = await request(app).get('/api/health/db');

      expect(health.status).toBe(200);
      expect(healthDb.status).toBe(200);
    });

    it('does not gate the public Google OAuth entry points', async () => {
      const app = createApp({ env: testEnv(), db: fakeDb(), pool: fakePool(), agent: fakeAgent(), ideasAgent: fakeAgent(), plansAgent: fakeAgent(), chatModel: fakeChatModel(), webSearchTool: fakeWebSearchTool() });

      const res = await request(app).get('/api/auth/google');

      // A redirect to Google's consent screen (302), never a 401 — these
      // routes are how a session is established in the first place.
      expect(res.status).toBe(302);
    });
  });
});
