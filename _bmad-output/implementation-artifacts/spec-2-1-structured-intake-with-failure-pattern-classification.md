---
title: 'Story 2.1: Structured Intake with Failure-Pattern Classification'
type: 'feature'
created: '2026-11-16'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'b633febceaaedb06b06a7264e0ffcbcc41e4b026'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing today captures a user's skills, available time, budget, risk tolerance, or what's stopped them before — Epic 2's idea generation (Story 2.2) has no per-user data to tailor against.

**Approach:** Add a structured intake form that POSTs to a new plain-code `submit_intake` tool invoked through the existing discovery-thread agent loop — the top-level agent classifies the free-text "what's stopped you before" answer into one of five failure patterns while constructing the tool call (AD-4) — persisting everything to a new Postgres `intake` table (one row per user); a plain GET read prefills the same form on revisit.

## Boundaries & Constraints

**Always:**
- `submit_intake` is deterministic plain-code (AD-4): Zod-validates its args before any write, never makes its own LLM call.
- `failurePattern` is classified by the top-level agent while constructing the tool call — never a second tool, never a client-supplied field.
- Intake free text reaches `submit_intake` only via `agent.invoke()` on the existing discovery thread (`buildDiscoveryThreadId`, AD-18) — this is what the moderation hooks (NFR4/AD-11) already screen for free; never call the persistence logic directly from the HTTP route, bypassing the agent loop.
- The persisted row's `userId` is derived server-side from the session-rooted thread id — never trusted as a model-supplied tool argument.
- Shared Zod schemas (`shared/schemas/intake.ts`) define every enum; DB columns stay plain `text()` validated only at the Zod layer, matching `userSettings`'s existing precedent — no `pgEnum`, no DB check constraint.
- Every UI string uses `useTranslation('intake')`; German and English keys exist from the first commit (AD-24).
- Frontend intake UI lives under `web/src/features/intake/` (human decision — accepted as a new `features/` nesting even though the rest of the codebase uses flat top-level feature folders).

