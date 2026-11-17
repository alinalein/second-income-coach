---
title: 'Guided Flow from Intake to Plan'
type: 'feature'
created: '2026-11-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'feeaecaa244c8b92aff617902791859b278bf397'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After intake, the user must manually click to generate ideas even on their very first run; the ideas panel gives no instructions on what to do with the 5 cards; "Select" changes status and silently creates a plan with no warning or way back; "View plan" shows on every selected/bookmarked card even when no plan exists yet.

**Approach:** Auto-fire idea generation once, right after the first successful intake submit (never on a later page load); add a short translated instruction line under the ideas heading; gate "Select" behind a confirm/cancel dialog (shadcn-glass-ui's `Dialog`) that only on confirm sets the idea `selected` and lazily creates its plan (3.1's `POST /api/plans/select/:ideaId`) before opening the plan workspace; restrict "View plan" to the selected idea's card, and only once it actually has a plan (a new `hasPlan` flag computed server-side from the existing `plans` table — no migration, no touch to `generate_ideas`/`create_plan`).

## Boundaries & Constraints

**Always:**
- Reuse the existing `set_idea_status` (Story 2.3) and `POST /api/plans/select/:ideaId` (Story 3.1, lazy `create_plan`) endpoints exactly as they are — no new backend write path.
- `POST /api/plans/select/:ideaId` 404s unless the idea's status is already `selected`/`bookmarked` (`src/api/routes/plans.ts:128`) — the status update must complete before any plan-create call.
- Keep `shared/schemas/ideas.ts`'s existing `ideaResponseSchema`/`IdeaResponse` (and `src/tools/llm/generate_ideas.ts`'s `toIdeaResponse`) untouched — `generate_ideas.ts` is frozen for this story.
- Use `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` imported from `shadcn-glass-ui` (already a dependency; ships `ModalGlass` under shadcn-compatible aliases, built on `@radix-ui/react-dialog`) for the confirmation — no new package.
- Keep every existing shadcn-glass-ui/local `Button`/`Badge`/`Card` component and glass styling (UX-DR3); do not restructure `IdeaCard`'s rationale/title block (Lane B, Story 2.7, is actively changing that).

**Never:**
- Never call `set_idea_status` or the plan-select endpoint except from the confirm handler.
- Never auto-trigger `POST /api/ideas/generate` on a page load/reload where ideas already exist or where intake already existed before this session's submit.
- Never show "View plan" for a `bookmarked`/`suggested`/`rejected` idea, or for a `selected` idea with no plan yet.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First-ever intake submit | `hasIntake` was `false` right before a successful `IntakeForm` save | `IdeasPanel` mounts, auto-fires generation once (no ideas yet), shows the existing generating progress bar | `POST /api/ideas/generate` fails -> existing `generate-error` badge; button stays for manual retry |
| Returning user, intake only | `hasIntake` already `true` at load (no submit this session) | `IdeasPanel` shows the "Generate my 5 ideas" button; no auto POST | N/A |
| Returning user with ideas | `ideas.length > 0` at load | Ideas render directly; no generate call | N/A |
| Select -> Confirm | Dialog confirmed for idea `X` | `set_idea_status(X, 'selected')` succeeds, then `POST /api/plans/select/X` runs via `onViewPlan`/`PlanWorkspace`'s existing lazy-create + loading state | Status POST fails -> existing `statusUpdateFailed` banner + optimistic revert; no navigation |
| Select -> Cancel | Dialog open, Cancel clicked | Dialog closes; no status call, no plan call | N/A |
| Status ok, plan create fails | Idea is now `selected`; `PlanWorkspace`'s own `loadFailed` shows | User clicks "Back to ideas"; idea's card still shows `selected` + "Select" (no "View plan", since `hasPlan` is still `false`) | Clicking "Select" again reopens the dialog and retries |
| Card `hasPlan` rendering | `status==='selected' && hasPlan===true` | "View plan" shows | Any other status, or `selected` with `hasPlan===false` -> hidden |

