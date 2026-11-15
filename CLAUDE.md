## Testing policy

- Write a test only if it checks an acceptance criterion or an architecture decision, and name it in a comment (e.g. "AC 1.2.3" or "AD-14"). No mapping, no test.
- Do not test framework or library behaviour, plain getters, static markup, or snapshots.
- Prefer few, sharp tests: deterministic unit tests for plain-code tools, one integration test against real Postgres only for DB constraints (e.g. one active plan per user), and the guardrail tests defined in evals.md.
- While working, run only the tests a change can affect — not the full suite after every step.
- The full eval suite runs only on demand via `npm run eval`, never as part of a story build.
- At the end of each story, report: the new tests, the AC or AD each one maps to, and the total run time. Remove any test you cannot map.
- Per story, at most one test per I/O-matrix row or acceptance criterion, plus one per distinct failure branch in security-relevant code; put variants of the same case into one table-driven test (it.each). If a story would need more than 20 new tests, stop and list them with the reason before writing any.

## External service configuration

- Every story that introduces an external service adds its variable to `.env.example` (placeholder only, never a real key) and to the startup validation in `src/config/env.ts`.
- That story's report lists which keys the user must fill in.

## Environment files

- Never create, overwrite, or delete `.env` (root or any workspace) for ad hoc verification or manual live checks — it may hold the user's own real values, and it's gitignored, so there's no history to recover it from if deleted.
- For a live/manual check that needs env vars, pass them inline on the command line instead (`src/config/env.ts`'s `loadEnv()` reads directly from `process.env`, so no file is needed at all): e.g. `DATABASE_URL=... PORT=3000 npx tsx api/index.ts`. Same validation, same server behavior, zero touch on any `.env` file.
- Docker Compose needs no `.env` either — its defaults in `docker-compose.yml` are sufficient for local verification.

## Planning document ownership

- `epics.md`, `sprint-status.yaml`, and `ARCHITECTURE-SPINE.md` are written only by the planning session or the main worktree — never by a build session.

## Specs

- Write specs tersely: no filler words, no explanation of why unless a decision is non-obvious, and no restating an AC or AD; refer to it by ID instead of repeating its text.
