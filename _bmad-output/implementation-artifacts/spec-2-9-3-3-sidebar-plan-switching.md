---
title: 'Story 2.9 App Navigation Sidebar + Story 3.3 Switching Between Plans'
type: 'feature'
created: '2026-11-17'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no persistent navigation — the app is one screen that ternary-swaps between intake/ideas/plan, Settings is a card bolted under the ideas list, a reload always drops back to the ideas list, and there is no way to switch which plan is active (epics.md 2.9, 3.3).

**Approach:** Add a left `Sidebar` (product name, New ideas, My plans, Bookmarked, profile) driven by a small URL-path router in `App.tsx` (no new dependency — `history.pushState`/`popstate`, same primitive `useAuthError` already uses). Backend: a new `GET /api/plans` list endpoint, and a `resumePausedPlan` path so selecting a bookmarked idea with a paused plan reactivates it in place (AD-13) instead of going through `create_plan`/the 3.2 gate again.

## Boundaries & Constraints

**Always:** reuse the Story 2.8 confirm dialog (same `ideas:confirmSelect.*` strings) for Bookmarked-list selection; a newly-created plan (no prior plan) still goes through the 3.2 draft-review gate; exactly one active plan per user stays DB-enforced (AD-14, unchanged); DE+EN for every new string (AD-24).

**Never:** touch `generate_ideas.ts`, translation, `web_search`, or `ChatMessage`/`ChatThread` (lane A/C territory); add a routing library; create a second sidebar inside the plan workspace (its `StatusPanel` becomes a plain stacked header, always, per AC).

</frozen-after-approval>

## Code Map

- `src/tools/plain/activate_plan.ts` -- extract `activateAndPauseOthers(tx, planId, userId)` out of `confirmActivation`'s transaction body; add `resumePausedPlan(db, planId, userId)` (locks row, no-ops unless `status === 'paused'`, otherwise runs the same pause-old/activate-this transaction). AD-13's own text already names this behavior.
- `src/api/routes/plans.ts` -- `POST /select/:ideaId`: when `existingPlan.status === 'paused'`, call `resumePausedPlan` instead of returning the row as-is. New `GET /` (mounted as `GET /api/plans`): `plans` joined to `ideas.title`, scoped to `req.session.userId`, ordered by `plans.updatedAt desc`.
- `shared/schemas/plans.ts` -- add `planListEntrySchema`/`planListResponseSchema` (id, ideaId, ideaTitle, status, updatedAt).
- `web/src/features/sidebar/Sidebar.tsx` (new) -- product name, New-ideas button, My-plans list (`GET /api/plans`, active marked via `aria-current`, paused dimmed), Bookmarked list (`GET /api/ideas`, filter `status==='bookmarked' && !hasPlan` — no backend/schema change needed there), profile entry (Settings button + `ThemeToggle` + existing sign-out). Mobile: `shadcn-glass-ui`'s `Sheet`/`SheetContent side="left"` as the overlay, driven by props (`mobileOpen`/`onMobileOpenChange`) so App owns the one piece of toggle state. Bookmarked click opens the reused confirm dialog -> `POST /api/ideas/:id/status` -> `onSelectPlan`; My-plans click calls `onSelectPlan` directly, no dialog.
- `web/src/App.tsx` -- replace the `showIntakeForm`/`viewPlanIdea` ternary with a tiny `{kind:'ideas'|'settings'|'plan', ideaId?, ideaTitle?}` route read from `window.location.pathname` (`/`, `/settings`, `/plan/:ideaId`) + a `popstate` listener; `navigate()` does `pushState` + `setState`. Lifts one `GET /api/plans` fetch (for Sidebar's My-plans list + resolving `ideaTitle` on a direct `/plan/:ideaId` reload, with a `GET /api/ideas` fallback lookup if not found). Drops the old authenticated-view `<header>` (title/theme/sign-out move into the sidebar's profile entry); keeps `RevisitIntakeLink` (Story 2.1 AC, still required) rendered above `IdeasPanel` in the `'ideas'` route.
- `web/src/features/plan-workspace/PlanWorkspace.tsx` -- drop `sm:flex-row sm:w-64 sm:shrink-0`; `StatusPanel` always stacks above the chat now that the app sidebar is the one sidebar (AC).
- `web/src/locales/{en,de}/sidebar.json` (new) + `web/src/i18n/index.ts` registration + one row in `web/src/i18n/locales.test.ts`'s existing parity table.

## Tasks & Acceptance

**Execution:**
- [ ] `src/tools/plain/activate_plan.ts` -- add `resumePausedPlan` -- 3.3 AC1/AC2
- [ ] `src/api/routes/plans.ts` -- wire resume into `/select/:ideaId`; add `GET /` -- 3.3 AC1/AC2/AC3, 2.9 My-plans data
- [ ] `shared/schemas/plans.ts` -- `planListResponseSchema` -- AD-16
- [ ] `web/src/features/sidebar/Sidebar.tsx` + test -- 2.9 all ACs, 3.3 AC3/AC4 (dialog + gate)
- [ ] `web/src/App.tsx` + test -- URL routing, reload persistence -- 2.9 reload AC
- [ ] `web/src/features/plan-workspace/PlanWorkspace.tsx` -- header-only status panel -- 2.9 AC4

**Acceptance Criteria:** epics.md Stories 2.9 and 3.3, verbatim (not restated here).

## Implementation Notes

(appended during build)

## Design Notes

Sidebar visuals: plain `Card`/`Button`/`Badge` primitives already in the app (no new design system call) — the layout-preview template has no app-nav-sidebar mock to match, only the plan-workspace status sidebar (which this spec removes in favor of the one app sidebar). "Active" = `aria-current="page"` + default `Button` variant; "paused, dimmed" = `text-muted-foreground`/reduced opacity on that row.

## Verification

**Commands:**
- `DATABASE_URL=postgres://second_income_coach:second_income_coach@localhost:5432/second_income_coach_b_test WEB_SEARCH_MODE=stub npx vitest run src/tools/plain/activate_plan.test.ts src/api/routes/plans.test.ts` -- backend green
- `npx vitest run` (web workspace) -- `Sidebar.test.tsx`, `App.test.tsx`, `PlanWorkspace.test.tsx`, `locales.test.ts` green
- `npm run build --workspace=shared && npx tsc --noEmit` -- typecheck clean
