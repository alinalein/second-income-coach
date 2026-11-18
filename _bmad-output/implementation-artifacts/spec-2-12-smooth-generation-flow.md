---
title: 'Smooth Generation Flow + Workspace Follow-ups'
type: 'feature'
created: '2026-11-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context: []
baseline_commit: 'a777ed97432c6f346dd2bbcc14bf7e825780adee'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The intake→ideas→plan path flickers (an idle, enabled "Generate" button paints for one frame before auto-generation kicks in), restarts its progress bar at each stage, shows a literal "is being translated" banner, and the plan-review panel expands inline instead of as a modal, pushing the status column and chat down. Separately, the workspace follow-ups reported live: the chat card doesn't fill the viewport, the status panel's day label/next-step label are wrong, and starting a step gives no live, human chat acknowledgment.

**Approach:** Make saving→classifying→generating one continuous, never-restarting progress bar (seeded into the `generating` phase before first paint on the auto-generate path); give plan creation the same determinate-bar pattern; replace the idea-card translation banner with a per-field blur/shimmer-then-crossfade; turn `PlanActivationPanel`'s review into a modal reusing the existing `shadcn-glass-ui` `Dialog` (same pattern as the idea-select confirm dialog) and strip the doubled bullet marker at render time; fix the chat-card height chain through `FadeIn`/`PlanWorkspace`; move the day label above the step title and rename "Next (locked)" to "Next step"; and append one direct-model-call, non-agentic assistant acknowledgment to the plan thread when `start_step` succeeds, removing the now-duplicate "You've started this step." hint.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AC1 auto-generate mount | Intake saved, `IdeasPanel` mounts with `autoGenerate=true` | First paint already shows disabled/transparent button + visible progress bar at 0%, stage text starts at "classifying", one unbroken timer carries through to "generating" — no idle/enabled frame | Generate request fails/times out → existing `generate-error` phase, unchanged |
| AC1 manual generate | User clicks "Generate"/"Generate new" | Unchanged: single-stage bar at `TYPICAL_GENERATE_DURATION_MS`, no classify stage text | Unchanged existing error handling |
| AC2 plan creation | User confirms an idea selection | Determinate bar + stage text replaces the spinner screen from first paint, jumps to 100% then reveals plan | Existing fetch-error branch unchanged |
| AC3 translation | UI language switched, card translations in flight | Title/rationale/demand-note/growth-path show blurred/shimmer placeholder sized to avoid layout jump, then crossfade in; `aria-busy` on the affected block while translating; `prefers-reduced-motion` → no animation, instant swap | Failure → existing `failedLanguages` banner + retry button, unchanged |
| AC4 plan review modal | Plan in a review-needing phase (`reviewing`/`editing`/`rejecting`) | Renders inside `Dialog`/`DialogContent` with backdrop, confirm/edit/regenerate inside it; status column/chat never shift | Unchanged failure behavior inside the dialog |
| AC4 bullet marker | Step `description` entries that already start with `•`/`-`/`*`/`·` | `StatusPanel` and `PlanActivationPanel` strip the leading marker before rendering each `<li>` | N/A |
| AC6 chat height | Plan workspace shown on desktop width | Chat card fills to viewport bottom edge; status column keeps natural height; messages scroll inside the card, input pinned at its bottom | N/A |
| AC7 status labels | Status panel renders current/next step | Day label above the current step's title; next step labeled "Next step"/"Nächster Schritt" | N/A |
| AC8 start_step happy path | `start_step` succeeds | One direct (non-agentic) model call produces a short, motivating, non-punitive, user-language message; passes AD-11-equivalent + AD-12 checks; appended to the plan thread as an assistant message (survives reload); shown live in the open chat; "You've started this step." hint removed | Model call fails/flags/times out → start still returns success, no chat message is added, no error shown |
| AC8 start_step rejection | `start_step` called on a non-current step | Unchanged: tool rejects, no model call attempted | N/A |

</frozen-after-approval>

## Code Map

