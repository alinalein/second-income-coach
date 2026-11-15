---
title: 'Story 1.4: Internationalization (i18n) Foundation & Bilingual Replies'
type: 'feature'
created: '2026-11-15'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '3c379566e241e4d940502513d3290e317297d80a'
context: ['{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every user-facing string in the app is hardcoded English today (sign-in screen, chat UI, Story 1.3's three fixed safety/error texts), and the agent has no notion of replying in the language the user actually wrote in.

**Approach:** Add `react-i18next` (AD-24) with `common`/`chat` namespaces under `web/src/locales/{de,en}/`, route every existing frontend string through it, give the agent a per-message reply-language instruction plus a hardcoded-default personality tone in one `createAgent` `prompt` function (AD-25), and give Story 1.3's three fixed texts a German counterpart picked by a small deterministic language detector.

## Boundaries & Constraints

**Always:**
- No hardcoded user-facing string ships in the frontend; every string in `App.tsx`/`ChatThread.tsx` goes through `t()`.
- Both a German and English version of the jailbreak-rejection, unsafe-response-fallback, and model-failure texts exist from this story onward.
- Reply language (for the model's own replies) is decided per message from what the user wrote, independent of `user_settings.uiLanguage` — re-evaluated every turn, via the `createAgent` `prompt` option, not a separate routing layer.
- Personality tone (formal/friendly/terse) and reply language render in that same `prompt` function; personality itself stays a hardcoded `'friendly'` default (no `set_personality` tool/UI exists until Story 5.1 — same pattern Story 1.3 used for the hardcoded model).

**Never:**
- No settings UI for language/personality (Story 5.1/5.4).
- No change to `shared/schemas/index.ts`, `src/db/**`, or `src/tools/**` — the checkpointer already persists final message text verbatim (Design Notes, spec-1-3), so the backend must keep emitting final resolved text, not a translation key, for the three fixed texts; this is handled with plain EN/DE constant pairs colocated with today's constants, not a new shared type.
- No new npm dependency for language detection — DE/EN is a small closed set, a hand-rolled heuristic suffices.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| German message, normal reply | User writes a German sentence | Agent's `prompt` instructs the model to reply in German; LLM replies in German | N/A |
| English message, normal reply | User writes an English sentence | LLM replies in English | N/A |
| Jailbreak attempt, German text | `beforeModel` rejects a German message | `JAILBREAK_REJECTION_MESSAGE_DE` returned | N/A |
| Jailbreak attempt, English text | `beforeModel` rejects an English message | `JAILBREAK_REJECTION_MESSAGE` (EN) returned | N/A |
| Unsafe output, German conversation | `afterModel` flags output; last human message was German | `UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE` returned | N/A |
| Model call exhausts retries, German message | `chat.ts` catch/no-usable-reply branch, submitted content was German | `MODEL_FAILURE_MESSAGE_DE` returned | N/A |
| Network/parse failure before any server reply | `ChatThread.tsx`'s own fetch `.catch`/non-conforming body | Local fallback resolved via `t('chat.error.modelFailure')` against current UI language (no per-message detection possible — no server round-trip happened) | N/A |
| Ambiguous/very short message | e.g. a single emoji or number | Detector defaults to English | N/A |

</frozen-after-approval>

## Code Map

- `web/package.json` -- add `react-i18next`, `i18next`.
- `web/src/i18n/index.ts` (new) -- `i18next.use(initReactI18next).init(...)`, statically importing the 4 JSON files below as `resources` (no HTTP backend needed, Vite bundles them); default/fallback language `en`.
- `web/src/locales/{en,de}/common.json` (new) -- app.title, auth.signInTitle/Description/Error/Button, auth.signOutButton (App.tsx lines ~76-139 per investigation).
- `web/src/locales/{en,de}/chat.json` (new) -- chat.title/loading/empty/placeholder/messageAriaLabel/sendButton, chat.error.modelFailure (EN value identical to shared `MODEL_FAILURE_MESSAGE`'s text).
- `web/src/main.tsx` -- add `import './i18n'` before render (side-effect init, no Provider needed; `useTranslation()` reads the global instance).
- `web/src/App.tsx` -- replace the ~5 hardcoded strings (investigation: lines 76-77, 82, 89, 111, 124, 139) with `useTranslation('common')`/`t()`.
- `web/src/chat/ChatThread.tsx` -- replace its 6 hardcoded strings (lines 91, 95, 97, 108, 111, 115) with `useTranslation('chat')`/`t()`; swap the two `MODEL_FAILURE_MESSAGE` local-fallback usages (lines 77, 81) for `t('chat.error.modelFailure')`, dropping that import here (keep it in `resilience.ts`/`chat.ts` where it's still the backend-matching EN literal).
- `src/agent/language.ts` (new) -- `export function detectReplyLanguage(text: string): 'de' | 'en'` -- umlaut/ß check + a small German-stopword regex; defaults to `'en'`.
- `src/agent/moderation.ts` -- add `JAILBREAK_REJECTION_MESSAGE_DE`, `UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE` constants next to the existing EN ones; `NOTICE_TEXTS` must include all 4 literals (history read-back re-derives `kind` by exact text match -- Design Notes, spec-1-3 -- so every language variant needs to be in the set); `evaluateUserMessage`'s reject branch picks EN/DE via `detectReplyLanguage(text)`; `evaluateAssistantMessage` gains a `humanText: string | undefined` parameter and picks EN/DE via `detectReplyLanguage(humanText ?? '')`; export `lastMessageOfType` so `index.ts` can reuse it; the `afterModel` hook (currently only reads `lastAi`) must also extract `lastHuman` to pass through.
- `src/agent/resilience.ts` -- add `MODEL_FAILURE_MESSAGE_DE` (new local constant, not in `shared/schemas`).
- `src/agent/index.ts` -- add a `prompt: (state) => [SystemMessage]` option to the `createAgent(...)` call: a fixed `PERSONALITY_PROMPTS` map (`formal`/`friendly`/`terse`, default `'friendly'`) plus a fixed instruction to reply in the same language (German or English) as the user's most recent message -- the model does its own language matching for normal replies, no detector call needed here.
- `src/api/routes/chat.ts` -- at both `MODEL_FAILURE_MESSAGE` use sites (lines 92, 112), pick EN/DE via `detectReplyLanguage(parseResult.data.content)`.

## Tasks & Acceptance

**Execution:**
- [x] `web/package.json`, `web/src/i18n/index.ts`, `web/src/locales/**` -- i18n init + 4 locale JSON files -- AC1
- [x] `web/src/main.tsx` -- wire i18n init -- AC1
- [x] `web/src/App.tsx`, `web/src/chat/ChatThread.tsx` -- route existing strings through `t()` -- AC1
- [x] `src/agent/language.ts` -- `detectReplyLanguage` + unit tests -- AC3
- [x] `src/agent/moderation.ts` -- DE constants, `NOTICE_TEXTS` update, detector wiring, `humanText` threading -- AC2
- [x] `src/agent/resilience.ts`, `src/api/routes/chat.ts` -- `MODEL_FAILURE_MESSAGE_DE` + detector wiring -- AC2
- [x] `src/agent/index.ts` -- `prompt`-equivalent: personality map + reply-language instruction via `dynamicSystemPromptMiddleware` -- AC3, AC4
- [x] Tests for the I/O matrix rows above, table-driven per CLAUDE.md -- AC1-AC4

**Acceptance Criteria:**
- AC1 -- Given any user-facing frontend string, when added, then it goes through `react-i18next` under `web/src/locales/<lang>/<namespace>.json` -- no hardcoded string ships in either language.
- AC2 -- Given Story 1.3's three fixed texts, when this story completes, then each has a German and English form, selected by `detectReplyLanguage` on the relevant triggering message.
- AC3 -- Given a user's message, when the agent replies normally, then the `prompt` function instructs the model to reply in that message's language, independent of `user_settings.uiLanguage`, re-evaluated every turn.
- AC4 -- Given the default personality, when a reply is generated in either language, then personality tone and reply language come from the same `prompt` function, not separate per-language definitions.

## Implementation Notes

- **`createAgent`'s actual API has no `prompt` callback field:** the installed `langchain@1.6.5` `CreateAgentParams` only exposes a *static* `systemPrompt: string | SystemMessage` — there is no per-turn `prompt: (state) => ...` option (confirmed directly against `node_modules/langchain/dist/agents/types.d.ts`; the doc-comment example showing `prompt: (state, config) => ...` belongs to a different/newer API shape than what's installed). Implemented the same per-turn, agent-construction-time mechanism using `dynamicSystemPromptMiddleware` (also exported from `langchain`), added to the same `middleware: [...]` array the moderation middleware already lives in, in `src/agent/index.ts`. This satisfies AD-25's actual rule ("a prompt-construction concern, not a routing concern") — it's still wired at `createCoachAgent()` construction time, not in `api/routes/chat.ts` — just via a differently-named API than the Code Map's literal pseudo-code. `buildSystemPrompt()` is exported standalone (personality + reply-language instruction, both from the one function) and unit-tested directly without constructing a LangGraph runtime.
- **i18n key naming:** used namespace-relative keys throughout (`useTranslation('chat')` + `t('error.modelFailure')`, `useTranslation('common')` + `t('auth.signInTitle')`) rather than the Code Map's literal `t('chat.error.modelFailure')` — the latter would only resolve correctly if `chat.json` nested everything under a redundant top-level `"chat"` key, which conflicts with `common.json`'s own (already-relative) key style in the same Code Map entry. Picked the idiomatic, internally-consistent form; no behavior difference.
- No new external service/credential introduced by this story (i18next/react-i18next are a build-time npm dependency, not an external service) — no `.env.example` or `src/config/env.ts` changes needed, and there is nothing for the user to fill in.

## Spec Change Log

## Review Triage Log

- **`detectReplyLanguage`'s stopword list misdetects ordinary English sentences as German via EN/DE homographs** (blind-hunter, edge-case-hunter — same root cause) — `high` — confirmed: `was`, `will`, `war`, `hat`, `die`, `den` are all in `GERMAN_STOPWORDS` and are also common English words ("What **was** the issue?", "I **will** try that", "I like this **hat**" all tokenize to a single stopword hit and wrongly return `'de'`). A single-word match is the entire trigger condition — not a rare edge case, given how common these words are in everyday English. Route: **patch**.
- **`dynamicSystemPromptMiddleware(buildSystemPrompt)`'s wiring into `createCoachAgent`'s `middleware` array has no test above the pure-function level** (verification-gap, pre-verified) — `patch` (filed) — confirmed: no test constructs `createCoachAgent` or invokes the `systemPrompt` middleware's hook; `buildSystemPrompt()`'s own test only checks the standalone string. Dropping the array element or wiring the wrong function would type-check and pass every existing test while silently shipping with no reply-language/personality instruction reaching the model. Route: **patch**.
- **`web/src/theme/theme-toggle.tsx` still has 2 hardcoded strings (`aria-label`, "Light"/"Dark") outside the new i18n layer** (edge-case-hunter, "Other findings") — `medium` — the invocation's own scope ("web/src/chat/** and other existing UI only to route strings through i18n") covers this file; it wasn't excluded by the actual intent, only by this spec's narrower Code Map, so it isn't out-of-scope. Leaves AC1 ("no hardcoded user-facing string ships in the frontend") unmet for this one file. Route: **patch**.
- **No automated check that `en`/`de` locale JSON files stay in key-parity** (blind-hunter) — `medium` — confirmed: nothing compares `web/src/locales/{en,de}/{common,chat}.json`'s key sets; i18next silently falls back to English on a missing German key, so a future string added in English only would violate AC1/AC2 undetected. Route: **patch**.
- **`MODEL_FAILURE_MESSAGE_DE` double-quoted while its siblings (`JAILBREAK_REJECTION_MESSAGE_DE`, `UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE`) use single quotes** (blind-hunter) — `low`, fix is a direct 2-character correction — confirmed in `src/agent/resilience.ts`. Route: **patch**.
- **`evaluateAssistantMessage`'s new `humanText: string | undefined = undefined` parameter has a redundant explicit `= undefined`** (blind-hunter) — `low`, fix is a direct deletion — confirmed in `src/agent/moderation.ts`. Route: **patch**.
- **`ChatThread.test.tsx`'s new test hardcodes the full English fallback sentence a second time instead of asserting against the locale resource** (blind-hunter) — `low`, fix is a direct correction (import the JSON, assert against it) — confirmed; a future wording tweak in `en/chat.json` would silently desync this test. Route: **patch**.
- **`epic-1-context.md` rewritten with content beyond Story 1.4** (blind-hunter) — `false` — this file is the build-session-owned epic-context cache (`_bmad-output/implementation-artifacts/`), not one of CLAUDE.md's restricted planning docs (`epics.md`/`sprint-status.yaml`/`ARCHITECTURE-SPINE.md`); it was regenerated in step 1 of this same build session because it was stale (epics.md newer), per the workflow's own designed cache-invalidation step, and now accurately reflects current planning artifacts covering all of Epic 1's 5 stories. Route: **false**.
- **`MODEL_FAILURE_MESSAGE`/`_DE` duplicated between `src/agent/resilience.ts` and the locale JSON files, with no test pinning them equal** (blind-hunter, edge-case-hunter — same root cause) — `low` — real, but the only path that hits this divergence is the already-rare client-side network-failure fallback, purely cosmetic wording if it drifts; the fix (a cross-workspace equality test, since `web/`'s test runner can't import from `src/agent/`) is more than a direct correction. Route: **reject**.
- **`MODEL_FAILURE_MESSAGE_DE` not added to an equivalent of `NOTICE_TEXTS`** (blind-hunter) — `false` — `kind: 'error'` is always set explicitly at the two `chat.ts` construction sites, never re-derived by content match; these error messages are never persisted to the checkpointer (they're constructed outside `agent.invoke`'s returned messages), so they never reach `classifyAssistantMessageKind` on history read-back. The concern doesn't apply. Route: **false**.
- **`web/src/i18n/index.ts`'s JSON imports depend on unverified `resolveJsonModule` support** (blind-hunter) — `false` — `web/tsconfig.json:16` already has `"resolveJsonModule": true`; independently re-ran `npm run typecheck`/`npm run build` and both pass cleanly. Route: **false**.
- **AD-24/AD-25 cited without an enumerated Technical-Decisions list in `epic-1-context.md` to map them to** (blind-hunter) — `false` — `compile-epic-context.md`'s own rule is "describe by purpose, not by source" (no AD-id citations by design); the actual source of truth, `ARCHITECTURE-SPINE.md`, has both fully enumerated and was read directly during planning. Route: **false**.
- **EN/DE-picking ternary duplicated inline at 3 call sites instead of one shared helper** (blind-hunter) — `low` — real, but exactly the "three similar lines" case CLAUDE.md says to leave alone rather than abstract; the proposed fix runs against this project's stated house style. Route: **reject**.
- **AC3/AC4's frozen wording says "`createAgent` `prompt` option/function" while the actual mechanism is `dynamicSystemPromptMiddleware`** (edge-case-hunter) — real, but its only fix is editing this spec's frozen text to match the actual (langchain-version-constrained) mechanism — already explained in Implementation Notes. Route: **reject** (fix = edit the spec, excluded by policy).

## Design Notes

- **Why not react-i18next keys for the 3 fixed texts:** AD-24's literal wording puts all fixed-system-text translations under `web/src/locales/`. The checkpointer (spec-1-3 Design Notes) persists only raw `BaseMessage` text verbatim and `classifyAssistantMessageKind` re-derives `kind` from that text on every history read -- so the backend must always emit final, already-resolved text, never a key the frontend would resolve later. Combined with this story's explicit boundary against touching `shared/schemas/index.ts` (the only cross-package entry point `@app/web` and backend both reach, per `shared/package.json`'s `exports`), the three fixed texts' DE/EN pairs live as plain constants beside their existing EN literals in `src/agent/`, not in the locale JSON. This is a deliberate, bounded deviation from AD-24's literal file location, trading a small amount of string duplication (6 short strings) for zero cross-package coupling and zero schema/DB changes.
- **Why the frontend's own network-failure fallback doesn't use the detector:** `ChatThread.tsx`'s two local fallbacks fire when no server response was ever received (fetch threw, or the body failed schema validation) -- the backend's detector never got to run. Reusing it client-side would mean duplicating `detectReplyLanguage` into `web/src/` (the one cross-package code path, `shared/schemas`, is explicitly off-limits here) for a rare, already-degraded edge case. Falls back to the current UI language via `t()` instead.
- **Personality default:** `user_settings.personality` already defaults to `'friendly'` in the DB (Story 1.2), but reading it requires a `src/db` repository call, which is out of this story's scope. `PERSONALITY_PROMPTS['friendly']` is used unconditionally until Story 5.1 wires the real setting through -- same hardcoded-default pattern Story 1.3 used for the model.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean across `src`, `web`, `shared`
- `npm run lint` -- expected: zero lint errors
- `npm test` -- expected: new tests (mapped to AC1-AC4/AD-24/AD-25 per `CLAUDE.md`) pass, previous suite still green
- `npm run build` -- expected: clean production build

**Manual checks (if no CLI):**
- Switch the browser to send a German chat message; confirm the reply comes back in German.
- Trigger a jailbreak-style message in German; confirm the rejection notice renders in German.
- Toggle nothing in settings (no UI exists yet) and confirm English still works end-to-end as the default.
