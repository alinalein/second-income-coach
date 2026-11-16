---
title: 'Story 5.5: Currency Selection'
type: 'feature'
created: '2026-11-16'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The settings screen has no control to switch the display currency between EUR and USD; `user_settings.currency` (created in Story 1.2, default `'EUR'`) is read by `GET /api/ideas` already but nothing lets the user change it, and the existing idea cards (Story 2.2) would keep showing a stale currency after a change since they only fetch it once on mount.

**Approach:** Add `set_currency` as a plain deterministic Postgres write (same shape as Story 5.4's `set_ui_language`) wired to a new `POST /api/settings/currency`, extend `GET /api/settings` to report the current currency, add an EUR/USD `<select>` to `SettingsPage` next to the existing controls, and notify the already-mounted `IdeasPanel` of a change by remounting it (`key` bump in `App.tsx`) so its existing mount-time fetch re-reads the now-updated currency from `GET /api/ideas` — zero lines changed inside `web/src/features/ideas/IdeasPanel.tsx`. `shared/money.ts` (conversion + `Intl.NumberFormat` formatting) already fully implements AD-27 and needs no changes.

</frozen-after-approval>

## Implementation Notes

