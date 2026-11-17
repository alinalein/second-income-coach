---
title: 'Story 3.1: Draft Plan Generation with Failure-Pattern-Aware Steps'
type: 'feature'
created: '2026-11-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'a2dca176b26e6a4a2a7ba1e54e278d037c6c2620'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A user who selects an idea has no concrete plan — just a vague idea card. There's also no shared workspace shell yet for Epic 3/4/5 to build check-ins, activation, and projections into.

**Approach:** Add `create_plan` (LLM-backed, lazy, Zod-validated draft write) and `get_current_step` (plain-code, sole steps-read path) per AD-4/AD-13/AD-16/AD-18. Build the `PlanWorkspace` shell (status sidebar + chat column, narrow-screen collapse) with empty extension points for 3.2/3.3/4.x/5.2/5.3, extending `ChatThread`/`ChatMessage` additively, never replacing them.

## Boundaries & Constraints

**Always:** `create_plan` writes are Zod-validated before persisting, one attempt, no whole-turn retry (`PLAN_MODEL_NODE_RETRY_POLICY`, `maxAttempts: 1`, mirroring `IDEAS_MODEL_NODE_RETRY_POLICY`), aborts on client disconnect. `get_current_step` is the only path returning step content, capped to current+next. Exactly one `plans` row per idea (DB unique constraint). A new plan thread id is `plan:${planId}` (AD-18), never the discovery thread. `PlanWorkspace`'s layout file is the only file any story may edit for this layout.

**Never:** No eager plan creation for unselected/unbookmarked ideas. No file edits to `src/tools/llm/generate_ideas.ts`, `src/api/routes/ideas.ts`'s discovery/regional logic, intake country field, or `IdeaEvidence` (Lane B owns these). No draft review/confirm/reject UI (3.2) or plan switcher (3.3) — 3.1 renders the draft read-only. No `activate_plan`/HITL (3.2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First selection, no plan | idea.status becomes selectable target, no `plans` row for it | `create_plan` runs once, draft row + ordered steps + plan thread created | — |
| Re-open, plan exists | idea already has a `plans` row (draft/active/paused) | Existing row returned, `create_plan` never re-invoked | — |
| LLM output fails Zod validation | malformed steps array | Not saved as draft; surfaced as a 502 error | Error returned, no partial row |
| Client disconnects mid-generation | request aborted | In-flight LLM call aborted via `AbortSignal`, no orphaned write | No row written |
| View draft plan | plan exists, any status | UI/`get_current_step` show only current+immediate-next step | — |
| Idea not owned by user / unselected idea | ideaId belongs to another user, or idea still `suggested` | 404/403, no plan created | No row written |
| Narrow screen | viewport < mobile breakpoint | Sidebar collapses to compact header above chat | — |

</frozen-after-approval>

## Code Map