</frozen-after-approval>

## Code Map

- `web/src/App.tsx:177-265` -- `App()`; add `const [autoGenerateIdeas, setAutoGenerateIdeas] = React.useState(false)`. In `IntakeForm`'s `onSaved` (line 241-246), read `hasIntake` (closure, pre-update value) before calling `setHasIntake(true)`: if it was `false`, this is the first-ever submit -> `setAutoGenerateIdeas(true)`. Pass `autoGenerate={autoGenerateIdeas}` to `<IdeasPanel>` (line 252).
- `web/src/features/ideas/IdeasPanel.tsx:716-720` -- `IdeasPanelProps`; add `autoGenerate?: boolean`.
- `web/src/features/ideas/IdeasPanel.tsx:722-776` -- `IdeasPanel()`; add a `useRef(false)` fired-guard + one `useEffect` that calls `handleGenerate()` exactly once when `phase === 'idle' && ideas.length === 0 && autoGenerate && !firedRef.current` (set the ref before calling, so a re-render never double-fires).
- `web/src/features/ideas/IdeasPanel.tsx:4-13,722-776` -- swap `ideasResponseSchema`/`IdeaResponse` for two new schemas added to `shared/schemas/ideas.ts` (see below); `ideas` state becomes `IdeaWithPlanResponse[]`.
- `web/src/features/ideas/IdeasPanel.tsx:791-834` -- `handleSetIdeaStatus`; extract the fetch body into `postIdeaStatus(ideaId, status): Promise<boolean>` (same optimistic-update/revert/`pendingIdeaIds` logic, just returns success instead of being fire-and-forget). `handleSetIdeaStatus` becomes a thin wrapper (`void postIdeaStatus(...)`) for Bookmark/Reject, which keep their current direct-call behavior.
- `web/src/features/ideas/IdeasPanel.tsx:884-888` -- `CardHeader`; add a translated paragraph (`t('explanation')`) under `CardTitle`, rendered only when `ideas.length > 0`.
- `web/src/features/ideas/IdeasPanel.tsx:654-703` -- `IdeaCard`'s actions block: "Select" button's `onClick` changes from `onSetStatus(idea.id, 'selected')` to a new `onRequestSelect(idea)` prop (opens the dialog, does not call status directly). "View plan" condition changes from `idea.status === 'selected' || idea.status === 'bookmarked'` to `idea.status === 'selected' && idea.hasPlan`.
- `web/src/features/ideas/IdeasPanel.tsx` (new, panel-level, rendered once) -- `confirmIdea` state (`IdeaWithPlanResponse | null`); one `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` (imported from `'shadcn-glass-ui'`) driven by it. Confirm handler: close dialog, `await postIdeaStatus(idea.id, 'selected')`; on success call `onViewPlan?.(idea.id, idea.title)` (navigates to `PlanWorkspace`, which already lazily creates the plan via `POST /api/plans/select/:ideaId` on mount and already shows its own "Setting up your plan…" loading state and neutral `loadFailed` error — `web/src/features/plan-workspace/PlanWorkspace.tsx:39-63`); on failure, do nothing further (existing `statusUpdateFailed` messaging already covers it).
- `shared/schemas/ideas.ts:253-319` -- add, after `ideaResponseSchema`/`ideasResponseSchema`: `export const ideaWithPlanResponseSchema = ideaResponseSchema.extend({ hasPlan: z.boolean().default(false) })`, `export const ideasWithPlanResponseSchema = z.object({ ideas: z.array(ideaWithPlanResponseSchema), currency: currencyCodeSchema })`, `export type IdeaWithPlanResponse = z.infer<typeof ideaWithPlanResponseSchema>`. `.default(false)` keeps every existing fixture/response that omits the field parseable.
- `src/api/routes/ideas.ts:1-14,97-112,143-210` -- import `plans` and `ideasWithPlanResponseSchema`; add a small helper `attachHasPlan(db, userId, records)` that selects `plans.ideaId` for that `userId`, builds a `Set`, and maps `records.map((idea) => ({ ...idea, hasPlan: set.has(idea.id) }))`. Call it in `GET /` (on `visibleRecords`) and `POST /generate` (on `visibleAfter`) before `res.json(ideasWithPlanResponseSchema.parse({ ideas: ..., currency }))`. `plans.ideaId` is already a unique FK (`src/db/schema/plans.ts:20-23`) — no migration.
- `src/api/routes/ideas.test.ts` -- extend the `GET /` describe block with one real-Postgres case asserting `hasPlan` per idea.
- `web/src/locales/en/ideas.json`, `web/src/locales/de/ideas.json` -- add `explanation` and `confirmSelect.{title,description,confirm,cancel}`.
- `web/src/features/ideas/IdeasPanel.test.tsx:314-347` -- the Story 3.1 "View plan" describe block tests the now-superseded `selected`/`bookmarked` condition; rewrite for the `hasPlan`-gated rule (see Tasks).
- `web/src/App.test.tsx:153-198` -- the first-submit test's fetch mock has no `/api/ideas/generate` entry; once auto-generate fires in that code path, add that mock (returning a small ideas fixture) or the test throws on the unmocked call.

