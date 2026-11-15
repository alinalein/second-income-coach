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

function fakeDb() {
  return { execute: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) } as unknown as AppDb;
}

type AppDb = Parameters<typeof createApp>[0]['db'];

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

  // AC: same-origin CORS — a disallowed browser origin is rejected.
  it('rejects a request from a disallowed CORS origin', async () => {
    const app = createApp({ env: testEnv(), db: fakeDb() });

    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(500);
  });
});