**Never:**
- No new external service or env var — this story introduces none (`web_search` lands in Story 2.2).
- No `get_intake` agent tool — the prefill read is a plain `GET`, not a LangChain tool (AD-4's tool list has no such tool).
- Don't touch `web/src/chat/**`, `src/api/routes/chat.ts`, moderation/resilience/language modules, `locales/**/common.json`/`chat.json`, `auth.ts`, session code, `scripts/`, `vite.config.ts`, `api/index.ts`, or `CreateCoachAgentDeps`'s public shape (Lane B / already-wired startup).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No intake yet | Signed-in user, no row for them | App renders the intake form, blank | N/A |
| Valid submission | POST with all fields filled | Agent classifies `failurePattern`, row upserted, 200 + record returned | N/A |
| Invalid/missing field | POST missing a field or an out-of-enum value | Rejected at the Zod boundary before any write or agent call | 400, generic error body |
| Agent doesn't call the tool | e.g. `beforeModel` jailbreak-rejects the turn | Row stays unchanged/absent | Generic error response, no partial row ever saved |
| Revisit with existing intake | GET before rendering the form | Form renders prefilled from the saved record | N/A |
| Resubmit with changed values | POST again for a user with an existing row | Same row updated in place (upsert by `userId`), never a second row | N/A |

</frozen-after-approval>

## Code Map

- `src/db/schema/userSettings.ts` — mirror: uuid PK `.defaultRandom()`, unique `userId` FK to `users`, plain `text()` columns w/ defaults, `timestamptz` created/updated.
- `src/db/auth-repository.ts` + `.test.ts` — mirror for a persistence function plus its one real-Postgres integration test.
- `shared/schemas/index.ts` — single-file convention (schema + adjacent `z.infer` type); add `export * from './intake.js';`.
- `src/agent/index.ts:90-98` — add one `tools: [...]` key to the existing `createAgent({ model, middleware })` call. `env` already in scope; call `createDb(env)` once inside this function for the tool's db handle. Don't touch `api/index.ts` or `CreateCoachAgentDeps`.
- `src/agent/index.ts:62-64` — `buildDiscoveryThreadId(userId) = \`discovery:${userId}\`;` the tool derives `userId` by stripping this prefix from `config.configurable.thread_id` (duplicate the literal locally, comment back to this line — don't add a new export here).
- `src/agent/moderation.ts` — `beforeModel` rewrites message content in place on PII redaction before the model runs; this is why routing intake text through `agent.invoke()` (not a direct call) gets NFR4 for free.
- `src/api/routes/chat.ts:53-79` — router-factory + `agent.invoke({ messages }, { configurable: { thread_id } })` pattern to mirror exactly; same bare-JSON response shape, `{ error: 'message' }` vocabulary, no raw error/user-text logging.
- `src/api/app.ts:17-22,84` — `AppDeps` already has `db`/`agent`; add one import + one mount line after chat.
- `src/api/middleware/rateLimit.ts` (`createStrictRateLimiter`) — intake's `POST` is LLM-backed like chat's; reuse the same strict tier.
- `web/src/i18n/index.ts` — add `intakeEn`/`intakeDe` imports, extend each locale's resources object.
- `web/src/App.tsx:119-157` — render intake view instead of `<ChatThread />` when no intake exists; small revisit link once one does.
- `web/src/components/ui/button.tsx`, `card.tsx` — CVA + `cn()` convention for new `Input`/`Textarea`/`Label`/`Select` (none exist; no form lib in `web/package.json` — hand-write).
- `web/src/locales/en/chat.json` — flat-key + one-nested-group-per-category convention to mirror in `intake.json`.

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema/intake.ts` -- define `intake` table (uuid PK, unique `userId` FK, `skillsInterests`/`weeklyTimeAvailability`/`startingBudgetRange`/`riskTolerance`/`stoppedBeforeText`/`failurePattern` text columns, timestamps) -- AC3
- [x] `src/db/schema/index.ts` -- `export * from './intake.js';`
- [x] `shared/schemas/intake.ts` -- enums (`failurePatternSchema` etc.), free-text length consts, `submitIntakeRequestSchema` (form fields only), `submitIntakeToolSchema` (+ `failurePattern`), `intakeResponseSchema` (user-facing record), `z.infer` types -- AD-16
- [x] `shared/schemas/index.ts` -- `export * from './intake.js';`
- [x] `src/tools/plain/submit_intake.ts` -- `upsertIntake(db, userId, args)`, `getIntakeByUserId(db, userId)`, and the `tool()`-wrapped `submit_intake` deriving `userId` from `config.configurable.thread_id` -- AC2/AC3/AC4/AD-4
- [x] `src/agent/index.ts` -- add `tools: [createSubmitIntakeTool(db)]` to the existing `createAgent(...)` call -- AD-4
- [x] `src/api/routes/intake.ts` -- `createIntakeRouter({ env, db, agent })`: `GET /` reads the saved row (AC5); `POST /` validates, invokes the agent on the discovery thread, re-reads the row, returns it or a generic error if unchanged -- AC2/AC3/AC6
- [x] `src/api/app.ts` -- import + mount line after chat
- [x] `web/src/locales/{en,de}/intake.json` -- all form copy and error states
- [x] `web/src/i18n/index.ts` -- register `intake` namespace
- [x] `web/src/components/ui/{textarea,label,select}.tsx` -- minimal shadcn-style primitives (`input.tsx` was also built per this task but removed during review as dead code — no field in this form is single-line; see Implementation Notes)
- [x] `web/src/features/intake/IntakeForm.tsx` -- controlled form, client-side `submitIntakeRequestSchema.safeParse` before POST, prefilled from `GET /api/intake` -- AC1/AC5/AC6
- [x] `web/src/App.tsx` -- render intake form vs. chat based on intake presence; revisit link -- AC1/AC5

**Acceptance Criteria:**
- Given the agent's turn completes without ever calling `submit_intake`, when the route checks the row afterward, then it returns a generic error and never saves a partial/zero-valued record. -- satisfied: `intake.test.ts`'s 502 case.
- Given `/api/intake` is hit with no session, when `requireAuth`'s existing blanket gate runs, then it 401s -- no new auth logic needed here. -- satisfied: router adds no auth code; relies entirely on the existing blanket gate.

## Implementation Notes

- Built largely as planned; all tasks complete, all I/O-matrix rows covered by a passing test (verified independently against the diff, not just the implementer's report).
- **Boundary tension, resolved in favor of the Code Map's explicit instruction:** the Code Map told the implementer to call `createDb(env)` inside `createCoachAgent` for the tool's db handle — but `env`'s existing `Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>` doesn't include `DATABASE_URL`, which `createDb` requires. Satisfying that instruction necessarily widened `CreateCoachAgentDeps`'s `env` Pick (+ added an optional test-only `db` seam) — a literal conflict with this same spec's "Never: ...or `CreateCoachAgentDeps`'s public shape" line, which was really motivated by keeping `api/index.ts` untouched. That goal held: `api/index.ts`'s call site needed zero changes (it already passes the full `Env`) and typechecks as-is. Accepted as the only coherent resolution of a self-contradiction in the spec itself, not a scope overreach.
- Removed `web/src/components/ui/input.tsx` during review: the task list named it alongside `textarea`/`label`/`select`, but no field in this form is single-line (both free-text fields are `Textarea`s) — it was dead code, unused anywhere. Deleted per CLAUDE.md ("if you're certain something is unused, delete it completely"); typecheck/lint/tests re-verified clean after removal.
- `POST /api/intake`'s error response (`502 { error: 'Intake could not be saved' }`) doesn't match the fixed 5-string error vocabulary `chat.ts`/`auth.ts` otherwise use ('Bad request', 'Unauthorized', 'Forbidden', 'Internal server error', 'Service unavailable') — the spec only required "generic error," not that specific vocabulary, so left as the implementer wrote it; worth a follow-up nit if you want strict consistency.
- Migration generated via `npm run db:generate` (in `src/`) and applied to the local Compose Postgres directly via `psql -f` (the exact generated `CREATE TABLE`/`ALTER TABLE` SQL, nothing hand-edited) since `drizzle-kit push --force` was blocked by this environment's destructive-action sandboxing — functionally equivalent, confirmed via `\d intake`.
- Manual browser click-through (sign in, submit, reload, revisit) from Verification was not run in this environment (no dev server/browser session available) — only automated typecheck/lint/test verification.
- **Review patch pass (5 fixes, see Review Triage Log):** `useHasIntake` now falls back to `false` instead of staying `null` forever on a failed `GET /api/intake`; added a `deriveUserIdFromThreadId`/`buildDiscoveryThreadId` round-trip test; `buildIntakeAgentMessage` now wraps the two free-text fields in `"""..."""` delimiters with an instruction to treat that content as literal data; added a test for "existing row + agent never calls the tool" (the exact scenario the `before`/`after` check exists for); unified the `GET`/`POST` catch-block log fields to both use `{ userId, error }`. All re-verified independently: `src` 93/93 tests, `web` 14/14 tests, `shared` 7/7 tests, typecheck clean in all 3 workspaces, `eslint` clean across the repo.
- **Post-review follow-up (user-requested, after the "done" report):** removed the second pg `Pool` (deferred-work entry #2 above). `CreateCoachAgentDeps.db` changed from an optional test-only seam to a required field (`env`'s `Pick` reverted — `DATABASE_URL` no longer needed there); `api/index.ts:42` now passes its one existing `db` into `createCoachAgent`; the `createDb` import there is type-only. Re-verified: `src` 93/93 tests, typecheck clean, `eslint` clean across the repo. `web`/`shared` untouched by this change.

## Spec Change Log

- **User-requested addition (post-"done"):** visible submit feedback on `IntakeForm` — a `'idle' | 'submitting' | 'saved' | 'error'` phase replaces the old boolean `submitting`/`submitError` state. While pending: button label becomes `savingButton` ("Saving…") with a small spinner, `aria-busy` set on the `<form>`, all fields and the button disabled. On success: a `savedConfirmation` ("Saved") badge shows for ~600ms (`SAVED_CONFIRMATION_MS`) before `onSaved` fires. On failure or on a 20s client-side timeout (`SUBMIT_TIMEOUT_MS`, via `AbortController` — no AC covered this before, no backend timeout existed either): falls back to `'error'`, fields re-enabled, same existing `error.submitFailed` message (no new error-copy key — the request asked for "a translated error," not a distinct one for timeout). Two new locale keys (`savingButton`, `savedConfirmation`) added to both `en`/`de`. No test added — no AC in this spec's frozen Intent/Tasks covers this UI polish, per CLAUDE.md's "no mapping, no test" and the request's own explicit instruction.
- **Bug fix (live user report, real regression — introduced by the visible-submit-feedback change above):** the submission would hang on "Saving…" forever in the real browser — reproduced 3 times live, including with a freshly restarted backend and a hard-refreshed tab, ruling out dev-server/stale-bundle causes. Root cause: `isMountedRef`'s effect only set `.current = false` in its cleanup and never reset it to `true` on setup; React's `<StrictMode>` (`main.tsx`, dev-only) double-invokes mount effects (mount → cleanup → mount again), so `.current` was permanently `false` for the component's entire real lifetime — every `if (isMountedRef.current)` guard in `handleSubmit` (including the one gating `onSaved`) silently no-opped even though the POST had actually succeeded (verified via direct Postgres queries each time: the row was always correctly written). Fix: set `isMountedRef.current = true` at the top of the effect body too, not just via the `useRef` initializer. Confirmed the regression test actually catches this (temporarily reverted the fix, test failed exactly as expected; restored it, test passed). `web/src/App.test.tsx`'s `renderApp()` helper now wraps in `<StrictMode>` to match production's real rendering mode — without it, this exact bug class is invisible to the existing "shows chat after a successful submission" test. No new test file; extended the existing AC1/AC5-mapped one.
- **User feedback (post-fix):** the "Saved" confirmation badge + 600ms delay was removed again — flashed too briefly (~half a second) to be useful. `onSaved` now fires immediately on a successful response; the `'saved'` phase and `savedConfirmation` locale key are gone entirely (`phase` is back to `'idle' | 'submitting' | 'error'`). The "Saving…" spinner/label/`aria-busy`/disabled-fields behavior from the original request is unchanged.

## Review Triage Log

Three parallel review layers (blind-hunter, edge-case-hunter, verification-gap) ran against the full diff since `baseline_commit`. Verdicts below; `patch` entries were sent back to the implementation subagent and re-verified, `defer` entries were appended to `deferred-work.md`.

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | No test covers "existing intake row + agent's turn never calls `submit_intake`" for the `before`/`after` success check (`intake.ts:94-95`) | medium | Verification-gap layer (pre-verified): read all 3 `POST /` tests in `intake.test.ts`; none seed a pre-existing row before the no-tool-call case, so that branch of `saved`'s logic is unexercised. | patch |
| 2 | No test exercises `submit_intake` through the real `createAgent` tool-dispatch loop (only through hand-rolled fakes/direct calls) | medium | Verification-gap layer (pre-verified): symbol search for `createCoachAgent\|bindTools\|tool_calls` in test files found only `agent/index.test.ts`, whose one test never drives a tool-call turn. | defer |
| 3 | `useHasIntake` (`App.tsx`) leaves `hasIntake` as `null` forever on a failed/non-ok `GET /api/intake` — authenticated view stuck on the loading placeholder with no retry | medium | Verified directly: the effect's `.catch(() => undefined)` and `!res.ok` branch never call `setHasIntake`, unlike `IntakeForm`'s own mount-fetch which has a `.finally` fallback. | patch |
| 4 | `deriveUserIdFromThreadId` duplicates the inverse of `buildDiscoveryThreadId` with no round-trip test; a future thread-id format change breaks all intake submissions with nothing failing | medium | Verified directly: confirmed the duplication and searched `submit_intake.test.ts` — no round-trip assertion exists. | patch |
| 5 | `buildIntakeAgentMessage` splices user free text into the agent instruction string with no delimiter separating instruction from user content | low | Verified directly: confirmed the raw string interpolation. Blast radius is low — Zod still bounds `failurePattern`/enum fields, `userId` is never model-supplied, and the message still passes through the same `beforeModel` jailbreak screening every chat turn gets. Fix is a direct correction (add delimiters), so not rejected under the low-finding rule. | patch |
| 6 | `createCoachAgent` opens a second pg `Pool` (`createDb(env).db`) whose `.pool` handle is discarded — doubles idle DB connections, never explicitly closed | medium | Verified directly against `src/api/index.ts`/`src/db/client.ts`. Already a named, deliberate Design Notes tradeoff forced by the user's own explicit instruction not to touch `api/index.ts` in this lane — fixing it properly requires reopening that boundary. | defer → **resolved**: the user explicitly reopened the boundary ("pass the existing db from api/index.ts into createCoachAgent instead ... drop the extra pool") — `db` is now a required `CreateCoachAgentDeps` field, `api/index.ts` passes its one existing `db`, and `createCoachAgent` no longer calls `createDb` at all. |
| 7 | `GET /`/`POST /` catch blocks log different fields (`userId` vs `threadId`) for the same signed-in user, no functional reason | low | Verified directly. Neither violates AD-30 log hygiene (both are identifiers, not message content) — purely a style inconsistency within one new file. Fix is a direct one-line correction. | patch |
| 8 | Select fields (`weeklyTimeAvailability`/`startingBudgetRange`/`riskTolerance`) default to `options[0]` with no way for client validation to detect an unmade choice | false | Refuted: AC1 itself specifies "time/budget/risk preselected ranges" — a preselected default is the spec's own required behavior for these fields, not an unvalidated gap. Only the two free-text fields are meant to require deliberate input, and both do. | — |
| 9 | Generated migration/snapshot files lack a trailing newline | false | Refuted: standard `drizzle-kit generate` output formatting, not hand-edited; regenerating reproduces the same bytes. | — |
| 10 | The route's one try/catch spans the write, the re-read, and `submitIntakeResponseSchema.parse` — a failure strictly after a successful write (transient read error, or a parse mismatch) reports 502 despite the data being saved | low | Verified directly as a real but narrow window; consequence is a confusing message only, since resubmission is a safe idempotent upsert, not data loss. Fix (separating failure classes) is more than a direct correction — rejected per the low-finding rule (unlikely in everyday use + fix beyond a direct correction). | reject |
| 11 | Concurrent duplicate `POST /api/intake` requests from the same user (e.g. multiple tabs) can cross-report each other's write as this request's own success/failure, since the check is a global per-user before/after timestamp diff | low | Verified directly by tracing the logic; same-tab double-submit is already guarded by `IntakeForm`'s `submitting` state, so this needs genuinely concurrent requests. Fix (request-scoped success signal) is more than a direct correction — rejected per the low-finding rule. | reject |
| 12 | `intake.test.ts`/`submit_intake.test.ts` each hardcode the same fallback test `DATABASE_URL`, matching pre-existing `auth-repository.test.ts` precedent rather than sharing one constant | low | Verified directly; pure DRY nit, zero functional risk, and extracting a shared helper touches a file (`auth-repository.test.ts`) outside this story's diff. Fix is more than a direct correction — rejected per the low-finding rule. | reject |
| 13 | `GET /`'s catch-block 503 path (DB read failure) has no test | low | Verified directly — true, but no AC/AD in this spec maps to that branch, and CLAUDE.md's testing policy ("Write a test only if it checks an AC or AD... No mapping, no test") excludes adding one. Rejected per project testing policy, not added. | reject |

## Design Notes

- `intake`: one row per user (unique `userId`, upsert on resubmit) — mirrors `userSettings`; no historical versions.
- Enum tokens (my call, not in the ACs): `failurePattern` = `overwhelm | loses_interest_once_routine | gets_stuck_no_next_step | life_disruption | forgets_deprioritizes`; `weeklyTimeAvailability` = `under_5h | 5_to_10h | 10_to_20h | 20h_plus`; `startingBudgetRange` = `under_100 | 100_to_500 | 500_to_2000 | 2000_plus` (Story 2.2 interprets numerically; AD-27 doesn't apply to this self-reported bucket); `riskTolerance` = `low | medium | high`. Free-text fields capped at 1000 chars (same pattern as `CHAT_MESSAGE_MAX_LENGTH`).
- `agent.invoke()` (not a direct call) is required by AD-4's "classifies as part of its own reasoning" and gets NFR4 moderation for free — same as `chat.ts`.
- ~~`createCoachAgent` builds its own `createDb(env)` for the tool's db access (a second pg `Pool`, kept separate from `api/index.ts`'s so that file stays untouched per the lane boundary) — a later story may consolidate.~~ **Superseded post-review:** the user asked to drop the extra pool and pass the existing `db` through instead — `CreateCoachAgentDeps.db` is now required, `api/index.ts` passes its own `db` in one line, and `createCoachAgent` has no `createDb` call left.
- No new npm dependency: hand-written controlled inputs + the shared schema's `safeParse`, matching the frontend's existing footprint.

## Verification

**Commands:**
- `npm run db:generate` (in `src/`) -- generates the migration from `intake.ts`, run last per instruction, after checking `git log` for new commits on `main`
- `npm run test` (in `src/`, `shared/`, filtered to new files) -- new tests pass
- `npm run typecheck` (each workspace) -- no type errors

**Manual checks:**
- Start the stack (Compose Postgres + `src`/`web` dev servers), sign in as a fresh user: intake form renders blank; submit it; confirm the chat view appears next; reload and revisit the intake view to confirm it's prefilled, not blank; confirm existing chat still works unaffected.
