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

## Communication style

- Sharp and on point: lead with the result, then one line for what the user must do or decide.
- No filler words, no recaps of what the user already knows, no option surveys unless asked.
- Reports and questions to the user stay short; details go in the spec, not the chat.

## Requirements stay in place

- Never remove or replace a dependency, style, component or behaviour that an acceptance criterion, UX-DR or AD names, not even as a review fix or cleanup (e.g. a "dead" dependency that an earlier AC requires). Stop, and report it to the user instead of fixing it.
- Before deleting code or a dependency as unused, check epics.md and the spine for the name. If found, it stays.

## Planning document ownership

- `epics.md`, `sprint-status.yaml`, and `ARCHITECTURE-SPINE.md` are written only by the planning session or the main worktree — never by a build session.

## Specs

- Write specs tersely: no filler words, no explanation of why unless a decision is non-obvious, and no restating an AC or AD; refer to it by ID instead of repeating its text.

## Token budget

- Never invoke a design or UX skill (e.g. bmad-ux, bmad-agent-ux-designer, artifact-design) for a UI change in this repo. The template `layout-preview.html` is the design; edit the named files directly.
- Read only the files the prompt names plus what the change touches. No repo-wide exploration.
- Review depth: logic, security, DB or agent changes get one review pass (at most 2 reviewers). Layout-only or text-only changes get no review pass.
- Fix every defect in the story's own acceptance criteria until it works; there is no round cap for broken behaviour. Polish, new ideas and extras found along the way become their own story instead of extending this one.
- The report states the tokens used.

## No approval pauses for specs

- Never ask the user to approve the spec, the plan, or the checkpoint before building. Write the spec, then build. The user always approves, so the pause only costs time.
- Stop and ask only for real decisions: a requirement conflict, a new paid service or key, a migration number collision, or an AC that cannot be met as written.