## Tasks & Acceptance

**Execution:**
- [x] `shared/schemas/ideas.ts` -- add `ideaWithPlanResponseSchema`/`ideasWithPlanResponseSchema`/`IdeaWithPlanResponse` -- AC5
- [x] `src/api/routes/ideas.ts` -- `attachHasPlan` helper; wire into `GET /` and `POST /generate` responses -- AC5
- [x] `src/api/routes/ideas.test.ts` -- real-Postgres case: idea with an existing `plans` row reports `hasPlan: true`; one without reports `false` -- AC5
- [x] `web/src/App.tsx` -- `autoGenerateIdeas` state, set only on a true first-ever submit, passed to `IdeasPanel` -- AC1
- [x] `web/src/features/ideas/IdeasPanel.tsx` -- `autoGenerate` prop + fire-once effect; `postIdeaStatus` extraction; explanation paragraph; confirm dialog + `onRequestSelect`; `hasPlan`-gated "View plan" -- AC1/AC2/AC3/AC4/AC5/AC6
- [x] `web/src/features/ideas/IdeasPanel.test.tsx` -- update View-plan tests for the new gating; add explanation-text test; add select-confirm-dialog tests (confirm->navigate, cancel->no-op, status-write failure->no navigation, stays selected) -- AC2/AC3/AC4/AC5
- [x] `web/src/App.test.tsx` -- extend the first-submit test to mock `/api/ideas/generate` and assert it fires with no extra click -- AC1
- [x] `web/src/locales/en/ideas.json`, `web/src/locales/de/ideas.json` -- new `explanation`/`confirmSelect.*` keys -- AC2/AC3

**Acceptance Criteria:**
- AC1: Given a user submits intake for the first time, when the save succeeds, then idea generation starts automatically with the existing progress display, no extra click; a returning user with ideas goes straight to them; a returning user with intake but no ideas sees the existing generate button, not an auto-trigger.
- AC2: Given the ideas are shown, when the user looks under the "Your tailored income ideas" heading, then a short localized (DE+EN) explanation tells them to choose, reject, or generate new ideas.
- AC3: Given the user presses "Select", when triggered, then a confirmation dialog states the idea becomes their chosen one and the rest stay as bookmarks; cancel changes nothing.
- AC4: Given the user confirms, when the plan has been generated, then the plan workspace opens with the draft plan and chat; a failure shows a neutral error and keeps the idea selected so the user can retry from the card.
- AC5: Given an idea has no plan, when its card renders, then it shows no "View plan"; only the selected idea's card, once it has a plan, links to it.
- AC6: Given the ideas are loaded, when the explanation renders, then no blank band remains under the heading.

## Implementation Notes

