---
title: 'Bookmark and Reject Ideas'
type: 'feature'
created: '2026-11-16'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '0a90c6028fba618029ba975ab57d6a2c502830f7'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/layout-preview.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.2 only generates and displays ideas; there is no way to select the one to pursue, keep the rest as backups, or discard ones that don't fit — and the ideas panel also flashes "no ideas yet" for ~0.2s on first load, and renders German card labels/rate formatting too verbosely to stay aligned across cards.

**Approach:** Add `set_idea_status` (plain-code, AD-4) + `POST /api/ideas/:id/status`; add Select/Bookmark/Reject actions + a status badge to each idea card, reproducing `layout-preview.html`'s "Ideas List — cards" section; replace the loading text with a height-reserving skeleton; rework the baseline-rate line and two German labels into a fixed label/value column layout.

## Boundaries & Constraints

**Always:**
- `set_idea_status` is plain-code and deterministic — never agent-registered, never LLM-invoked (AD-4). Reachable only via `POST /api/ideas/:id/status`, same boundary precedent as `set_personality`/`set_model`/`set_ui_language` (`src/tools/plain/`, `src/api/routes/settings.ts`).
- Selecting idea X is one DB transaction: X → `selected`, every *other* idea owned by the same user whose status isn't already `rejected` → `bookmarked`. A `rejected` idea is never resurrected by someone else being selected.
- `GET /api/ideas` excludes `status === 'rejected'` from its response (filtered in the route handler, not in `getIdeasByUserId`).
- Select/Bookmark/Reject render directly on every card, both languages, matching `layout-preview.html`'s card layout (status badge + 3-button row; the button matching current status is visually primary).
- Every new user-facing string ships in both `en`/`de` (AD-24).

**Never:**
- Do not edit `src/tools/llm/generate_ideas*`, moderation/search code, intake files, `src/config/env.ts`'s currency keys, `shared/money.ts`, chat/auth files, `scripts/`.
- No DB migration: `ideas.status` is already plain `text()` covering all 4 values; no enum/check constraint is added — the one-`selected`-per-user rule lives only in `set_idea_status`'s transaction (same no-DB-constraint precedent as the rest of this table).
- Do not add `set_idea_status` to `src/agent/index.ts`'s `tools:` array.
- Do not change `shared/schemas/ideas.ts` — `ideaStatusSchema` already has `suggested|selected|bookmarked|rejected`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Select one of several | 5 ideas (`suggested`), `POST /:id/status {selected}` on #1 | #1 → `selected`; #2-5 → `bookmarked` | N/A |
| Select preserves an existing reject | #3 already `rejected`, #1 selected | #1 → `selected`; #3 stays `rejected` (not resurrected) | N/A |
| Reject hides, persists | `POST /:id/status {rejected}` | Removed from this and every later `GET /` response | N/A |
| Unknown or foreign idea id | id doesn't exist, or belongs to another user | No row changes | 404 `{error}` |
| Invalid status value | body `{status:"suggested"}` or garbage | No row changes | 400 `{error}` |
| First load, fetch pending | `GET /api/ideas` in flight | Neutral fixed-height skeleton, never the "no ideas yet" text | N/A |

</frozen-after-approval>

## Code Map

