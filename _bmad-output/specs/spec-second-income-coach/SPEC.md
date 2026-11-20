---
id: SPEC-second-income-coach
companions: [stack.md, engagement-mechanics.md, evals.md, ../../planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md]
sources:
  [
    ../../brainstorming/brainstorm-ai-agent-purpose-2026-11-12/course-agent-brief.md, # local, not in repo
  ]
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Second Income Coach

## Why

A pain to solve: people who want an additional income stream — employed, freelance, or self-employed, employment status is not a restriction — face two barriers: idea paralysis (generic "extra income idea" lists aren't matched to their actual skills, time, or risk appetite) and inconsistent follow-through (momentum breaks after a life disruption, with no low-friction, judgment-free way back in). This matters now because existing tools solve at most the first half: idea-generation quizzes already exist, but none pair tailored ideas with a non-punitive accountability loop.

## Capabilities

- **CAP-1**
  - **intent:** User can complete a structured intake (skills, interests, available time, risk tolerance, starting budget, and what has stopped them from starting or following through before) that captures both profile data and a classified failure pattern.
  - **success:** A completed intake yields a value for every field, including a failure pattern classified into one of a known set (overwhelm, loses interest once routine, gets stuck with no next step, life disruption, forgets/deprioritizes).

- **CAP-2**
  - **intent:** User receives second-income ideas matched to their intake constraints, instead of a generic one-size-fits-all list. Of the 5 ideas, the user selects one to work on; the other 4 are retained as "bookmarked" rather than discarded, and the user can mark any idea "rejected" to remove it from the list. User can request "more ideas" for a further batch of 5, excluding anything already bookmarked or rejected.
- **success:** For a completed intake, the agent provides exactly 5 ideas. Each idea includes:
- a rationale that mentions at least **three different intake fields**
  (skills, interests, available time, risk tolerance, starting budget)
- structured information on time required per week, startup costs, and risk level
- "More ideas" returns a further 5, never repeating a bookmarked or rejected idea

This can be verified as follows:

- The values mentioned in the rationale match the intake values.
- No idea exceeds the time, budget, or risk level specified in the intake.
- Two intake forms that differ in at least two fields yield
  different sets of ideas.
- Marking an idea "rejected" removes it from the visible list; the remaining non-selected ideas stay available as "bookmarked."

- **CAP-3**
  - **intent:** Once the user selects an idea, the agent produces a draft plan of small concrete steps with an estimated timeline, sized and sequenced according to the user's classified failure pattern, revealing only the current and immediate-next step until the current one completes. The draft is not yet active (see CAP-6).
  - **success:** A generated plan has ordered steps with timeline estimates and status "draft"; only the current and next step are visible at any time; step granularity differs across at least two different failure-pattern categories.

- **CAP-4**
  - **intent:** User can check in with the agent on an ongoing basis, either by typed text or by voice (recorded, transcribed, and shown back as an editable transcript the user confirms before it's submitted); a lightweight energy/status input precedes any task ask; a missed check-in is a normal, non-punitive reset that automatically shifts the timeline; starting a step and finishing a step each produce their own distinct acknowledgment.
  - **success:** A missed check-in produces a recalculated timeline and a neutral re-entry message with no shame/streak language; start and finish of a step produce two distinguishable acknowledgment messages; both the typed and voice-with-transcript-review check-in paths are exercised end-to-end at least once.

- **CAP-5**
  - **intent:** After each completed step or check-in, user sees an updated income estimate and the concrete next opportunity it unlocks, computed from their actual progress and consistency.
  - **success:** The projection value changes between two check-ins with different actual progress, demonstrating it is derived from live data rather than fixed at intake.

- **CAP-6**
  - **intent:** A generated plan requires explicit human confirmation before it becomes active: the agent's plan-activation step pauses and surfaces the draft for the user to confirm, modify, or reject. Confirming activates exactly one plan at a time, pausing any previously active plan rather than discarding it. Rejecting produces a revised draft from the user's feedback. The user can later activate a different bookmarked idea's plan without regenerating from scratch.
  - **success:** Plan activation always pauses for explicit human input before a plan's status changes to "active"; confirming never leaves more than one plan active at once; rejecting yields a new draft incorporating the stated feedback; switching to a previously paused plan resumes it rather than recreating it.

- **CAP-7**
  - **intent:** User can set a personality for the agent (formal/friendly/terse), choose which LLM powers it from a model registry (id, provider, display name, price per 1M input/output tokens, price_as_of date), switch the UI language between German and English, and choose a currency (EUR or USD) for all displayed amounts. Only providers with a configured server-side key are selectable; the moderation model and the transcription model are never user-selectable. UI language defaults to English; currency defaults to EUR. Both persist in `user_settings`.
  - **success:** The tone/guilt-language verification (see CAP-4 constraints) applies identically under every personality setting - no personality bypasses it. Personality renders correctly in both German and English (CAP-10). Switching the selected model changes which model actually answers, without code changes. A provider with no server-side key never appears as an option. UI language and currency persist across sessions and default correctly on first visit (English; EUR). Changing currency re-renders every displayed amount in the newly chosen currency.

- **CAP-10**
  - **intent:** The agent understands and replies in German or English, matching whichever language the user writes (or speaks, for voice) in per message - independent of the UI language setting (CAP-7). All fixed system texts (neutral re-entry messages, error messages, acknowledgments, the key-missing fallback notice) exist in both languages. Moderation and the guilt/streak-language check (CAP-4) are verified to work correctly in German, not just English.
  - **success:** A message written in German gets a German reply; a message written in English gets an English reply; switching languages mid-conversation is handled per-message, not locked to the thread's first message or the UI setting. Every fixed system text has a German and an English version - none falls back to English by accident. Guardrail tests (moderation, guilt/streak-language) pass at the same 100% bar in German as in English (AD-23/NFR7).

- **CAP-8**
  - **intent:** User sees the token count and an estimated cost beneath every agent response.
  - **success:** The estimate sums every model call made during that turn's full agent-loop execution, not just the final response; it is computed in application code from the model registry's prices and visibly labeled "estimate"; the value is persisted per message in Postgres.

- **CAP-9**
  - **intent:** User can rate any agent response (thumbs up/down) with an optional comment. Rating is always optional and never blocks continued use.
  - **success:** The chat input is never disabled or gated on a missing rating. A rated trace feeds per-user semantic memory and a LangSmith dataset of rated traces, used only for offline prompt improvement, never model training. Comment text passes through the same moderation as any other user input. A positive rating never overrides a hard constraint (e.g. rating a guilt-language response positively does not exempt it from CAP-4's verification check).

- **CAP-11**
  - **intent:** A signed-in, read-only page ("Evaluation & Decisions", route `/evaluation`, linked in the sidebar footer) presents three sections: evaluation results (from the latest eval report), key architecture decisions (each with its reason and trade-off - agent shape and why an agent instead of prompt engineering or RAG, tool boundary, the HITL gate, the persistence split, guardrails, model choice, i18n, money handling), and a reflection (known problems, improvement suggestions, and guidance on when to use prompt engineering vs. RAG vs. agents). Every fact shown is generated from an existing source - the eval report, an architecture decision, the known-weaknesses documentation - never independently hand-copied prose. UI chrome is localized (German/English, CAP-10); report/decision content may remain English-only, stated explicitly on the page. It sits behind the same authentication as every other route (decided 2026-11-19: no public exception).
  - **success:** The page loads with no sign-in required. Each section's content traces back to its source (the eval report's data, an AD id, the known-weaknesses content) rather than being an independently retyped summary that could drift. The page contains no user-specific data, no secrets, and no private LangSmith trace links - verified by a dedicated test. The page states, visibly, that report/decision content stays English while the surrounding UI is localized.

## Constraints

- No streak counters or escalating guilt-based nudges anywhere in the check-in system — rules out common habit-app patterns (e.g. Duolingo-style streaks) by design.
- Voice must be a first-class interaction channel for check-ins, not a bolt-on to a text-only flow.
- No gamified visual layer (avatar, pet, plant, points, levels) in this version — deferred to keep build time focused on the core agent logic for the course deadline.
- No raw audio is retained beyond what's needed to produce the transcript — rules out storing voice check-in audio blobs long-term.
- All user input and agent output pass through a moderation check (Mistral Moderation 2) before being processed or shown — mandatory, not optional. See `stack.md` for the exact hook placement and per-category response (reject/clean-up/log).
- The "no streak-shaming/guilt language" rule must be mechanically verifiable, not just an asserted rule — enforced by a dedicated check on agent output, not left to the model's own judgment, under every personality setting (CAP-7).
- Chat topology: one thread per plan, plus a separate discovery chat thread used before a plan is chosen; follow-up questions are allowed within a plan's own thread.
- Model/provider pricing is never hardcoded - it lives in the model registry (see `stack.md`) as the single source, kept current with a `price_as_of` date per entry.
- Eval tooling is TypeScript-only; no Python eval packages. See `evals.md` for the full requirement (tooling, test composition, per-model run, report).
- All user-facing strings go through an i18n layer with translation keys, established from the first UI story onward - no hardcoded user-facing text in either language, ever.
- The Evaluation & Decisions page (CAP-11) requires sign-in like every other route (AD-17/`stack.md`; decided 2026-11-19: no public exception). It must never surface user-specific data, secrets, or private LangSmith trace links; this is verified by a dedicated test, not just asserted.
- Currency is a user setting (EUR or USD, default EUR), covering both CAP-8's cost display and CAP-2/CAP-5's income projections/idea budgets - not fixed in code, not inferred from UI language. Money is stored as integer minor units plus a currency code, never as a float. Converted amounts are always labeled as estimates (a single configured EUR/USD rate with an as-of date - no live FX API call). See `stack.md` for the full design.

## Non-goals

- Any agent concept other than Second Income Coach is out of scope - earlier ideation explored several alternatives before converging on this one.
- A gamified visual progress companion (a plant character that grows with progress) is out of scope for this version, deferred to v2.
- A fully polished, refined accountability experience is not a v1 goal — a short live class demo can't show behavior-over-time anyway, so CAP-4 is scoped functional-but-best-effort for initial delivery and will be refined after real personal use.

## Success signal

In a live class demo, intake through tailored idea generation through an initial timed plan runs end-to-end for a real attendee's actual constraints, visibly distinct from a generic listicle. Separately, the check-in loop (CAP-4) demonstrates at least one real check-in plus one simulated missed check-in with automatic timeline adjustment and no guilt/streak language.

## Assumptions

- Exact preselected range boundaries for the available-time, budget, and risk-tolerance intake fields are not specified in the source — left for Architecture/UX to define, not fixed here.
- Income projection (CAP-5) is estimated (baseline rate × logged hours, extrapolated by check-in consistency), not a live market-data integration; see `engagement-mechanics.md`.
- Specific retry counts and failure-fallback policies (e.g. voice-transcription failure falling back to text) are left for Architecture to define using the middleware mechanism in `stack.md`.
- Exact UI layout for settings (CAP-7), cost display (CAP-8), and feedback controls (CAP-9) is not specified here - left for UI implementation, not fixed in this spec.

## Open Questions

- Resolved: `mistral-large-4` was removed from the CAP-7 registry (too slow: it repeatedly hit the 15 s fallback timeout), so its provisional-id question no longer applies. The registry holds three selectable models (`gpt-6-luna` default, `gemini-3.8-flash`, `claude-haiku-4.5`).