- `ideaResponseSchema.extend({ hasPlan: z.boolean().default(false) })` works cleanly in Zod v4 even though `ideaResponseSchema` has a trailing `.superRefine` — confirmed directly (`.extend` preserves the refinement and the result still parses/defaults correctly) before relying on it.
- The Task bullet for `IdeasPanel.test.tsx` said "plan-create failure->no navigation"; at the `IdeasPanel` level there's nothing to simulate there — plan creation itself happens inside `PlanWorkspace`, out of this story's scope. The test instead exercises the one failure branch `IdeasPanel` actually owns: the confirm handler's own `postIdeaStatus('selected')` call failing (I/O matrix's "Select -> Confirm" error row) -- no navigation, `statusUpdateFailed` banner, optimistic revert, "Select" still clickable to retry.
- 3 pre-existing tests (`AC1/AC2: optimistic status update`, both `status actions disable panel-wide` tests) clicked "Select" expecting an immediate status POST -- updated each to also click the dialog's "Yes, select this idea" confirm button, since "Select" itself now only opens the dialog (Boundary: status writes only from the confirm handler).
- Post-review patches (edge-case-hunter pass): `web/src/App.tsx`'s `onCurrencyChange` now also resets `autoGenerateIdeas` to `false` (a currency change before the first auto-generated batch exists remounts `IdeasPanel` via `key={ideasCurrencyKey}`, and without this the fresh mount could fire a second, unrequested `generate_ideas` call); `IdeasPanel.tsx`'s `handleConfirmSelect` now guards its `onViewPlan` call with `isMountedRef.current` (a stale-closure navigation after an unmount mid-flight). Both verified in the diff and re-tested; full suite green after.
- Bug fix (user-reported, live, screenshot): the pre-existing discovery `ChatThread` (Story 1.3) was still rendered directly below `IdeasPanel` on the ideas screen — visible while ideas were generating/displayed, contradicting this story's own "never see actions that don't apply yet." Removed from `App.tsx`'s ideas-view branch entirely; the chat the user meant ("later, when they start working on one of the ideas") is `PlanWorkspace`'s own plan-thread `ChatThread`, already there and untouched. Updated the 2 `App.test.tsx` assertions that checked for the chat textbox on this screen to check for the ideas heading instead; full `web` suite re-verified green (71/71) after.

## Spec Change Log

## Review Triage Log