- `web/src/features/ideas/IdeasPanel.tsx:782-825,859-887,1086-1197` -- `autoGenerate` currently flashes an idle/enabled frame before `handleGenerate()` fires (effect-ordering gap: GET-ideas effect sets `phase('idle')`, paints, then the separate autoGenerate effect fires). Fix: when `autoGenerate` is true, initialize `phase` via lazy `useState` to `'generating'` and kick `handleGenerate()` from a mount-only effect, independent of the GET-ideas effect's `setPhase('idle')` (guard so that effect never clobbers an already-generating phase). Add `AUTO_GENERATE_TOTAL_DURATION_MS` (~38000: existing `TYPICAL_GENERATE_DURATION_MS`=35000 + ~3000 classify) and a stage-text switch (first ~3s renders a new `generatingStatusClassifying` key, rest renders existing `generatingStatus`) — only on the auto-generate path; manual generate/regenerate keeps `TYPICAL_GENERATE_DURATION_MS` and the single existing stage text. `DeterminateProgressBar`/button/footer markup (lines 231-255, 1325-1355) already support this with no structural change.
- `web/src/App.tsx:159-168 (FadeIn)` -- wraps every view in a plain auto-height `div`; must become `flex min-h-0 flex-1 flex-col` so `PlanWorkspace`'s `h-full`/`min-h-0` chain (lines ~104,121) resolves against `<main>`'s real viewport-bounded height instead of collapsing to content height. Harmless for non-workspace views (`main` already scrolls).
- `web/src/features/plan-workspace/PlanWorkspace.tsx:56-90 (fetch effect)`, `109-119 (spinner block)`, `135-136 (status column wrapper)`, `141 (chat column)`, `125-127 (PlanActivationPanel mount)` -- replace the "Setting up your plan…" spinner with a local determinate-bar component (same shape as `IdeasPanel`'s `DeterminateProgressBar`, `TYPICAL_PLAN_DURATION_MS`≈10000, same hold-at-90/jump-to-100 timer pattern) driven by the existing select-fetch effect. Add `sm:self-start` to the status-column wrapper so the row's `items-stretch` lets only the chat column stretch to full row height.
- `web/src/features/plan-workspace/PlanActivationPanel.tsx:404-440 (review render)`, bullet rendering ~`418-422` -- wrap the review/editing/rejecting branches in `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` from `'shadcn-glass-ui'`, same import/usage as `IdeasPanel.tsx:23,1360-1375`; apply a shared `stripLeadingBulletMarker` helper to each `description` item before rendering.
- `web/src/features/plan-workspace/StatusPanel.tsx:97-108 (day label/description order)`, `102-106 (bullet render)`, `116 (nextLabel)` -- move day label above `step.current.title`; apply `stripLeadingBulletMarker`; `nextLabel` string value changes (no key rename).
- `web/src/features/plan-workspace/StepActions.tsx:40-49 (start success handler)`, `93 (startedHint render)` -- remove the `startedHint` paragraph; on start success, parse `chatMessage` from the response and call a new `onStepStarted` prop (separate from `onStepChanged`, which `complete()` must not trigger).
- `web/src/chat/ChatThread.tsx:376 (root Card)` -- unaffected structurally; receives a new optional `incomingMessage` prop + small effect to append it into local state if not already present (id-guarded).
- `src/tools/plain/start_step.ts` -- unchanged (stays a pure deterministic write per AD-4).
- `src/api/routes/plans.ts:1 (randomUUID import)`, `221 (detectUserReplyLanguage)`, `229-246 (existing direct-call + updateState append pattern for plan-creation's welcome message — mirror exactly)`, `369-395 (`/:planId/steps/:stepId/start` handler)` -- after `startStep` succeeds, run one direct `model.invoke` (plain text, not structured output) in the detected reply language, check it via `evaluateAssistantMessage` (`src/agent/moderation.ts:175-192`) and a new small plain guilt-language check built on exported `containsGuiltLanguage` (`src/agent/guilt-language.ts:55-57`; the existing middleware isn't directly callable) — on any failure/flag/timeout, omit the chat message entirely (no retry loop, no error). On success, append via `agent.updateState(...)` into `buildPlanThreadId(planId)` (same mechanism `GET /:planId/messages` already reads) and include the message in the JSON response.
- `shared/schemas/check-ins.ts:48-50 (startStepResponseSchema)` -- extend with an optional `chatMessage: chatMessageSchema` field (reuse `shared/schemas/index.ts:78-88`'s `chatMessageSchema`).
- `web/src/locales/{de,en}/ideas.json` -- add `generatingStatusClassifying`. `web/src/locales/{de,en}/plan.json` -- add plan-creation stage-text key(s); change `statusPanel.nextLabel` value; `stepActions.startedHint` left unused (not deleted, to avoid touching unrelated i18n key-coverage tests).
- Test touch points: `IdeasPanel.test.tsx`, `StatusPanel.test.tsx` (existing "Next (locked)" assertions), `PlanActivationPanel.test.tsx`, `PlanWorkspace.test.tsx`.

## Tasks & Acceptance

**Execution:**
- [x] `web/src/features/ideas/IdeasPanel.tsx` -- seed `phase` to `'generating'` on the auto-generate path and decouple it from the GET-ideas idle flash; add the classify→generate stage-text/duration split for that path only -- AC1
- [x] `web/src/features/ideas/IdeaEvidence.tsx` + `IdeasPanel.tsx` (`IdeaCard`) -- replaced the `translating` banner with per-field shimmer placeholders (title/rationale/demandEvidenceNote/growthPath), crossfade, `aria-busy`, reduced-motion guard -- AC3
- [x] `web/src/features/plan-workspace/PlanWorkspace.tsx` -- determinate progress bar + stage text for plan creation; `sm:self-start` on the status column -- AC2, AC6
- [x] `web/src/App.tsx` (`FadeIn`) -- pass through flex height to children -- AC6
- [x] `web/src/features/plan-workspace/PlanActivationPanel.tsx` -- modalized review/editing/rejecting/busy/failed-with-review via `Dialog`; strip leading bullet markers -- AC4
- [x] `web/src/features/plan-workspace/StatusPanel.tsx` -- day label above title; bullet strip; "Next step"/"Nächster Schritt" -- AC4, AC7
- [x] `web/src/features/plan-workspace/StepActions.tsx`, `ChatThread.tsx`, `PlanWorkspace.tsx` -- removed `startedHint`; threaded `onStepStarted`/`incomingMessage` to show the new chat message live -- AC8
- [x] `src/api/routes/plans.ts`, `shared/schemas/check-ins.ts` -- one direct model call + moderation/guilt check + thread append on start-step success, fail-open to no-message -- AC8
- [x] `web/src/locales/{de,en}/{ideas,plan}.json` -- new/changed keys (AD-24) -- AC1, AC2, AC7
- [x] Tests (table-driven): one per AC above, bullet-strip edge cases and the model-call-fails-silently branch as `it.each` rows within the AC8 test -- all ACs

**Acceptance Criteria:**
- Given the intake form is saved, when the ideas view mounts, then no frame shows an idle/enabled "Generate" button or a hidden progress bar, and the bar never resets between the classify and generate stages
- Given a plan is being created, when the request is in flight, then the same determinate bar/stage-text pattern as idea generation is shown, jumping to 100% then revealing the plan
- Given the UI language changes, when cards are mid-translation, then no "is being translated" text appears anywhere and the affected fields shimmer-then-crossfade with no layout jump
- Given a plan needs review, when `PlanActivationPanel` opens, then it is a backdropped modal that never pushes the status column or chat, and step descriptions render exactly one bullet per item
- Given the plan workspace is shown on desktop, when rendered, then the chat card's bottom edge matches the viewport's bottom edge while the status column keeps its own height
- Given the status panel renders the current step, when shown, then the day label sits above the title, and the next step says "Next step"/"Nächster Schritt"
- Given `start_step` succeeds, when the model call that produces the acknowledgment fails or times out, then the step start still succeeds and no chat message or error appears

## Implementation Notes

- AC1: `IdeasPanel`'s `phase`/`generatingStage` now lazy-init from `autoGenerate`, so first paint is never an idle/enabled frame regardless of when the GET/auto-fire effects actually settle. The auto-fire effect waits for `initialLoadSettled` (set once `GET /api/ideas` resolves either way) before deciding whether to fire — this both avoids the idle frame *and* keeps Story 2.11's "never auto-fire into a known-blocked limit" rule intact (review fix; an earlier draft of this change had dropped that guard — see Review Triage Log).
- AC8: found and fixed a pre-existing-pattern-but-newly-triggered circular-import bug — `shared/schemas/check-ins.ts` importing `chatMessageSchema` back from `./index.js` (mirroring `progress.ts`'s own existing import) threw `TypeError: Cannot read properties of undefined (reading 'optional')` at module-eval time (confirmed via a native Node ESM repro; reordering the `export *` statements in `index.ts` did not help). Root-caused to `check-ins.ts`/`progress.ts` both synchronously *using* (not just referencing) the binding at their own module top level while mid-cycle. Fixed by extracting `messageCostSchema`/`chatMessageSchema` into a new, dependency-free `shared/schemas/chat.ts`; `index.ts`, `check-ins.ts`, and `progress.ts` all now import it directly, eliminating the cycle for both files (not just the new one).
- AC8 model-call timeout/budget: `START_STEP_ACK_TIMEOUT_MS = 10_000` (final value, after the review-fix round's 20s->10s tightening below) — an estimate (no live measurement available in this environment) scaled down from `translate-idea-cards.ts`'s `TRANSLATE_TIMEOUT_MS` (30s) since this is plain text, no structured output, and it's awaited inside the same HTTP response as the step-start result.
- Orchestrator verification (step-03): the I/O matrix's "AC6 chat height" row had no dedicated covering test — the `sm:self-start`/height-chain classes were correct in the diff but unasserted. Added one test to `PlanWorkspace.test.tsx` (class-level assertion: status column carries `sm:self-start`, the chat column doesn't and carries `flex-1`) to close the matrix-audit gap; jsdom has no real layout engine so an actual pixel-height assertion isn't possible here. All other matrix rows were already covered by the dispatched implementation's own tests.
- PlanActivationPanel's Dialog: `onOpenChange={() => undefined}` — Escape/backdrop-click/the Dialog's own close control do nothing; the modal closes only via the in-dialog Confirm/Edit/Reject/Cancel buttons, since there's no safe "cancel the whole review" fallback.

## Spec Change Log

(none — implemented as written)

## Review Triage Log

`code-review` (medium effort) ran against the full diff. 6 findings, triaged:
- Fixed: `start_step`'s reply-language detection read the plan thread instead of the discovery thread (every other call site's convention) — a German user who hadn't yet typed into this specific plan's chat would get an English acknowledgment. Now uses `buildDiscoveryThreadId(userId)`.
- Fixed: the auto-generate mount-only effect had dropped Story 2.11's "never auto-fire into a known-blocked limit" guard. Restored via a new `initialLoadSettled` flag so the auto-fire effect waits for `GET /api/ideas`'s `generateLimit` before deciding, without reintroducing the idle-frame bug (`phase` is still pinned at `'generating'` from first paint the whole time it waits). Added a regression test.
- Tightened (not a bug, a judgment call): `START_STEP_ACK_TIMEOUT_MS` 20s -> 10s — the ack is awaited inside the same HTTP response as the step-start result (per spec), so this is also the worst-case extra latency a "Start" click can add.
- Extracted (polish): `prefersReducedMotion()` was reimplemented inline in both `ChatThread.tsx` and `IdeaEvidence.tsx`'s new `TranslatingBlock` — moved to one shared export in `web/src/lib/utils.ts`.
- Deduped (polish): the `generatingStage === 'classifying' ? ... : ...` ternary was repeated at two JSX call sites in `IdeasPanel.tsx` — computed once as `generatingStatusLabel`.
- Declined: "no fallback hint when the chat acknowledgment fails to arrive" (`StepActions.tsx`) — the spec's own Code Map explicitly calls for removing `stepActions.startedHint` unconditionally, accepting the chat acknowledgment as the sole confirmation going forward; re-adding a fallback would reintroduce the "now-duplicate" hint the spec explicitly removes. Left as specified.

Orchestrator note: this build's own instructions capped review depth explicitly ("no review pass for the layout/progress parts; one reviewer only for the start-route change") — this matches CLAUDE.md's "Review depth" rule exactly. The pass above already satisfies that one-reviewer requirement for the `src/api/routes/plans.ts` AC8 change (model call + thread append). The generic 3-layer step-04 review (blind-hunter/edge-case-hunter/verification-gap over the full diff) was therefore not run — running it would have re-reviewed the layout/progress-bar/shimmer/modal portions this build was explicitly told to leave unreviewed.

## Verification

**Commands run (after the review-fix round + orchestrator's AC6 matrix-audit fix; final state):**
- `npm run typecheck` (root, all 3 workspaces) -- all clean
- `npm run lint` (root, `eslint .`) -- clean
- `npm run test` (root, full suite) -- shared 41 + src 460 + web 120 = **621 tests passed**, 0 failed
- Diff staged and read against `baseline_commit`; every `## Tasks & Acceptance` checkbox and AC confirmed against the actual diff, not just the implementer's report
- I/O & Edge-Case Matrix: every row confirmed covered by a passing test (AC6 row's gap closed by the orchestrator, see Implementation Notes)
