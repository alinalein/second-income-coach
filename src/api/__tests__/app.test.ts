import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
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
    ...overrides,
  };
}

type AppDb = Parameters<typeof createApp>[0]['db'];

function fakeDb(execute: AppDb['execute'] = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] })) {
  return { execute } as unknown as AppDb;
}

describe('createApp', () => {
  // AC: "the Express backend ... both start successfully with TypeScript,
  // Zod, and the shared schema package wired" — /api/health responds using
  // the shared healthStatusSchema.
  it('GET /api/health returns an ok status built from the shared schema', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb() });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'ok', service: 'api' }));
  });

  // AC: "the Express app, when it starts, then helmet, same-origin cors,
  // express-rate-limit, and a body-size limit are all active" (helmet slice).
  it('sets baseline security headers via helmet', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb() });

    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // I/O matrix: "Oversized request body" -> "Request rejected before the
  // route handler runs" / "Generic error response, process stays up".
  it('rejects an oversized request body with a generic error, before any route handler runs', async () => {
    const app = createApp({ env: testEnv({ BODY_LIMIT: '10b' }), db: fakeDb() });

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
    const app = createApp({ env: testEnv(), db: fakeDb() });

    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  // AC: same-origin CORS — the allow branch (an origin matching CORS_ORIGIN)
  // is let through, with the matching Access-Control-Allow-Origin header.
  it('allows a request from the configured CORS_ORIGIN', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb() });

    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  // AC: "express-rate-limit ... active" — a request beyond the configured
  // window limit is rejected with 429.
  it('returns 429 once the general rate limit is exceeded', async () => {
    const app = createApp({ env: testEnv({ RATE_LIMIT_MAX: 1 }), db: fakeDb() });

    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  // AC: "the Postgres access layer, when configured, then it connects
  // through Drizzle ORM" — /api/health/db success branch.
  it('GET /api/health/db returns ok when the db check succeeds', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb() });

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
    });

    const res = await request(app).get('/api/health/db');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ status: 'error', service: 'db' }));
  });
});
