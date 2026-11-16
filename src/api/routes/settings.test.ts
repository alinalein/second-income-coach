import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createSettingsRouter, type SettingsRouterDeps } from './settings.js';
import { DEFAULT_MODEL_ID } from '../../agent/registry.js';
import { MODERATION_MODEL_NAME } from '../../agent/moderation.js';

const CONFIGURED_ENV: SettingsRouterDeps['env'] = { OPENROUTER_API_KEY: 'key', MISTRAL_API_KEY: 'key' };

/** Just enough of Drizzle's chainable `select().from().where().limit()` for
 * `getUserSettings` to resolve — no real Postgres needed, since this story
 * introduces no new DB constraint to verify (CLAUDE.md: a real-Postgres
 * integration test is reserved for those). */
function fakeDb(
  row: { personality: string; model: string | null; uiLanguage?: string } | undefined,
): SettingsRouterDeps['db'] {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as never;
}

function buildTestApp(db: SettingsRouterDeps['db'], userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/settings', createSettingsRouter({ env: CONFIGURED_ENV, db }));
  return app;
}

// AC: "pricing ... is read from the registry, never a hardcoded value" /
// "moderation/transcription models never appear as options" / "an unknown
// or no-longer-selectable id resolves to the default model rather than
// erroring" / settings "surfaced through an actual settings screen".
describe('createSettingsRouter GET /', () => {
  it('resolves a stale stored model id to the default and lists registry-sourced selectable models, excluding moderation', async () => {
    const app = buildTestApp(fakeDb({ personality: 'terse', model: 'not-a-real-model', uiLanguage: 'German' }));

    const res = await request(app).get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.body.personality).toBe('terse');
    expect(res.body.model).toBe(DEFAULT_MODEL_ID);
    expect(res.body.uiLanguage).toBe('German');

    const ids = res.body.selectableModels.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([DEFAULT_MODEL_ID, 'google/gemini-3.8-flash', 'anthropic/claude-haiku-4.5']),
    );
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(MODERATION_MODEL_NAME);
    // Removed from the registry (too slow in production, or superseded), or
    // an eval-only/judge model that must never be user-selectable (evals.md,
    // Epic 6) — none of these may appear here.
    expect(ids).not.toContain('anthropic/claude-sonnet-5');
    expect(ids).not.toContain('mistralai/mistral-large-4-0');
    expect(ids).not.toContain('anthropic/claude-sonnet-5.5');
    expect(ids).not.toContain('deepseek/deepseek-v4.1-flash');

    const defaultEntry = res.body.selectableModels.find((entry: { id: string }) => entry.id === DEFAULT_MODEL_ID);
    expect(defaultEntry).toMatchObject({
      pricePerMillionInputTokens: expect.any(Number),
      pricePerMillionOutputTokens: expect.any(Number),
      priceAsOf: expect.any(String),
    });
  });

  // AC2: "a first-time visit with no stored preference -> defaults to
  // English" — never browser-detected (AD-20).
  it('defaults uiLanguage to English when the user has no settings row', async () => {
    const app = buildTestApp(fakeDb(undefined));

    const res = await request(app).get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.body.uiLanguage).toBe('English');
  });
});

// AC: validation boundary — a malformed body never reaches the plain write.
describe('createSettingsRouter POST /personality', () => {
  it('rejects an invalid personality value with 400', async () => {
    const app = buildTestApp(fakeDb({ personality: 'friendly', model: null }));

    const res = await request(app).post('/api/settings/personality').send({ personality: 'sarcastic' });

    expect(res.status).toBe(400);
  });
});

// AC1/validation boundary — a malformed body never reaches the plain write.
describe('createSettingsRouter POST /ui-language', () => {
  it('rejects an invalid UI language value with 400', async () => {
    const app = buildTestApp(fakeDb({ personality: 'friendly', model: null }));

    const res = await request(app).post('/api/settings/ui-language').send({ uiLanguage: 'French' });

    expect(res.status).toBe(400);
  });
});