- `src/tools/plain/set_ui_language.ts` (whole file) + `src/db/settings-repository.ts:50-57` — exact plain-tool/DI-free shape to mirror: a plain async function taking `(db, userId, ...)`, no agent wrapping.
- `src/api/routes/settings.ts:65-82` — `UnselectableModelError`-style custom error class mapped to a specific status code in the route's `try/catch`; mirror for a new `IdeaNotFoundError` → 404.
- `src/db/auth-repository.ts:30-63` — `db.transaction(async (tx) => {...})` pattern to mirror for the select/demote transaction.
- `src/db/schema/ideas.ts:49-74` — `status: text('status').notNull().default('suggested')`, no unique/check constraint; `userId` non-unique FK.
- `src/api/routes/ideas.ts:90-100` — `GET /` handler; add a `.filter((idea) => idea.status !== 'rejected')` before `ideasResponseSchema.parse`. `getIdeasByUserId` (imported from `src/tools/llm/generate_ideas.ts:946-949`) stays untouched — do not edit that file.
- `src/api/routes/ideas.ts:102-163` — `POST /generate`'s own regenerate-detection filters `status === 'suggested'` only; unaffected by the new rejected-filter on `GET /`.
- `web/src/features/ideas/IdeasPanel.tsx:146-175` — `BaselineRateDisplay`: currently renders `{formatMoney} {unitLabel}` then both estimate+vendor badges beside it. Restructure: compact suffix glued with no space, estimate badge moves out (into the label cell), vendor badge stays beside the value.
- `web/src/features/ideas/IdeasPanel.tsx:291-329` — the 4 (or 5, with monthly potential) stat rows, each `<div className="flex items-center justify-between gap-3">`; existing tests (`IdeasPanel.test.tsx:68-69,142`) locate a row via `screen.findByText(label).closest('div')` — keep this one-div-per-row structure; only fix the label cell to a shared fixed width (e.g. `w-36 shrink-0`) instead of auto-width, so values start at a consistent x-position regardless of label length/language.
- `web/src/features/ideas/IdeasPanel.tsx:363-407,463,483-485` — `phase`/loading logic; the "no ideas yet" `<p>` is already gated on `phase === 'idle' && ideas.length === 0`, mutually exclusive with `phase === 'loading'` in the code as it reads today. Replace the `phase === 'loading'` plain-text line with a skeleton; this removes the flash regardless of its exact cause.
- `web/src/features/ideas/IdeasPanel.tsx:246-265` — `IdeaCard`'s `CardHeader`; add a status badge above `CardTitle` (wireframe order: badge, then title), only when `idea.status !== 'suggested'`.
- `web/src/features/ideas/IdeasPanel.tsx:342-350` — `CardFooter`; append a 3-button action row below the existing citation row (same subgrid row 5 — `CardFooter` is already `flex flex-col`, so adding a second stacked block doesn't need a new subgrid track).
- `web/src/components/ui/button.tsx` / `badge.tsx` — `Button` variants `default|outline|ghost`, sizes `default|sm|lg`; `Badge` variants `default|muted|outline`. Use `default` for the status-matching action/badge, `outline`/`muted` otherwise.
- `web/src/locales/{en,de}/ideas.json` — current full key sets (read in full already); add `status.{selected,bookmarked,rejected}`, `actions.{select,bookmark,reject}`, `error.statusUpdateFailed`, `card.rateUnitSuffix.{hour,project,month}`, `card.monthlyPotentialSubLabel`. `de` only: shorten `card.weeklyTimeLabel` → "Zeit pro Woche", `card.monthlyPotentialLabel` → "Max. pro Monat", set `card.monthlyPotentialSubLabel` → "(bei vollem Zeitbudget)". `en`'s `monthlyPotentialSubLabel` is `""` (keeps its current one-line label unchanged).
- `src/api/routes/ideas.test.ts` + `web/src/features/ideas/IdeasPanel.test.tsx` — existing real-Postgres / RTL-mock-fetch test harnesses to extend; no new test infra needed.

## Tasks & Acceptance

**Execution:**
- [x] `src/tools/plain/set_idea_status.ts` -- new file: `SettableIdeaStatus` type, `IdeaNotFoundError`, local `settableIdeaStatusSchema` (`z.enum(['selected','bookmarked','rejected'])`), `setIdeaStatus(db, userId, ideaId, status)` -- transactional update + conditional demote-others -- AC1/AC2/AD-4
- [x] `src/api/routes/ideas.ts` -- add `POST /:id/status` (validate `:id` as a UUID and the body via `settableIdeaStatusSchema`, 400 on either failure; `IdeaNotFoundError` → 404; other errors → 503, same vocabulary as `GET /`); `GET /` filters out `status === 'rejected'` before responding -- AC1/AC3/AC4/AC5
- [x] `web/src/features/ideas/IdeasPanel.tsx` -- status badge + Select/Bookmark/Reject buttons on `IdeaCard`; `handleSetIdeaStatus` (optimistic local update mirroring the server's select/demote/reject-removal rules, snapshot-based revert + `error.statusUpdateFailed` on failure); loading skeleton (reserved-height placeholder, replaces the plain loading text); `BaselineRateDisplay` + stat-row rework (fixed-width label column, compact rate suffix, estimate badge moved under the label) -- AC1/AC2/AC3/Fix1/Fix2
- [x] `web/src/locales/en/ideas.json`, `web/src/locales/de/ideas.json` -- new keys listed in Code Map -- AC2/Fix2
- [x] `src/api/routes/ideas.test.ts` -- status-transition tests against real Postgres (select/demote/preserve-reject, reject hides+persists, 404 ownership, 400 invalid status) -- AC1-5
- [x] `web/src/features/ideas/IdeasPanel.test.tsx` -- card actions/status rendering, optimistic reject/select, revert-on-failure, loading skeleton, German compact-rate/label rendering -- AC1-3/Fix1/Fix2

**Acceptance Criteria:**
- AC1: Given 5 generated ideas, when the user selects one, then `set_idea_status` marks it `selected` and every other non-rejected idea for that user defaults to `bookmarked`.
- AC2: Given each idea card, when rendered, then Select/Bookmark/Reject are all present directly on the card, never behind a menu or separate screen; the action matching the card's current status renders as the primary one.
- AC3: Given a bookmarked idea, when the user marks it `rejected`, then it disappears from the visible list; remaining bookmarked ideas stay visible.
- AC4: Given a status change, when `set_idea_status` runs, then it is a plain deterministic Postgres update — no LLM call.
- AC5: Given a rejected idea, when the user reloads, then it stays hidden (persisted server-side, not just removed client-side).
- Fix1: Given the first `GET /api/ideas` request is still pending, when the panel renders, then it shows a fixed-height neutral placeholder, never the "no ideas yet" empty state.
- Fix2: Given the active language is German, when a card renders, then the rate shows as `"<amount> €/Std."` (no badge beside it — the "estimate" badge sits under the "Baseline rate" label instead), and the weekly-time/monthly-potential labels are the shortened forms with the budget caveat as separate small text; label columns stay a fixed width in both languages so cards align.

## Implementation Notes

- Built per the spec; all tasks complete, all I/O-matrix rows covered by a passing test. Independently re-verified (not just the implementer's own report): `npm test --workspace=src -- ideas` 42/42, `npm test --workspace=web -- ideas` 10/10, then the full `src` (200/200) and `web` (49/49) suites to check for regressions outside the `ideas` filter — all green. `typecheck`/`lint` clean across `shared`/`src`/`web`.
- `POST /:id/status` disables all 3 action buttons on that one card (not just the one matching current status) while its own request is in flight (`pendingIdeaId`) — a reasonable tightening of the Code Map's intent, prevents a double-click race during the network round trip.
- `status.rejected` has a translation key in both languages even though a `rejected` card is filtered out everywhere (server `GET /`, and optimistically client-side) and so never actually renders it — defensive completeness per AD-24 ("no user-facing string ships without a translation key... even a path not reachable today"), not dead code by intent.
- Rate-unit suffixes for `project`/`month` (`/project`, `/mo` en; `/Projekt`, `/Monat` de) weren't given explicit examples in the spec (only `hour` was) — implementer chose sensible short forms consistent with the `hour` example's shape. Flagged for a quick glance; not a blocker.

## Spec Change Log

## Review Triage Log

- **medium** — `set_idea_status.ts`'s existence check selects only `id`, not `status`; a direct `POST /:id/status {selected|bookmarked}` targeting an already-`rejected` idea's own id resurrects it, contradicting the stated "rejected hides it... permanently" guarantee. Verified: the `existing` select at `set_idea_status.ts` omits `status`. (blind-hunter + edge-case-hunter, same root cause) → **patch**
- **medium** — Two different cards' status requests can run concurrently (only the clicked card's own 3 buttons disable via `pendingIdeaId === idea.id`; other cards stay clickable): backend, two concurrent `selected` transactions touching overlapping rows in opposite statement order can deadlock (Postgres row-lock-order inversion across the target-update + sweep-update pair); frontend, `handleSetIdeaStatus`'s per-call `snapshot = ideas` closure means a failing *first* call's revert can stomp a second call's already-applied change. Verified by tracing both the transaction's two separate `UPDATE`s and the closure capture. (edge-case-hunter x2 + blind-hunter's "pending behavior unverified by any test") → **patch**
- **medium** — Loading-state accessibility regression: the old `phase === 'loading'` render was a real `<p>{t('loading')}</p>`, readable by assistive tech; `IdeasSkeleton` is `aria-hidden="true"` with no text, so screen-reader users get zero feedback during first load, and the `loading` key is now unused in both locale files. Verified: no remaining `t('loading')` call or accessible text anywhere in the skeleton. (blind-hunter + edge-case-hunter, same root cause) → **patch**
- **low** — `card.rateUnit.{hour,project,month}` is dead in both `en`/`de` `ideas.json` since `BaselineRateDisplay` switched to `card.rateUnitSuffix.*`. Verified: zero remaining `card.rateUnit.` references in `IdeasPanel.tsx`. Kept (not rejected) — fix is a pure deletion. (blind-hunter + edge-case-hunter, same root cause) → **patch**
- **medium** — No test pins the English compact-suffix rendering (`"$X.XX/h"`, no space) — only the German Fix2 test asserts an exact glued string; the English tests only check that the amount substring is present, which would pass even if the suffix silently reverted to the old verbose `" per hour"` form or broke. Pre-verified by verification-gap per its own evidence rules. → **patch**
- **low** — Clicking "Bookmark" directly on a `suggested` idea (not as a select/demote side effect) has zero test coverage anywhere, despite being one of the 3 always-present actions. Real gap on a common path; fix is a direct test addition. (blind-hunter) → **patch**
- **low** — `handleSetIdeaStatus`'s `.catch` (network-failure/thrown-fetch) branch is never exercised — the existing revert-on-failure test only drives the `!res.ok` branch. Same consequence, different code path; fix is extending that test into an `it.each` per CLAUDE.md's own table-driven preference. (blind-hunter) → **patch**
- **low** — Three/two hand-maintained literal copies of the settable-status values (`shared/schemas/ideas.ts`'s `ideaStatusSchema`, `set_idea_status.ts`'s `settableIdeaStatusSchema`, `IdeasPanel.tsx`'s `SettableStatus`) can drift if a future status value is added to one and not the others; no test or type link ties them. Named harm: a silent server/client enum mismatch after a future change. Fix: derive the frontend's `SettableStatus` from `@app/shared`'s already-exported `IdeaStatus` via `Exclude<IdeaStatus, 'suggested'>` instead of a hand-written union (small, no public-surface change; the backend Zod enum stays hand-written since Zod needs literal strings regardless). (blind-hunter + verification-gap, same root cause) → **patch**
- **false** — "No rate limiter on `POST /:id/status`." Checked: `src/api/routes/settings.ts`'s `/personality`, `/model`, `/ui-language` routes — the established precedent for plain deterministic Postgres-write routes in this codebase — likewise have no rate limiter; `strictLimiter` is reserved for LLM-cost-bearing calls per the existing comment at `ideas.ts:86-87`. Not a deviation from convention. (blind-hunter) → **rejected**
- **false** — "Clicking Bookmark on the currently-selected idea leaves zero selected ideas, unspecified." Checked: every action is an independently correct single-row update except `selected`'s own demote-sweep (per the frozen Boundaries); zero-selected is the same valid state as before any selection ever happened, consistent with the wireframe's always-clickable 3-button design. No AC or epics.md text states a "must always have exactly one selected idea" invariant — one defensible reading, not an open intent gap. (blind-hunter) → **rejected**
- **false** — "Unrelated epic-planning rewrite (Story 2.5/2.6, country field, etc.) bundled into this story's diff" (`epic-2-context.md`). Checked: that file was recompiled during this session's own pre-implementation Step 1 (its cache was stale against an already-updated `epics.md`, confirmed invalid per the workflow's own validity check) and was already sitting uncommitted in the working tree *before* `baseline_commit` was captured for this story. It predates and is unrelated to Story 2.3's own code changes — not introduced by the implementation subagent. (blind-hunter) → **rejected**

## Design Notes

- **Why "select" doesn't un-reject:** the AC's own example ("5 generated ideas" — none rejected yet) only describes the common case. Resurrecting an explicitly-rejected idea when the user selects a *different* one would silently undo a deliberate action the user already took; excluding `rejected` from the demote-sweep is the only reading that can't surprise the user.
- **Why the rate line's badge move + suffix format is the same change in both languages, not German-only:** the user's own example gives both forms — `"23,34 €/Std."` (de) and `"€23.34/h"` (en) — i.e. one compact-suffix layout, varying only by the existing locale-driven `formatMoney` output + a new short per-language suffix string. Two parallel layouts (compact for German, old verbose-with-side-badge for English) would double the code path for no requirement that asks for it.
- **Why the per-row `<div>` wrapper survives unchanged:** `IdeasPanel.test.tsx`'s existing regression tests locate a stat row via `screen.findByText(label).closest('div')`. Switching to flat CSS-grid children (label/value as siblings with no per-row wrapper) would silently break those assertions — a fixed-width label span inside the same wrapper achieves the same visual column alignment without touching that structure.
- **Why no DI seam on `setIdeaStatus` (unlike `set_model`'s `deps.updateModel`):** the one-`selected`-per-user rule is exactly CLAUDE.md's own named example for when a real-Postgres integration test is warranted ("one active plan per user"), so the test strategy here is one integration test exercising the real transaction, not a mocked unit test — matching `upsertUserAndSettings` (`auth-repository.ts`), which also takes no DI deps.

## Verification

**Commands:**
- `npm test --workspace=src -- ideas` -- expected: new `set_idea_status`/route tests pass, no existing `src` test regresses
- `npm test --workspace=web -- ideas` -- expected: new `IdeasPanel` tests pass, no existing `web` test regresses
- `npm run typecheck` -- expected: clean across `shared`/`src`/`web`
- `npm run lint` -- expected: clean

**Manual checks (if no CLI):**
- Load the ideas panel with 5 seeded ideas in both `en` and `de`; click Select/Bookmark/Reject on different cards and confirm the primary-button highlight follows status, the rejected card disappears, and a page reload keeps it hidden.
- Switch to German and confirm the baseline-rate line reads `"<amount> €/Std."` with the estimate badge under the label, and the weekly-time/monthly-potential labels show the shortened text with the caveat as small text below.
