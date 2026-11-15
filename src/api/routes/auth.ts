import { randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { authSessionSchema } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import { upsertUserAndSettings } from '../../db/auth-repository.js';
import { users } from '../../db/schema/index.js';
import { requireAuth } from '../middleware/requireAuth.js';

/** The slice of `OAuth2Client` this router uses — narrowed so tests can inject
 * a fake instead of hitting Google's real OAuth endpoints. */
export type AuthOAuthClient = Pick<OAuth2Client, 'generateAuthUrl' | 'getToken' | 'verifyIdToken'>;

export interface AuthRouterDeps {
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_REDIRECT_URI' | 'CORS_ORIGIN'>;
  db: ReturnType<typeof createDb>['db'];
  /** Defaults to a real `OAuth2Client`; tests inject a fake (same factory/DI
   * pattern as `createApp`'s injected `db`). */
  oauthClient?: AuthOAuthClient;
}

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

/**
 * Redirects a failed/denied OAuth attempt to a neutral, no-detail error on
 * the sign-in view (Design Notes: "Callback failure") — never a thrown error
 * with a stack trace, and never a reason specific enough to leak anything
 * about why it failed (I/O matrix: "Google OAuth failure/denial").
 */
function redirectToSignInError(res: Response, appOrigin: string) {
  res.redirect(`${appOrigin}/?auth_error=1`);
}

/**
 * `GET /google`, `GET /google/callback`, `GET /session`, `POST /logout`
 * (Code Map). The consent redirect and the callback are deliberately NOT
 * behind `requireAuth` — they are how a user becomes authenticated in the
 * first place; `session` and `logout` are, since both need an existing
 * session to mean anything.
 */
export function createAuthRouter({ env, db, oauthClient: injectedOauthClient }: AuthRouterDeps) {
  const router = Router();
  // Where the browser lands after the OAuth round-trip. The callback arrives on the API's own
  // origin, which in local dev is not the frontend's (Vite on 5173 vs API on 3000), so a bare
  // '/' would hit the API. In production both share one origin and CORS_ORIGIN is that origin.
  const appOrigin = env.CORS_ORIGIN.replace(/\/+$/, '');
  const oauthClient =
    injectedOauthClient ??
    new OAuth2Client({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
    });

  router.get('/google', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = oauthClient.generateAuthUrl({
      access_type: 'online',
      scope: GOOGLE_SCOPES,
      state,
    });
    res.redirect(url);
  });

  router.get('/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (error || typeof code !== 'string' || typeof state !== 'string' || !expectedState || state !== expectedState) {
      redirectToSignInError(res, appOrigin);
      return;
    }

    try {
      const { tokens } = await oauthClient.getToken(code);
      const idToken = tokens.id_token;
      if (!idToken) {
        redirectToSignInError(res, appOrigin);
        return;
      }

      const ticket = await oauthClient.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || !payload.email_verified) {
        redirectToSignInError(res, appOrigin);
        return;
      }

      const user = await upsertUserAndSettings(db, {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name ?? payload.email,
        picture: payload.picture ?? null,
      });

      req.session.regenerate((regenerateError) => {
        if (regenerateError) {
          console.error('[auth] session regenerate failed:', regenerateError);
          redirectToSignInError(res, appOrigin);
          return;
        }
        req.session.userId = user.id;
        res.redirect(`${appOrigin}/`);
      });
    } catch (callbackError) {
      console.error('[auth] google callback failed:', callbackError);
      redirectToSignInError(res, appOrigin);
    }
  });

  // AC: "authenticated view renders" — the frontend's useAuthStatus() hook
  // calls this to decide which view to show. Gated by requireAuth: no
  // session -> 401, which the hook treats as "signed out" (I/O matrix:
  // "Unauthenticated API call" -> 401 before any handler logic runs).
  router.get('/session', requireAuth, async (req, res) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId!)).limit(1);

    if (!user) {
      // Session points at a user row that no longer exists — treat as signed
      // out rather than leaking a 500, and clear the stale session.
      req.session.destroy((destroyError) => {
        if (destroyError) {
          console.error('[auth] session destroy failed:', destroyError);
        }
      });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = authSessionSchema.parse({
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    });
    res.json(payload);
  });

  router.post('/logout', requireAuth, (req, res) => {
    req.session.destroy((destroyError) => {
      if (destroyError) {
        console.error('[auth] session destroy failed:', destroyError);
      }
      res.clearCookie('sic.sid');
      res.status(204).end();
    });
  });

  return router;
}
