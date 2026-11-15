---
title: 'Story 1.2: Google Sign-In'
type: 'feature'
created: '2026-11-15'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '7f8e0f07f325924b8b79998192e07c8e9b53c161'
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No auth exists yet; every capability must gate behind a signed-in user, and there is no Postgres `users`/`user_settings` record for anyone to own data against.

**Approach:** Google OAuth 2.0 authorization-code flow via `google-auth-library`, verified server-side; a Postgres-backed `HttpOnly`/`Secure`/`SameSite=Lax` session cookie; transactional `users` + `user_settings` row creation on first sign-in; an auth gate on every non-health route plus an Origin-header CSRF check on mutations.

## Boundaries & Constraints

**Always:**
- Google OAuth (authorization-code flow, `google-auth-library@11.3.3`) is the only sign-in method, verified server-side before any session is created.
- Session is a server-side cookie: `HttpOnly`, `Secure`, `SameSite=Lax` — never a bearer token or anything readable by client JS.
- CSRF defense = `SameSite=Lax` + an Origin-header check on every state-changing request — no separate CSRF-token mechanism.
- Every route other than the existing `/api/health*` is rejected unauthenticated once this story lands.
- `users` + `user_settings` rows created in one DB transaction on first sign-in; `user_settings` holds `currency` ('EUR'), `personality` ('friendly' — decided for Story 1.2), `model` ('use the default model'), `ui_language` ('English') — table/schema created here, never migrated again by later stories (2.2, 4.4, 5.1, 5.2, 5.4, 5.5 only read/extend it).
- An existing user missing a `user_settings` row (pre-dates this story) gets one created with defaults on next sign-in — never a failed or empty sign-in.
- New env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`) go into `.env.example` (placeholders) and `src/config/env.ts`'s required fields.
- Reuse `createApp`'s factory/DI pattern, the existing CORS/rate-limit/body-limit middleware untouched (both already patched in commit a03b300 — don't reintroduce the fixed findings), the single `shared/schemas/index.ts` file, and the `loadEnv`/Drizzle conventions from Story 1.1.

**Never:**
- No settings UI, personality/model switching tools, or model registry (Epic 5) — this story only writes defaults.
- No intake, agent loop, or chat UI (Story 1.3).
- No i18n copy (Story 1.4 retrofits it); sign-in page text may be temporarily hardcoded English.
- No new frontend router — stay with conditional rendering in `App.tsx`, matching the current single-page structure.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First-ever sign-in | New Google identity completes OAuth | `users` + `user_settings` rows created transactionally; session cookie set; authenticated view renders | N/A |
| Returning user, existing settings | Known Google identity signs in | No new rows; existing settings loaded; session set | N/A |
| Returning user, missing settings row | Known Google identity, `user_settings` absent (pre-story data) | Row created with defaults on this sign-in | N/A |
| Unauthenticated API call | Request to any gated route, no/invalid session | 401 before the route handler runs | No capability leaked |
| Cross-origin mutation | State-changing request, mismatched/missing `Origin` | Rejected | Distinct 4xx, not a generic 500 |
| Google OAuth failure/denial | User cancels consent or Google errors | Redirect to sign-in view with a neutral error | No stack trace or secret leaked |

</frozen-after-approval>

## Code Map

- `src/api/app.ts` -- mount `createAuthRouter(...)` under `/api/auth` before the error handler; apply a session auth-gate to all non-health routes.
- `src/api/middleware/` -- new `requireAuth.ts` (401 on missing/invalid session) and `requireSameOrigin.ts` (Origin-header check on mutations); reuse `createCorsMiddleware`/`createGeneralRateLimiter` untouched.
- `src/api/routes/auth.ts` -- new: `GET /google` (redirect to Google consent), `GET /google/callback` (exchange code, verify, upsert user+settings, set session), `POST /logout`.
- `src/config/env.ts` -- add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET` as required `z.string().min(1)`, same pattern as existing fields.
- `.env.example` -- append the four vars as placeholders, same style as existing entries.
- `src/db/schema/` (new, replaces the `src/db/schema.ts` placeholder) -- one file per domain: `users.ts` (`users` table: uuid PK default-random, unique `googleId`, `email`, `name`, `picture`, timestamps) and `userSettings.ts` (`userSettings` table: uuid `userId` unique FK → `users.id`, `currency`, `personality`, `model`, `uiLanguage`, timestamps); `index.ts` re-exports every table for `src/db/client.ts` and `src/drizzle.config.ts` to import.
- `src/drizzle.config.ts` -- point `schema` at `./db/schema` (the folder/index) instead of the old single-file path.
- `src/db/migrations/` -- first real migration via `db:generate`/`db:push` (none exist yet).
- `src/db/client.ts` -- unchanged; reuse `createDb`/pool-error-listener pattern; imports tables from `./schema` (the new index).
- `src/package.json` -- add `google-auth-library@11.3.3`, `express-session`, `connect-pg-simple` (+ `@types`); add a `db:migrate` script that applies the committed migrations under `src/db/migrations/` (e.g. `drizzle-kit migrate`, matching the existing `db:generate`/`db:push` script style).
- `shared/schemas/index.ts` -- add a session/user schema next to `healthStatusSchema`, same single-file pattern.
- `web/src/App.tsx` -- conditional render: unauthenticated → sign-in card (reuse `Button`/`Card`); authenticated → existing shell + sign-out control; add a `useAuthStatus()` hook mirroring `useApiHealth()`.
- `web/vite.config.ts` -- dev server `port` and the `/api` proxy's `target` read from env instead of hardcoded, defaulting to `5173`/`http://localhost:3000` when unset, so a parallel worktree can run its own frontend+backend pair on different ports without editing source.
- `.env.example` -- also document the two new dev-only vars (optional, code-defaulted — not added to `src/config/env.ts`'s required startup validation, since they only configure the Vite dev server, not the backend).

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema/` (`users.ts`, `userSettings.ts`, `index.ts`) -- define `users`/`user_settings` as per-domain files -- AC: transactional creation
- [x] `src/drizzle.config.ts` -- point `schema` at `./db/schema` -- `db:generate` still picks up both tables after the split
- [x] `src/db/migrations/` -- generate the first migration -- AC: transactional creation
- [x] `src/package.json` -- add `db:migrate` script -- applies committed migrations
- [x] `src/config/env.ts` + `.env.example` -- four new required auth vars -- CLAUDE.md external-service rule
- [x] `src/api/routes/auth.ts` -- OAuth redirect/callback/logout, transactional upsert + settings backfill -- AC: sign-in + backfill rows
- [x] `src/api/middleware/requireAuth.ts` -- gate all non-health routes -- AC: unauthenticated rejection
- [x] `src/api/middleware/requireSameOrigin.ts` -- Origin-header check on mutations -- AC: CSRF defense
- [x] `shared/schemas/index.ts` -- session/user schema -- consumed by both sides
- [x] `web/src/App.tsx` + `useAuthStatus()` -- sign-in/out UI, conditional render -- AC: authenticated view
- [x] `web/vite.config.ts` + `.env.example` -- dev port + proxy target from env, defaults `5173`/`http://localhost:3000`
- [x] Tests for each I/O-matrix row and the ACs below (vitest + supertest, colocated, each comment citing its AC)

**Acceptance Criteria:**
- Given an authenticated session, when the user closes and reopens the app within the session's validity, then they remain signed in without re-authenticating.
- Given the Express app, when any route other than `/api/health*` is hit without a valid session, then it responds 401 before any handler logic runs.
- Given the `src/db/schema/` split, when `db:generate` runs, then the generated migration is identical in effect to generating from a single-file schema (no table/column dropped or altered by the refactor).
- Given `WEB_PORT`/`API_PROXY_TARGET` are unset, when the Vite dev server starts, then it behaves exactly as before the change (port `5173`, proxy target `http://localhost:3000`).

## Implementation Notes

- Implemented via a dispatched subagent (initial dispatch + a mid-build amendment message incorporating the four schema/db:migrate/dev-port items). Verified independently against the diff since `baseline_commit`, not just the subagent's report: all 12 execution tasks present, both standalone ACs satisfied, and all 6 I/O-matrix rows covered by a passing test (`npm test`: 41 passed across shared/src/web). `npm run typecheck`, `npm run lint`, `npm run build` all clean. `db:generate` after the schema-folder split reported no SQL changes (confirms the split is a pure reorg); `db:push` and the new `db:migrate` both applied the migration cleanly against Compose Postgres; `auth-repository.test.ts` is the one real-Postgres integration test (CLAUDE.md), covering all three upsert branches (new user, returning user, backfill).
- CORS/CSRF dev-origin allowlists (`cors.ts` from Story 1.1, and this story's new `requireSameOrigin.ts`) still hardcode only `localhost:5173`/`127.0.0.1:5173` as dev fallbacks; a parallel worktree on `5183`/`5193` works correctly only because its own `CORS_ORIGIN` env var is set to match (documented in Design Notes) — the hardcoded fallback itself was not extended to the other two ports. Low risk, pre-existing pattern, not a regression introduced here.
- **Not independently re-verified (carried from the implementation agent's own report, flagged as owed):** an actual live sign-in with a real Google account/credentials — the callback logic is covered by an injected-fake-OAuth-client test against real Postgres plus the DB-layer integration tests, but no real Google consent screen was exercised in this environment.
- **Judgment call surfaced by the agent, left as-is:** the session cookie's `Secure` flag is conditioned on `NODE_ENV === 'production'` rather than always-on, since a browser drops `Secure` cookies over local dev's plain HTTP. Matches the existing dev-vs-prod gating pattern already used by Story 1.1's CORS middleware.

## Spec Change Log

- 2026-11-15 — user-directed implementation amendment (mid-build, not a review loopback): (1) split `src/db/schema.ts` into `src/db/schema/` (one file per domain + `index.ts` re-export), repointing `src/drizzle.config.ts` at the folder; (2) added a `db:migrate` script to apply committed migrations; (3) made the Vite dev port and `/api` proxy target read from env (`WEB_PORT`/`API_PROXY_TARGET`, defaults `5173`/`http://localhost:3000`) so parallel worktrees can each use their own ports; (4) report must list the Google OAuth redirect URIs to register for ports 5173/5183/5193. No change to Problem/Approach/Boundaries — these are implementation choices in support of the same intent. KEEP: everything already decided (session store, OAuth flow, default personality) stands unchanged.

## Review Triage Log

- **Google ID token's `email_verified` claim never checked** (`src/api/routes/auth.ts`, blind-hunter) — `low` — real: only `sub`/`email` are checked; mitigated by `googleId` (not email) being the actual identity key, but a trivial guard addition is still warranted. Route: **patch**.
- **`GET /session`'s stale-session `destroy()` silently drops its error, unlike `/logout`'s** (`src/api/routes/auth.ts`, blind-hunter + edge-case-hunter) — `low` — real, confirmed: `/logout` logs `destroyError` via `console.error`, the stale-session branch in `/session` does not. Route: **patch**.
- **Dev-mode CORS/CSRF allowlist hardcodes only `localhost:5173`, not multi-port aware** (`src/api/middleware/requireSameOrigin.ts` + pre-existing `cors.ts`, blind-hunter + edge-case-hunter) — `low` — real, confirmed by reading both files: this story's own parallel-worktree ports (5183/5193) aren't in the hardcoded dev set, so a worktree on those ports depends entirely on `CORS_ORIGIN` being set correctly. Route: **patch**.
- **`GOOGLE_REDIRECT_URI`/`SESSION_SECRET` validated with only `.min(1)`** (`src/config/env.ts`, blind-hunter) — `low` — real, same class of gap Story 1.1 already patched for `DATABASE_URL`/`BODY_LIMIT`; no URL-shape check on the redirect URI, no minimum length on the secret despite `.env.example` recommending 32 random bytes. Route: **patch**.
- **`WEB_PORT=0` silently falls back to `5173`** (`web/vite.config.ts`, edge-case-hunter) — `low` — real, confirmed: `Number(env.WEB_PORT) || 5173` treats parsed `0` as falsy. Not a documented use case (the three supported ports are 5173/5183/5193), but the fix is a trivial one-line guard. Route: **patch**.
- **`GET /api/auth/session`'s authenticated success path has no test** (`src/api/routes/auth.test.ts`, verification-gap) — `medium` — real, pre-verified by that layer: no test in the repo calls `/session` with a valid session and asserts the response shape; a wrong field mapping or a `.parse()` throw would ship undetected. Route: **patch**.
- **`POST /api/auth/logout` has zero test coverage** (`src/api/routes/auth.test.ts` / `web/src/App.test.tsx`, verification-gap, incl. its "Other findings" note that `SignOutButton`'s click handler is also never exercised) — `medium` — real, pre-verified: a broken sign-out (wrong status, cookie not cleared, destroy silently failing) would pass the full suite. Route: **patch**.
- **OAuth callback's post-token-exchange failure branches untested** (`src/api/routes/auth.test.ts`, verification-gap) — `medium` — real, pre-verified: only `?error=` and forged-`state` failure modes are tested; a rejected `getToken`/`verifyIdToken` call or a payload missing `id_token`/`sub`/`email` is never exercised, so a regression turning this into an unhandled rejection/stack-trace leak wouldn't be caught. Route: **patch**.
- **No OAuth-specific rate limiting** (blind-hunter) — `false` — the general rate limiter (Story 1.1) already applies globally, including to `/api/auth/*`; the epic's "stricter tier" language is specifically about later LLM-backed cost-bearing tool routes, not auth, per `epic-1-context.md`'s Technical Decisions.
- **OAuth callback is a state-changing GET not covered by the Origin-header CSRF check** (blind-hunter) — `false` — an Origin check is the wrong tool for a third-party redirect callback (Google, not this app, is the navigating origin); the `state` parameter — implemented and checked (`state !== expectedState` branch) — is the correct, industry-standard CSRF defense for this exact flow.
- **No test for an already-authenticated session hitting `GET /api/auth/google` again** (blind-hunter) — `false` — re-initiating OAuth while signed in is harmless: `upsertUserAndSettings` is idempotent for an existing user, and `session.regenerate()` just issues a fresh session; no AC or I/O-matrix row calls for distinct handling.
- **No test asserts `session.regenerate()` actually changes the session id** (blind-hunter) — `false` — would test `express-session`'s own documented behavior, excluded by CLAUDE.md's "do not test framework or library behaviour."
- **Migration files (`0000_tiresome_quasimodo.sql` + `meta/`) end with no trailing newline** (blind-hunter) — `false` — this is `drizzle-kit`'s own standard generated-file format; hand-editing a generated migration to add a newline is itself the anti-pattern.
- **Concurrent first-sign-in for the same `googleId` could race the select-then-insert** (`src/db/auth-repository.ts`, edge-case-hunter) — `false` — `upsertUserAndSettings` is awaited inside the callback's existing `try/catch`, so a unique-constraint violation on the losing request is already caught and redirects to the same neutral `/?auth_error=1` page as any other callback failure; a retry then succeeds since the row now exists.
- **`requireAuth` is skipped for `GET /api/auth/google`/`google/callback`, "contradicting" a universal 401 gate** (edge-case-hunter, claim) — `false` — this exemption is explicit and intentional (Code Map: "these are how a user becomes authenticated in the first place"), not a reader-trust violation; it's the documented design, not a defect.
- **Session cookie's `Secure` flag is conditioned on `NODE_ENV`, "contradicting" the Intent's literal wording** (edge-case-hunter, claim) — `false` — already explicitly documented as a deliberate, necessary deviation (both in `session.ts`'s code comment and this spec's Implementation Notes): an always-`Secure` cookie would be silently dropped by the browser over local dev's plain HTTP, breaking the feature entirely in dev/CI.
- **`users.email` has no unique constraint/index** (blind-hunter) — `low` — real but functionally inert (login is keyed on `googleId`, never `email`); unlikely to occur in everyday use and the fix requires a schema migration, not a direct correction. Rejected (low + fix exceeds a direct correction, per triage rule).
- **`GOOGLE_REDIRECT_URI`/`CORS_ORIGIN`/`WEB_PORT` cross-consistency enforced only by code comments, no startup check** (blind-hunter) — `low` — real but self-correcting (a mismatch fails loudly as a 403 or Google's own `redirect_uri_mismatch`, not silently); fix would mean new cross-field startup validation, more than a direct correction. Rejected.
- **`authUserSchema.picture` has no URL-shape validation** (blind-hunter) — `low` — real but currently inert: `picture` isn't rendered anywhere in this story's UI yet, so there's no render-path risk today. Rejected (unlikely to be met in everyday use; fix is a judgment call, not a clear direct correction).
- **`GET /api/auth/session` re-queries Postgres on every call, no caching** (blind-hunter) — `low` — real but overstated: `useAuthStatus()` fires once per mount plus once after explicit sign-out, not on a poll interval; a single indexed PK lookup per page load is not a performance concern any AC raises. Rejected.
- **A non-401 server error (e.g. 500) from `GET /api/auth/session` renders identically to signed-out** (`web/src/App.tsx`, edge-case-hunter) — `low` — real UX imprecision, but unlikely in everyday use and the fix needs a new `AuthStatus` state plus a new UI branch, more than a direct correction. Rejected.
- **Live sign-in with a real Google account was not independently verified** (blind-hunter, echoing the Implementation Notes' own disclosure) — real, but not a code defect: this sandbox has no real `GOOGLE_CLIENT_ID`/`SECRET` to complete an actual Google consent screen. Route: **defer** (human verification once real credentials are filled in).

## Design Notes

- **Session store:** `express-session` + `connect-pg-simple` against the existing Postgres instance (no new infra; matches the "everything in Postgres" pattern); 30-day rolling expiry — not specified upstream, chosen as a reasonable default for a single-user coaching tool.
- **OAuth flow:** classic server-driven authorization-code flow (`GET /api/auth/google` → Google consent → `GET /api/auth/google/callback`), verified via `google-auth-library`'s `OAuth2Client`. No frontend OAuth SDK added — keeps the change backend-plus-a-redirect-link, consistent with the single-page (no router) frontend. The callback route is reached **through the Vite dev proxy** in dev (same-origin from the browser's perspective, at whichever `WEB_PORT` that worktree uses), not by hitting the backend port directly — so the registered Google redirect URI is the Vite origin, not the Express origin.
- **Callback failure:** on an `error` query param or token-exchange failure, redirect to `/?auth_error=1` rather than throwing; the frontend reads the flag once, shows a neutral message, then strips it from the URL.
- **Schema layout:** one file per domain under `src/db/schema/` (`users.ts`, `userSettings.ts`), `index.ts` re-exporting everything the db client and drizzle-kit need — keeps later stories' tables from piling into one file; the split must not change generated SQL (verify `db:generate`'s output is equivalent).
- **Parallel-worktree dev ports:** `WEB_PORT` (Vite dev server port, default `5173`) and `API_PROXY_TARGET` (where `/api` is proxied to, default `http://localhost:3000`) are dev-only, code-defaulted env vars read directly in `web/vite.config.ts` — not part of `src/config/env.ts`'s required-at-startup validation, since the backend doesn't need them and they always have a working default. Each worktree's own `GOOGLE_REDIRECT_URI` and `CORS_ORIGIN` must still be set to match its own `WEB_PORT`.

## Verification

**Commands:**
- `npm run db:generate` -- expected: migration reflects both tables unchanged by the folder split
- `npm run db:generate && npm run db:push` -- expected: migration applies cleanly against the Compose Postgres
- `npm run db:migrate` -- expected: applies the committed migration(s) cleanly against a fresh database
- `npm test` -- expected: all new + existing tests pass
- `npm run lint` -- expected: zero errors
- `npm run build` -- expected: clean build, both workspaces
- `WEB_PORT=5183 API_PROXY_TARGET=http://localhost:3010 npm run dev --workspace web` -- expected: Vite starts on `5183`, proxies `/api` to `3010`

**Manual checks (if no CLI):**
- Sign in with a real Google account against local Compose Postgres; confirm a `users` + `user_settings` row appears.
- Close and reopen the browser tab; confirm still signed in.
- Call a gated API route with the session cookie stripped; confirm 401.
- Confirm the Vite dev server defaults to port `5173` and proxies to `http://localhost:3000` when `WEB_PORT`/`API_PROXY_TARGET` are unset (no regression for the primary worktree).