- `src/db/schema/plans.ts` (new) -- `plans` (id, ideaId unique FK, userId FK, status text, threadId text, createdAt/updatedAt) + `planSteps` (id, planId FK, stepOrder int, title, description, dayOffset int, status text: pending/current/completed). No `pgEnum` (same precedent as `ideas.ts`/`intake.ts`).
- `shared/schemas/plans.ts` (new) -- `planStatusSchema`, `planStepStatusSchema`, `createPlanToolSchema` (`{ replyLanguage }, mirrors `generateIdeasToolSchema`), `createPlanDraftSchema` (LLM output: `steps: z.array({title,description,dayOffset}).min(3).max(12)`, dayOffset non-decreasing refine), `planResponseSchema`, `currentStepResponseSchema` (`{current, next: nullable}`). Export from `shared/schemas/index.ts`.
- `src/agent/resilience.ts` -- add `PLAN_MODEL_NODE_TIMEOUT_MS` (30_000) and `PLAN_MODEL_NODE_RETRY_POLICY` (`maxAttempts: 1`), same pattern/comment style as `IDEAS_MODEL_NODE_*`.
- `src/agent/index.ts` -- add `buildPlanThreadId(planId)` = `` `plan:${planId}` `` next to `buildDiscoveryThreadId`; construct a third compiled agent (`plansAgent`) via `createCoachAgent` with tools `[createCreatePlanTool(db, chatModel), createGetCurrentStepTool(db)]` and the new resilience constants.
- `src/tools/llm/create_plan.ts` (new) -- `createCreatePlanTool(db, chatModel)`. Derives `planId`/`ideaId` from trusted server context (passed via `config.configurable`, never model-supplied), loads idea + `intake.failurePattern`, calls `chatModel.withStructuredOutput(createPlanDraftSchema)` once (no nested agent, no internal retry loop — direct call, matching "fast, one attempt"), Zod-validates, inserts `plans`+`planSteps` rows (step 0 = `current`), all inside one DB transaction.
- `src/tools/plain/get_current_step.ts` (new) -- `getCurrentStep(db, planId)` (queries the `current`-status step + the next `stepOrder`), wrapped as `createGetCurrentStepTool(db)` for agent use (free-form Q&A) and exported directly for route use. Sole path returning step content (AD-4).
- `src/api/routes/plans.ts` (new) -- `POST /api/plans/select/:ideaId` (lazy create-or-fetch: 404 if idea not owned/not selected-or-bookmarked; if no `plans` row, builds `planId`, runs `plansAgent.invoke` on `plan:${planId}` with an internal trigger message incl. `replyLanguage`, wrapped in the same `AbortController`/`req.on('close')` pattern as `ideas.ts:150-163`; else returns existing row) + `GET /api/plans/:planId/current-step`. Mounted in `src/api/app.ts` after `requireAuth`.
- `src/api/routes/plan-chat.ts` (new) -- `POST/GET /api/plans/:planId/messages`, mirrors `chat.ts`'s SSE pattern exactly but resolves `plan:${planId}` (after an ownership check against `plans.userId`) instead of the discovery thread — for 3.1's free-form-follow-up AC.
- `src/agent/progress.ts` -- add one registry entry `create_plan` -> `creating_plan`; add `creating_plan` key to `web/src/locales/{en,de}/chat.json`'s `progress` namespace (epics.md: "Story 3.1 registers 'Working on your plan…' for `create_plan`").
- `web/src/features/plan-workspace/PlanWorkspace.tsx` (new) -- the owned layout: sidebar/header (`StatusPanel`) + chat column, narrow-screen collapse to compact header, projection-card slot (renders nothing until 4.4), chat-input extension point (empty), `ChatMessage` footer extension point (empty).
- `web/src/features/plan-workspace/StatusPanel.tsx` (new) -- current+next step (via `GET /api/plans/:planId/current-step`), timeline; renders nothing extra until 4.1 plugs in check-in controls.
- `web/src/chat/ChatThread.tsx` / `ChatMessage.tsx` -- extend additively: accept an `endpoint`/`threadKind` prop (default discovery, unchanged behavior) so `PlanWorkspace` can point it at `/api/plans/:planId/messages`; add the (currently empty) footer-item list prop and chat-input extra-mode slot. No existing Story 1.3 behavior changes.
- `web/src/App.tsx` -- add a lightweight state branch: when an idea is `selected`, render `PlanWorkspace` (fetched via `POST /api/plans/select/:ideaId`) instead of `IdeasPanel`+`ChatThread`; a "Back to ideas" local-only toggle returns to the list view.
- `web/src/features/ideas/IdeasPanel.tsx` -- add a "View plan" action on a `selected`/`bookmarked` idea card, triggering the above navigation. No other change.
- Reference, read-only: `src/tools/plain/submit_intake.ts` (thread-id derivation pattern), `src/tools/llm/generate_ideas.ts` / `src/api/routes/ideas.ts:143-178` (abort/trigger-thread pattern to mirror) -- do not edit.

## Tasks & Acceptance

**Execution:**
- [x] `src/db/schema/plans.ts`, migration -- add `plans`/`planSteps` tables -- generate migration last, after checking `git log` for newer migrations; report when generated.
- [x] `shared/schemas/plans.ts` -- schemas/enums -- AD-16
- [x] `src/agent/resilience.ts`, `src/agent/index.ts` -- plan thread id, third compiled agent, no-retry policy -- AD-18, "fast/no-loop" constraint
- [x] `src/tools/llm/create_plan.ts` -- lazy, validated, failure-pattern-aware draft generation -- AD-4, AD-13, AD-16
- [x] `src/tools/plain/get_current_step.ts` -- sole steps-read path -- AD-4
- [x] `src/api/routes/plans.ts`, `plan-chat.ts`, `app.ts` wiring -- lazy trigger + current-step + plan-thread messaging
- [x] `src/agent/progress.ts` + i18n -- `create_plan` friendly label
- [x] `web/src/features/plan-workspace/*`, `ChatThread.tsx` extension, `App.tsx`, `IdeasPanel.tsx` -- workspace shell per layout-preview.html

**Acceptance Criteria:** (epics.md Story 3.1, verbatim ACs — not restated here; see that file for the full Given/When/Then list covering lazy creation, failure-pattern sizing, current+next visibility, Zod validation, plan-thread creation, unified layout, narrow-screen collapse, extension-point ownership, and free-form follow-up Q&A.)

## Implementation Notes

- Migration generated last, after confirming `git log -- src/db/migrations` showed no migration newer than `0002_silly_red_shift.sql`: `npx drizzle-kit generate` (run from `src/`) produced `0003_outgoing_stick.sql` (`plans`/`plan_steps` tables, `plans_idea_id_unique` constraint), applied locally via `drizzle-kit migrate`.
- Code Map says `src/agent/index.ts` "construct[s] a third compiled agent (plansAgent)". In practice `createCoachAgent` is a factory exported from `agent/index.ts`, and both existing agents (`agent`, `ideasAgent`) are actually *constructed* in `src/api/index.ts` (the one place `chatModel`/`db`/`webSearchTool` are all in scope) — `agent/index.ts` itself never constructs an agent instance today. `plansAgent` follows that exact same existing precedent: built in `src/api/index.ts` via `createCoachAgent({ ..., tools: [createCreatePlanTool(db, chatModel), createGetCurrentStepTool(db)], modelNodeTimeoutMs: PLAN_MODEL_NODE_TIMEOUT_MS, modelNodeRetryPolicy: PLAN_MODEL_NODE_RETRY_POLICY })`. Only `buildPlanThreadId` was literally added to `agent/index.ts`, matching `buildDiscoveryThreadId`'s own home.
- `create_plan`'s `planId`/`ideaId`/`userId` all arrive via `config.configurable` (Design Notes) — `userId` isn't named in the Code Map's list but is logically required the same way (the `plans.userId` column, and the route's own ownership check have nowhere else to get it from a `plan:${planId}`-shaped thread id). Documented in `create_plan.ts`'s own doc comment.
- `get_current_step`'s agent-tool variant derives `planId` from the thread id (`derivePlanIdFromThreadId`, inverse of `buildPlanThreadId`) rather than via `config.configurable` — safe because, unlike `create_plan`, this tool only ever runs on an already-created plan's own thread.
- `StatusPanel`'s "timeline" is the current step's own `dayOffset` ("Day N"), not a list of other steps — there is no endpoint to read more than current+next from (AD-4), so a fuller timeline isn't buildable without a second read path this story's Boundary forbids.
- Narrow-screen collapse is pure Tailwind (`flex-col` default, `sm:flex-row` restores the sidebar) — no JS viewport detection; `StatusPanel`'s own markup is already compact enough to read as a "header" when stacked above the chat column.

## Spec Change Log

## Review Triage Log

- **A** (`verification-gap`) `src/agent/progress.ts:24`, `src/agent/progress.test.ts` — verdict: `low`. No test anywhere asserts `resolveToolStepKey('create_plan') === 'creating_plan'`; a typo'd/dropped registry entry would ship silently (UI falls back to the generic label). Route: patch.
- **B** (`verification-gap`) `web/src/features/ideas/IdeasPanel.tsx:3063-3067`, `IdeasPanel.test.tsx` — verdict: `low`. No existing test passes `onViewPlan`, so the "View plan" button's status gate and `onClick` wiring (the sole entry point into the new workspace) is dead code as far as verification is concerned. Route: patch.
- **C** (`verification-gap`) `web/src/features/plan-workspace/PlanWorkspace.tsx`, `StatusPanel.tsx` — verdict: `medium`. Zero test coverage at any level for the AC "only current+next step visible" and the plan-thread `ChatThread` endpoint wiring; a swapped current/next mapping or a mis-pointed chat endpoint would ship undetected. Route: patch.
- **D** (`edge-case-hunter`) `src/tools/llm/create_plan.ts` (`handleCreatePlan`'s idea re-check) — verdict: `low`. Confirmed: the re-check filters only on `ideaId`+`userId`, not `status` — if an idea's status flips away from `selected`/`bookmarked` between the route's check and the agent invocation, a plan is still created, violating the Boundary's "no eager plan creation for unselected/unbookmarked ideas." Narrow race window, non-destructive outcome, one-line fix. Route: patch.
- **E** (`edge-case-hunter`) `src/api/routes/plans.ts` (`POST /select/:ideaId`) — verdict: `medium`. Confirmed: two concurrent requests for the same idea with no existing plan both pass the "no existing plan" check and both invoke `create_plan`; the loser's transaction hits the `plans_idea_id_unique` constraint, throws, and the route reports a flat 502 "Plan could not be generated" even though the winner's plan was actually created. More likely given finding G (the triggering button isn't disabled while pending). Route: patch.
- **F** (`edge-case-hunter`) `src/api/routes/plan-chat.ts` (`assertPlanOwnership` callers) — verdict: `medium`. Confirmed: `.catch(() => false)` collapses *any* error — including a real transient Postgres failure — into an un-logged 404 "Plan not found," masking outages and inconsistent with `plans.ts`'s own try/catch-to-503 pattern for the same kind of check. Route: patch.
- **G** (`edge-case-hunter`) `web/src/features/ideas/IdeasPanel.tsx` (View plan button) — verdict: `low`. Confirmed: the three status buttons all have `disabled={pending}`; the new "View plan" button does not, so a user can navigate into a plan workspace for an idea whose status mutation is still in flight. Trivial fix. Route: patch.

## Design Notes

- **Failure-pattern sizing (my call, prompt-level):** epics.md only gives examples for `overwhelm` (more, smaller steps) and `gets_stuck_no_next_step` (pre-staged next action). For the other three: `loses_interest_once_routine` — vary step framing to sustain novelty; `life_disruption` — build timeline slack/buffer; `forgets_deprioritizes` — short, frequent, near-term-deadline steps. These are `create_plan`'s system-prompt instructions, easy to tune later, not a schema-level decision.
- **Why a direct `withStructuredOutput` call, not a nested agent:** generate_ideas's nested-agent approach exists because it needs `web_search`; `create_plan` needs no tools, so a single direct structured-output call is simpler and inherently satisfies "one attempt, no loop."
- **Why planId/ideaId come from `config.configurable`, never a model-supplied arg:** same trust boundary as `deriveUserIdFromThreadId` — the route resolves and owns these before invoking the agent; the model only supplies `replyLanguage` (mirrors `generateIdeasToolSchema`).
- **Pre-existing gaps noticed, not fixed here (out of 3.1's scope):** `TOOL_STEP_REGISTRY` is still empty for `web_search`/`generate_ideas` (2.2 never added them); `set_idea_status.ts` has no test file. Flagged as follow-ups, not fixed.

## Verification

**Commands:**
- `npm run test --workspace=shared` -- new schema tests pass
- `npm run test --workspace=src -- create_plan get_current_step plans` -- new tool/route tests pass (plus the one real-Postgres integration test for the one-plan-per-idea unique constraint)
- `npm run typecheck && npm run lint` -- clean
- `npm run build --workspace=web` -- PlanWorkspace compiles

**Manual checks (if no CLI):**
- Select an idea, open its workspace, confirm draft steps render, only current+next visible, narrow viewport collapses the sidebar.
