## Testing policy

- Write a test only if it checks an acceptance criterion or an architecture decision, and name it in a comment (e.g. "AC 1.2.3" or "AD-14"). No mapping, no test.
- Do not test framework or library behaviour, plain getters, static markup, or snapshots.
- Prefer few, sharp tests: deterministic unit tests for plain-code tools, one integration test against real Postgres only for DB constraints (e.g. one active plan per user), and the guardrail tests defined in evals.md.
- While working, run only the tests a change can affect — not the full suite after every step.
- The full eval suite runs only on demand via `npm run eval`, never as part of a story build.
- At the end of each story, report: the new tests, the AC or AD each one maps to, and the total run time. Remove any test you cannot map.

## External service configuration

- Every story that introduces an external service adds its variable to `.env.example` (placeholder only, never a real key) and to the startup validation in `src/config/env.ts`.
- That story's report lists which keys the user must fill in.

## Planning document ownership

- `epics.md`, `sprint-status.yaml`, and `ARCHITECTURE-SPINE.md` are written only by the planning session or the main worktree — never by a build session.
