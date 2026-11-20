import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createEvaluationRouter } from './evaluation.js';
import { requireAuth } from '../middleware/requireAuth.js';

const SESSION_USER_ID = 'evaluation-test-session-user-id';

function buildTestApp(authenticated: boolean) {
  const app = express();
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = SESSION_USER_ID;
      next();
    });
  }
  // Same gate every other route sits behind in `app.ts` — exercised here
  // directly (not bypassed) since this story's own AC is about this gate.
  app.use(requireAuth);
  app.use('/api/evaluation', createEvaluationRouter());
  return app;
}

// AC: "a dedicated test confirms it contains no user-specific data, no
// secrets, and no private LangSmith trace links - verified, not just
// asserted" (AD-28). Reads the real, committed sources (no path overrides)
// so this proves the actual shipped payload, not a fixture.
describe('createEvaluationRouter GET / (AC: no user data, secrets or LangSmith links)', () => {
  it.each([
    ['the signed-in session user id', SESSION_USER_ID],
    ['a LangSmith trace link', /smith\.langchain\.com/i],
    ['an email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ])('the payload never contains %s', async (_label, forbidden) => {
    const app = buildTestApp(true);

    const res = await request(app).get('/api/evaluation');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(forbidden);
  });
});

// AC: "/evaluation and its data endpoint require a signed-in session like
// every other route (AD-28, no exception)".
describe('createEvaluationRouter GET / (AC: AD-28, same auth as every other route)', () => {
  it('rejects a signed-out request with 401', async () => {
    const app = buildTestApp(false);

    const res = await request(app).get('/api/evaluation');

    expect(res.status).toBe(401);
  });
});