- **low (rejected)** — "Initial `GET /api/ideas` failing leaves `phase` at `load-error`, never `idle`, so the auto-generate effect never fires for a first-time user whose first load fails." Verified: the effect's guard is `phase === 'idle' && ...` (`IdeasPanel.tsx`), confirmed no path from `load-error` back to `idle` without a full reload. Real but unlikely (a transient failure on the one request right after signup) and already degrades to the existing, pre-this-story manual "Generate" button + `error.loadFailed` badge — the same fallback every other load failure in this panel already uses. Fix would mean adding retry-then-auto-generate logic, more than a direct correction. (edge-case-hunter) → **rejected**
- **medium** — "Changing currency (Settings) before the first auto-generated batch exists remounts `IdeasPanel` via `App.tsx`'s `key={ideasCurrencyKey}`; `autoGenerateIdeas` is never reset, so the fresh mount's own `autoGenerateFiredRef` re-fires `handleGenerate()` a second time." Verified: `autoGenerateIdeas` (`App.tsx`) has no reset path, `SettingsPage`/`ChatThread`/`IdeasPanel` all render on the same screen simultaneously (Code Map's own App.tsx layout), so a user reasonably can reach Settings while generation is still pending or has just failed. Real harm: an unrequested second cost-bearing `generate_ideas` call (AD-30), not just a UI quirk. → **patch**: reset `autoGenerateIdeas` to `false` in `App.tsx`'s `onCurrencyChange` callback (the same place `ideasCurrencyKey` already increments) — no new prop, no new state, one line.
- **low** — "`handleConfirmSelect` calls `onViewPlan?.(idea.id, idea.title)` with no `isMountedRef.current` check; if `IdeasPanel` unmounts (e.g. the user clicks the still-visible 'Revisit intake' link) while `postIdeaStatus`'s fetch is in flight, it resolves after unmount and still calls `onViewPlan`, silently switching `App` to `PlanWorkspace` instead of the intake form the user just asked for." Verified: `postIdeaStatus`'s success branch returns `true` unconditionally (unlike its failure branch, which already checks `isMountedRef.current`); `handleConfirmSelect` awaits it and calls `onViewPlan` with no mount check at all. Narrow race (two contradictory actions within one fetch round-trip) but the fix is a direct one-line guard, same pattern already used three times in this same file — does not meet the "fix is more than a direct correction" bar for rejecting a low finding. (edge-case-hunter) → **patch**: guard the `onViewPlan?.()` call in `handleConfirmSelect` with `isMountedRef.current`.
- **false** — "Demoting a `selected` idea (by selecting a different one) makes its existing plan permanently unreachable from the UI, since 'View plan' is now gated to `status === 'selected'` only." Checked: `POST /api/plans/select/:ideaId` returns the *existing* plan row (no re-creation) whenever one is already present (`plans.ts`'s `existingPlan` check) — re-selecting that same (now-`bookmarked`) idea via the same confirm dialog sets it back to `selected` and `onViewPlan` then opens its already-existing plan. Not permanent; this is exactly the re-select-to-switch path epics.md's own Story 2.8 AC7 names ("switching ... reuses the same select-and-confirm dialog"). (edge-case-hunter) → **rejected**
- **false** — "AC4's 'a failure... keeps the idea selected so the user can retry from the card' is contradicted by `postIdeaStatus`'s failure branch, which reverts the optimistic status change instead of keeping it `selected`." Checked against the frozen I/O matrix (same spec section as AC4): the matrix's "Select -> Confirm" error row explicitly specifies "`statusUpdateFailed` banner + optimistic revert" for a status-POST failure — AC4's "keeps the idea selected" line is about the *other* row ("Status ok, plan create fails"), where the status write already succeeded and there is nothing to revert. A reverted idea still shows its unconditionally-rendered "Select" button, so "retry from the card" holds either way — confirmed by the new "status write fails" test. (edge-case-hunter) → **rejected**

## Design Notes

- **Why navigate immediately after the status update, instead of waiting for plan creation inside the ideas panel:** `PlanWorkspace` already lazily creates-or-fetches the plan on mount and already has its own "Setting up your plan…" loading state and neutral `loadFailed` error (`PlanWorkspace.tsx:39-87`) — re-implementing that wait inside `IdeasPanel` would duplicate both the network call pattern and the loading UI for no behavioral gain. "The plan workspace opens with the draft plan" (AC4) reads as the screen opening once confirmed, with its own existing lazy-load covering the wait, exactly like Story 3.1's "View plan" already behaves.
- **Why "Select" stays clickable (and reopens the dialog) even once an idea is already `selected`:** it is the only way to retry a plan-creation failure "from the card" (AC4) without new per-card UI — confirming again is a harmless no-op status write, then retries the plan-create call.
- **Why `hasPlan` is computed in `ideas.ts`, not `generate_ideas.ts`:** the Boundary against touching the idea-generation backend is about the LLM-backed write path; `GET /`/`POST /generate`'s own response shaping already lives in `ideas.ts` (e.g. the existing `status !== 'rejected'` filter) and is the right layer for a derived, read-only join against `plans`.

## Verification

**Commands:**
- `npm test --workspace=src -- ideas` -- expected: new `hasPlan` case passes, no regression
- `npm test --workspace=web -- ideas` -- expected: updated/new IdeasPanel tests pass
- `npm test --workspace=web -- App` -- expected: updated App test passes
- `npm run typecheck && npm run lint` -- expected: clean across `shared`/`src`/`web`
