---
title: 'Story 1.1: Project Scaffolding & Themed UI Shell'
type: 'feature'
created: '2026-11-15'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8c2cb67d3edbdd916a818c35ee551b1b1788fa32'
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No project exists yet. Second Income Coach needs a working, themed, scaffolded codebase (TypeScript, Express, React, shared Zod schemas, Postgres via Drizzle, baseline security middleware) that every later story builds on.

**Approach:** Scaffold per `ARCHITECTURE-SPINE.md`'s source tree and `stack.md`'s pinned choices: Express + React (Vite, React Compiler), shadcn/ui + shadcn-glass-ui with the verified teal tokens, a persisted light/dark theme toggle, Drizzle-backed Postgres, and the AD-30 security baseline (helmet, same-origin CORS, rate limiting, body-size limit, `react/no-danger`) — wired and running end-to-end, no feature logic yet.

## Boundaries & Constraints

**Always:**
- Light mode is the default theme; dark-mode toggle persists across reloads (UX-DR1/UX-DR2).
- `shadcn/ui` + `shadcn-glass-ui` (`npm install shadcn-glass-ui` — NOT the deprecated `@yhooi2/shadcn-glass-ui`), Tailwind v4, teal accent tokens exactly as pinned in `stack.md` (light `--primary:#0f766e`/`--primary-foreground:#fff`/`--accent:#ccfbf1`/`--accent-foreground:#0f766e`; dark `--primary:#2dd4bf`/`--primary-foreground:#121316`/`--accent:#134e4a`/`--accent-foreground:#5eead4`; neutral background/card/foreground/muted/border tokens shared regardless of accent). Accent applies only to buttons, badges, progress fill, focus rings, banners — never whole surfaces.
- Contrast ≥4.5:1 in both themes, verified (not assumed).
- One shared Zod schema location importable by both backend and frontend; TS types derived via `z.infer` only, never hand-written.
- Postgres access wired through Drizzle ORM (parameterized by construction).
- `helmet` + same-origin `cors` (Vite dev proxy locally) + `express-rate-limit` (general tier now; stricter-tier factory for Epic 2/3's LLM routes) + a configured request body-size limit.
- ESLint `react/no-danger` rule enforced — fails lint on any `dangerouslySetInnerHTML`.
- React Compiler via `reactCompilerPreset` (Vite 8 + `@vitejs/plugin-react` v6; babel plugin before `react()`).
- `README.md` exists (written this session) — extend only its "Getting started" section.
- **Repo setup (decided):** npm workspaces at root — `src/` (backend, per spine layout), `web/` (frontend, per spine layout), `shared/` (hoisted to root, package `@app/shared`, contains `schemas/` — resolves the spine diagram's `shared/` nested under `src/`, unreachable from `web/` otherwise). One `npm install`; both sides import via `@app/shared`.
- **Local Postgres (decided):** Docker Compose — `docker-compose.yml` at root; setup command brings it up (or documents one step).

**Never:**
- No auth (1.2), agent loop (1.3), or i18n (1.4) — UI copy may be temporarily hardcoded English, retrofitted in 1.4.
- No domain Postgres tables/migrations (ideas, plans, check-ins, settings) — those land with the stories that need them.
- No LLM-backed or plain-code tool routes yet — the stricter rate-limit tier has no route to apply to, just the mechanism.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh checkout, missing env | Developer runs the setup command with no `.env` present | Clear error naming the missing required env var(s) | No silent crash or hang |
| First load, no stored theme | No theme key in storage | Renders light mode by default | N/A |
| Dark mode toggle + reload | User toggles dark, reloads the page | Dark mode still active | N/A |
| Oversized request body | POST with body over the configured size limit | Request rejected before the route handler runs | Generic error response, process stays up |

</frozen-after-approval>

## Code Map

- `package.json` (new, root) — npm workspaces (`src`, `web`, `shared`).
- `src/api/` (new) — Express app + security middleware.
- `src/db/` (new) — Drizzle client + Postgres config, pointed at Docker Compose.
- `shared/schemas/` (new) — `@app/shared` package; Zod schemas for both sides.
- `web/src/` (new) — React app: Vite config, theme provider, shadcn/ui + shadcn-glass-ui.
- `docker-compose.yml` (new, root) — local Postgres service.
- `README.md` (existing) — extend only "Getting started"; leave the rest untouched.
- Fully greenfield repo — nothing else exists yet besides planning docs.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` (root, `src/`, `web/`, `shared/`) + lockfile — npm workspaces init
- [x] `docker-compose.yml` — local Postgres service
- [x] `tsconfig*.json` — strict config for `src`, `web`, `shared`, each referencing `@app/shared`
- [x] `src/api/index.ts` (+ middleware) — `helmet`, same-origin `cors`, `express-rate-limit`, body-size limit
- [x] `src/db/client.ts` + Drizzle config — Postgres connection to the Compose instance
- [x] `shared/schemas/` — placeholder Zod schema + inferred type, proving `@app/shared` imports from both sides
- [x] `web/vite.config.ts` — Vite 8 + `@vitejs/plugin-react` v6, `reactCompilerPreset`, dev proxy to the API
- [x] `web/src/theme/` — theme provider (light default, persisted dark toggle), shadcn/ui + shadcn-glass-ui with the pinned tokens
- [x] `.eslintrc`/`eslint.config.js` — `react/no-danger` enabled
- [x] `README.md` — fill in "Getting started" with the real setup command(s)
- [x] `.env.example` — every required env var, placeholder values

**Acceptance Criteria:**
- Given a fresh checkout, when the developer runs the setup command, then the Express backend and React frontend both start successfully with TypeScript, Zod, and the shared schema package wired.
- Given the app loads with no stored theme preference, when it renders, then light mode shows by default using the shadcn-glass-ui teal tokens.
- Given a user toggles dark mode, when they reload or return later, then the dark-mode choice persists.
- Given any text in either theme, when checked against contrast requirements, then contrast is at least 4.5:1.
- Given the Postgres access layer, when configured, then it connects through Drizzle ORM with no raw SQL anywhere.
- Given the Express app, when it starts, then `helmet`, same-origin `cors`, `express-rate-limit`, and a body-size limit are all active.
- Given the frontend codebase, when linted, then `react/no-danger` fails the build on any `dangerouslySetInnerHTML` usage.

## Implementation Notes

- Implemented via a dispatched subagent per spec. All execution tasks and ACs verified independently against the diff (not just the subagent's report): `npm run typecheck`, `npm run lint` (clean), `react/no-danger` confirmed to actually fire via an injected probe file, `npm test` (12/12 passing: 3 shared + 7 src + 2 web), `npm run build` (clean), and a live run (Docker Compose Postgres + `tsx`) confirming `GET /api/health` and `GET /api/health/db` both return `200`. The closest contrast pair (`--muted-foreground` on `--card`) was independently recomputed via WCAG relative-luminance math: 4.83:1 light / 6.38:1 dark — both pass.
- TypeScript pinned to `6.0.3` rather than the architecture spine's `7.0.2` — `typescript-eslint` hard-errors against TS 7.0 (upstream gap, typescript-eslint#10940). Revisit once that lands.
- `shared/` schema package proven consumed on both sides, not just importable: the backend's `/api/health` route and the frontend's status badge both parse against the same `healthStatusSchema`.
- `_bmad-output/planning-artifacts/epics.md` shows unrelated concurrent edits (touching Stories 1.2, 2.2, 3.1, 4.1, 4.3, 4.4, 5.1–5.5) from a separate, parallel planning session the user is running — confirmed by the user, not part of this story. Left untouched and excluded from this story's commit, per the user's instruction to treat `epics.md`/`sprint-status.yaml` as read-only in this session.

## Spec Change Log

## Review Triage Log

- **CORS allowlist always includes `localhost:5173`/`127.0.0.1:5173` even in production** (`src/api/middleware/cors.ts:10`, found independently by blind-hunter, verification-gap, edge-case-hunter) — `medium` — real: `createCorsMiddleware` always unions the configured `CORS_ORIGIN` with two hardcoded dev origins, with `credentials: true`, regardless of `NODE_ENV`; contradicts the "deny-by-default... never a wildcard" intent stated in the same file. Route: **patch**.
- **Disallowed CORS origin surfaces as a generic 500, not a distinct 4xx** (`src/api/middleware/cors.ts`, blind-hunter) — `low` — real, confirmed by the test's own `res.status(500)` assertion; conflates a client-origin policy rejection with server failure, would make 5xx-based alerting noisy once deployed. Route: **patch**.
- **`express-rate-limit` has zero behavioral test coverage** (`src/api/middleware/rateLimit.ts`, blind-hunter + verification-gap) — `medium` — real: confirmed only 4 tests exist in `app.test.ts`, none sends more than one request or asserts a 429/`RateLimit-*` header; deleting the rate-limiter `app.use` call would not fail any test. Route: **patch**.
- **No `app.set('trust proxy', ...)`** (`src/api/app.ts`, blind-hunter) — `medium` — real: behind any reverse proxy/Cloud Run, the rate limiter (and any future IP-based logic) resolves the proxy's IP for every client, collapsing all users into one shared bucket. Route: **patch**.
- **`/api/health/db` success and error branches are both entirely untested** (`src/api/routes/health.ts`, verification-gap) — `medium` — real, confirmed via repo-wide grep: no test references `health/db` or `checkDbConnection`; inverting the branch logic would ship undetected on the app's only DB-connectivity signal. Route: **patch**.
- **`/api/health/db`'s catch block swallows the DB error with no logging** (`src/api/routes/health.ts`, blind-hunter) — `medium` — real: `catch { ... }` discards the error entirely before returning 503, leaving no server-side signal to distinguish a real outage from a code bug. Route: **patch**.
- **`drizzle.config.ts` calls `loadEnv()` unguarded at module top level** (`src/drizzle.config.ts`, blind-hunter) — `low` — real: unlike `api/index.ts`'s deliberate try/catch, running `drizzle-kit generate`/`push` with a bad env throws a raw `EnvValidationError` stack instead of the same clean exit pattern. Route: **patch**.
- **`.env.example` omits `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/`POSTGRES_PORT`** (blind-hunter) — `low` — real: `docker-compose.yml` reads these with defaults matching `DATABASE_URL`'s hardcoded creds, but nothing documents them for a developer wanting non-default local credentials/port. Route: **patch**.
- **No SIGTERM/SIGINT graceful-shutdown handling** (`src/api/index.ts`, blind-hunter) — `low` — real but unlikely to be encountered in local dev (a deploy-time/Cloud-Run concern), and the fix (signal handlers closing the pool/server) adds new behavior rather than a direct correction. Route: **rejected** (low + fix exceeds a direct correction, per triage rule).
- **`@types/node` pinned to `^26.6.6` vs. `engines.node: ">=20.19.0"`** (`src/package.json`, blind-hunter) — `low` — real: typechecking against Node-26-only APIs could pass `tsc` while failing at runtime on the actually-supported Node 20; no such API is used yet, so latent risk only. Route: **patch**.
- **Theme flips to dark only inside a post-paint `useEffect`** (`web/src/theme/theme-provider.tsx`, blind-hunter) — `low` — real and happens on every reload for a dark-mode user (cosmetic flash of light theme before JS runs); the I/O matrix's "dark mode still active" is eventually true but doesn't guarantee no visible flash. Route: **patch**.
- **CORS allow-branch (origin matching `CORS_ORIGIN`) never exercised by a test** (`src/api/middleware/cors.ts`, verification-gap) — `medium` — real: all 4 existing tests either send no `Origin` header or a disallowed one; an inverted allowlist check would pass the full suite while locking out the real frontend entirely. Route: **patch**.
- **Frontend health badge (`useApiHealth`) has no test** (`web/src/App.tsx`, verification-gap) — cosmetic placeholder indicator with no downstream consumer yet. Route: **defer** (per verification-gap's own filed disposition).
- **`checkDbConnection`'s boolean return value is never checked by its caller** (`src/db/client.ts`/`src/api/routes/health.ts`, verification-gap "Other findings") — `false` — the only query it runs is the constant `select 1 as ok`, which cannot resolve with zero rows when it succeeds; the asserted bad outcome (silently reporting "ok" on a logically-empty result) cannot occur at this call site.
- **`app.listen()` has no `.on('error', ...)` handler** (`src/api/index.ts`, edge-case-hunter) — `low` — real and plausible in everyday local dev (e.g. `EADDRINUSE` from a leftover process on the port): an unhandled error crashes with a raw Node stack instead of the same clean "startup failed" messaging used for env errors. Route: **patch**.
- **`pg` Pool has no `pool.on('error', ...)` handler** (`src/db/client.ts`, edge-case-hunter) — `medium` — real and a well-documented `pg` gotcha: an idle-client connection error (DB restart, network blip) unrelated to any in-flight request crashes the entire process. Route: **patch**.
- **`BODY_LIMIT` env var only checked for non-emptiness, not validated as a byte-size string** (`src/config/env.ts`, edge-case-hunter) — `low` — real: a malformed value (e.g. `"nope"`) passes startup validation and could silently fail to enforce the limit instead of failing fast. Route: **patch**.
- **`DATABASE_URL` env var only checked for non-emptiness, not validated as a URL** (`src/config/env.ts`, edge-case-hunter) — `low` — real: a malformed value passes startup validation and only fails later at Pool connect/query time, compounded by the unguarded pool error above. Route: **patch**.
- **Only JSON bodies are size-limited** (`src/api/app.ts`, edge-case-hunter) — `medium` — real: `express.json({limit})` only caps requests Express parses as JSON; other content types (`multipart/form-data`, `text/plain`) bypass the configured body-size limit entirely, undermining the AD-30 "body-size limit" requirement as a blanket protection. Route: **patch**.

## Verification

**Commands:**
- `docker compose up -d` -- expected: local Postgres container healthy
- `npm install && npm run dev` (root, workspaces) -- expected: backend and frontend both start without error
- `npm run lint` -- expected: zero lint errors, `react/no-danger` rule active
- `npm run build` -- expected: clean production build of both sides

**Manual checks (if no CLI):**
- Toggle dark mode, reload the page, confirm it persists.
- Run a contrast checker against both themes' text/background pairs, confirm ≥4.5:1.
