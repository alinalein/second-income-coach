---
name: "Adversarial Review — Second Income Coach Architecture Spine"
lens: adversarial (spine-attack)
target: architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md
reviewed-against: specs/spec-second-income-coach/{SPEC.md, stack.md, engagement-mechanics.md}
method: "For each AD, construct two concrete implementations that each satisfy the AD's literal text, and check whether they interoperate. A pair that both satisfy the letter but diverge in behavior/shape is a hole in the AD."
date: 2026-11-13
---

# Adversarial Review

## Method note

This is not a restatement of the ADs. Every finding below is a constructed pair of implementations — "Builder A" and "Builder B" — that each independently read only the spine's text (plus the SPEC/companions for intent) and produce something that passes a literal compliance check against the cited AD(s), yet the two builds clash: different persisted shapes, two writers of one entity, or different state-mutation outcomes for the same sequence of calls. Severity is about how likely the ambiguity is to actually get exploited by two different build sessions (or by the same AI builder on two different days) and how bad the resulting bug is.

---

## F1 — AD-3 contradicts itself on who owns "current step" / "selected plan id" — CRITICAL

AD-3 rule (1) says plan/progress facts including **"active step"** and **"idea/plan status"** must live in dedicated Postgres tables that tools read/write directly, specifically to prevent them "ever being reconstructed differently from fuzzy retrieved memory." Rule (2) says the LangGraph checkpointer/Store are "reserved for conversational context only, never for these facts." Then rule (3), in the very same AD, gives as its own example of what *graph state* legitimately holds: **"intake values, selected idea/plan id, current step."**

In LangGraph, fields placed in the graph's state schema are exactly what the checkpointer snapshots on every superstep — "graph state" and "the checkpointer" are not two independent places, the checkpointer persists the state object. So rule (3)'s example directly contradicts rules (1)+(2): it puts "current step" and "selected plan id" — facts rule (1) names explicitly — into the one mechanism rule (2) just forbade them from.

Two builders reading this AD in good faith diverge completely:

- **Builder A** (follows rule 1/2 strictly): never adds `current_step`/`selected_plan_id` to the graph state schema at all. Every node that needs them calls `get_current_step` (a Postgres read) fresh, every turn. Graph state ends up holding only `intake` scratch values — contradicting rule (3)'s own example.
- **Builder B** (follows rule 3 literally): adds `selectedPlanId` and `currentStep` as real fields on the LangGraph state schema, populated once and then read from the (checkpointed) state object by subsequent nodes in the same run as a "cache" for convenience/performance.

Builder B's approach reintroduces precisely the bug rule (1) exists to prevent: if `complete_step` (a plain-code Postgres tool) advances the step pointer mid-run, but the already-loaded graph-state copy of `currentStep` isn't simultaneously patched in the same object (a very easy omission — the tool mutates Postgres, nothing forces it to also return an updated state patch that every caller applies), the next reasoning step in that same thread sees a stale `currentStep` from the checkpointer while Postgres has already moved on. Two builds that both "obey AD-3" produce opposite answers to "is it ever OK for a hard-state fact to appear as a graph-state field," and only one of them is actually safe.

**Fix direction:** AD-3 needs to either (a) strike "selected idea/plan id, current step" from the graph-state example and replace it with something that really is pure conversational/session scratch (e.g., "which step is the user currently discussing in this turn," re-derived from a `get_current_step` call, not persisted across turns in state), or (b) explicitly bless graph-state caching of these fields but mandate that every plain-code tool that mutates the underlying Postgres fact also returns a state patch that is applied atomically in the same graph step, with Postgres as the sole tiebreaker on next read. As written, both readings are "compliant."

---

## F2 — "Exactly one plan active at a time" admits non-interoperable enforcement strategies — CRITICAL

AD-13 states the invariant ("Only one plan may be `active` at a time") and AD-14 states the mechanism (`interrupt()`/`Command(resume=...)`, confirm → active + pause previous). Neither AD mandates *how* the invariant is enforced at the data layer, nor whether it is scoped per-user.

**Divergent-but-compliant pair:**

- **Builder A:** `activate_plan` runs both writes (pause currently-active plan, activate target plan) inside a single DB transaction with `SELECT ... FOR UPDATE` row-locking on the user's plan rows, backstopped by a partial unique index (`CREATE UNIQUE INDEX ... ON plans(user_id) WHERE status = 'active'`) as a hard guarantee.
- **Builder B:** `activate_plan` issues the same two logical updates as two separate, non-transactional statements ("UPDATE plans SET status='paused' WHERE user_id=$1 AND status='active'" then "UPDATE plans SET status='active' WHERE id=$2"), relying on "the tool is only ever called once per confirm" as the de facto invariant. No DB constraint backstops it.

Both satisfy AD-13/AD-14's text literally — neither AD says "in a transaction," "with a uniqueness constraint," or "idempotently." But AD-7 independently mandates that Postgres plain-code tools (which `activate_plan` is, per AD-4's own listing) get **"short timeouts and a fast retry policy."** Combine that with Builder B: a double-click, two open tabs for the same user, or a client retry after a dropped response (the call actually succeeded server-side but the client never saw the ack, then AD-7's fast-retry fires a second `activate_plan` with the same or a different target) can interleave the two non-transactional UPDATEs across two concurrent executions and leave **zero or two** active plans, depending on timing — exactly the state AD-13 says must never happen. Builder A is race-proof; Builder B is not; both are literal-text compliant.

Separately: AD-13's rule text never says **"per user."** CAP-6's success line ("confirming never leaves more than one plan active at once") also doesn't say per-user. A literal-but-absurd compliant reading is a single global active-plan singleton across the whole system — nothing in AD-13 itself rules this out; it's only inferable from AD-17's unrelated statement that auth exists. Tighten AD-13 to say "per user."

**Fix direction:** AD-13/AD-14 should state the enforcement mechanism (transaction + DB-level uniqueness constraint on `(user_id) WHERE status='active'`, not just the application-level invariant description) and explicitly scope it "per user." Also state that `activate_plan` must be idempotent under retry (e.g., keyed by a client-supplied idempotency token or by making the resume value's target plan id the sole source of truth re-derived fresh on every attempt).

---

## F3 — `failurePattern` enum: DB representation isn't bound to the same source of truth the tool-boundary Zod schema is — HIGH

AD-4 fixes that `submit_intake` takes `failurePattern` as a Zod-enum argument and that `create_plan` only ever reads the stored value. AD-16 fixes that Zod schemas live in one shared location for **tool inputs/outputs and API requests/responses** — it says nothing about Postgres migrations/constraints deriving from that same enum.

- **Builder A:** `failure_pattern` column is `TEXT` with a `CHECK` constraint whose literal list is hand-copied from the Zod enum at migration-authoring time.
- **Builder B:** `failure_pattern` is a Postgres native `ENUM` type (or an integer code with a separate lookup table joined at read time), independently declared in a migration file, "for efficiency."

Nothing in AD-16 forces either DB-side list to be generated from (or validated against) the Zod enum — it's a second, hand-maintained copy of the same five literal values in both builds, just in different shapes. A typo'd or reordered value in the DB-side `CHECK`/`ENUM` (e.g., `"gets_stuck_no_next_step"` vs `"stuck_no_next_step"`) or a renumbered lookup-table code in Builder B silently makes `create_plan`'s read of the stored value diverge from what the agent believes it submitted — exactly the "divergent interpretation of the enum across tools" scenario the user asked to probe for, and no AD catches it because AD-16's binding scope stops at the tool/API boundary, not the DB schema.

Compounding gap: no AD says what happens when the top-level agent's free-text classification doesn't cleanly land on one of the five values (model drift producing a sixth value, which the Zod enum will reject at the tool-call boundary). AD-7's blanket "Postgres plain-code tools get... a fast retry policy" doesn't distinguish a Zod validation failure (deterministically fails identically on every retry) from a transient DB error — and AD-7's own text ("never duplicated inside middleware") reads as forbidding the only sane fix (a `wrap_tool_call` that catches the validation error and re-prompts the model with corrective feedback instead of blindly retrying the same bad call).

**Fix direction:** AD-16 (or a new AD) should require the DB-side constraint/enum type to be generated from, or round-trip-tested against, the same Zod enum — not independently authored. AD-7 should explicitly carve out tool-input validation errors as non-retryable-as-is and state where the corrective-reprompt logic lives.

---

## F4 — Voice interface contract (AD-8) under-specifies statefulness and v1 method coverage — HIGH

AD-8 fixes the method *names* (`transcribeCheckIn`/`speakResponse`) and the non-leakage guarantee, but not the signatures, nor whether the interface must be side-effect-free.

- **Builder A:** `transcribeCheckIn(audio): Promise<{transcript}>` is a pure function; all persistence happens afterward, only through `record_check_in`.
- **Builder B:** `transcribeCheckIn(audio, userId, sessionCtx): Promise<{transcript, pendingCheckInId}>` also writes a pending/draft check-in row to Postgres as a side effect, so a page refresh during transcript review doesn't lose the in-progress check-in.

Builder B makes the voice layer a second writer of check-in hard state alongside `record_check_in` — and it breaks the exact guarantee AD-8 exists to provide. AD-9 states that v2 (`gpt-audio-mini` speech-to-speech) **removes the transcript-review step entirely**. There is no "pending transcript" stage in v2's flow, so Builder B's pending-row mechanism has no v2 analog: swapping v1→v2 now *does* require touching check-in logic (ripping out or bypassing the pending-row writes), which is precisely what AD-8's "prevents" clause rules out. Builder A's swap is clean; Builder B's isn't — both built "one interface contract."

Second, narrower ambiguity: AD-9/AD-10 only name `gpt-transcribe` as v1's voice model — no TTS model is named for v1 at all. So does v1 implement `speakResponse`? Builder A stubs it to throw/no-op (never called in v1's UI flow). Builder B wires `speakResponse` in v1 to the browser's built-in Web Speech API, client-side — arguably not violating AD-10's "only the backend calls the voice model" (a browser built-in isn't one of the named voice models), but reintroducing exactly the client-side voice code path AD-10 was written to prevent, and making "the rest of CAP-4 calls through the interface" asymmetric between the two methods in ways no AD addresses.

**Fix direction:** Pin the interface to explicit signatures (including return shape) in the spine or a schema file, state explicitly that both methods must be pure/side-effect-free with respect to hard state (all persistence goes through the named plain-code tools only), and state what v1 does for `speakResponse` (even if the answer is "not implemented in v1; CAP-4 never calls it in the v1 build").

---

## F5 — Moderation (AD-11) vs. resilience caching (AD-7) ordering on `web_search` is unspecified, and the gap is a real exploit path — HIGH

This is the exact seam the brief called out. AD-7 says `web_search` gets a short-TTL `CachePolicy` at the **node level**, shared "across users/sessions." AD-11 says `wrap_tool_call` around `web_search` screens results **before they re-enter model context**. Neither AD says whether the cache sits inside or outside the moderation wrap.

- **Builder A:** treats `wrap_tool_call` as wrapping the full call path, including cache lookups — every cache hit is re-screened by moderation before being handed back to the model. Safe, if wasteful (extra moderation calls on every cache hit).
- **Builder B:** takes the more natural reading of "wrap_tool_call around web_search" as instrumenting the actual network-calling function — so the `CachePolicy` short-circuits *before* `wrap_tool_call` ever runs on a hit, because the node-level cache sits at a layer below the middleware. The value written into the cache is whatever the raw tool returned, captured before moderation had a chance to strip anything.

Under Builder B, the **first** call that populates a given cache key gets moderated once; every subsequent cache hit for that key — for a different user, in a different session, for the duration of the TTL — serves the raw, unmoderated search text straight into that user's model context. Since AD-7 explicitly justifies the cache's existence by saying results "repeat across users/sessions," this isn't a theoretical edge case — it's the cache's whole purpose, and it's also exactly the blast radius: one flagged jailbreak-poisoned or PII-laden search snippet, cached once, bypasses AD-11 for everyone who triggers the same query until the TTL expires. Both builders can point to AD-7's and AD-11's text and claim compliance.

Secondary version of the same gap: when `web_search` throws transiently and AD-7's node-level `RetryPolicy` retries automatically, nothing says whether `wrap_tool_call`'s moderation screening (and its "log the incident" obligation) re-runs per retry attempt or only on the final returned result — divergent builds will produce divergent, and differently-noisy, moderation-incident logs for what's logically one call.

**Fix direction:** State explicitly that the `CachePolicy` boundary is *inside* the moderation wrap — i.e., cached values must always be the post-moderation (cleaned) result, and a cache hit still passes back through (or is exempt from re-running, having already been cleaned once, with that fact recorded) rather than silently bypassing AD-11. This needs to be an explicit ordering rule, not left to "wrap_tool_call around web_search."

---

## F6 — AD-12's guilt-language regeneration loop has no stated bound or resilience-policy home — MEDIUM

AD-12: "On trigger: clean up (regenerate the response without the flagged phrasing), always logged." No cap on regeneration attempts is stated, and AD-7's per-node resilience overrides are keyed to `generate_ideas`/`create_plan`/`web_search`/"Postgres plain-code tools" — the top-level model-response node that AD-12 regenerates on isn't in that list.

- **Builder A:** regenerates once; if the check fires a second time, falls back to a fixed, pre-written neutral message rather than looping.
- **Builder B:** loops regeneration unconditionally until the check passes, with no cap and no assigned timeout budget (since AD-7 doesn't name this node), risking an unbounded loop if the model keeps reproducing flagged phrasing on a particular input, and no AD-level ownership of "whose resilience policy bounds this."

Both are "clean up (regenerate)" compliant. Only Builder A is guaranteed to terminate.

**Fix direction:** AD-12 should state a maximum regeneration attempt count and a deterministic fallback message/behavior if the cap is hit, and AD-7 should either name this node explicitly in its per-node override list or state that it inherits the generic model-node default.

---

## F7 — Plan-revision semantics: no terminal/superseded status, so "revised draft" has two incompatible shapes — HIGH

AD-13's plan status enum is only `draft → active | paused`. AD-14: "Reject → feedback routes back into `create_plan` for a revised draft." The AD never says whether a revision updates the existing draft row in place or creates a new row, and there is no status value for "this draft was superseded."

- **Builder A:** `create_plan` on revision `UPDATE`s the existing draft row in place — exactly one row per idea, always.
- **Builder B:** `create_plan` on revision `INSERT`s a brand-new draft row, leaving the rejected one dangling at `status='draft'` forever (there's no status to move it to). Now two-or-more rows satisfy `status='draft'` for the same idea.

This directly threatens CAP-6's own stated success criterion ("switching to a previously paused plan resumes it rather than recreating it") under Builder B: any lookup of "the draft for this idea" is now ambiguous, and whichever row `activate_plan`'s resume value actually points to depends on client/session bookkeeping that no AD specifies. It also compounds with AD-6 ("baseline rate persisted on the idea/plan's Postgres record" — ambiguous as to which of the two entities is canonical): if Builder B denormalizes the baseline rate onto each plan row rather than joining through the idea, its multiple draft rows per idea can each carry independently-drifted copies of what AD-6 insists must be a single frozen value.

**Fix direction:** Add an explicit plan-revision rule: either mandate in-place update of the current draft row (simplest, and matches "a revised draft" singular wording), or add a `superseded` status and specify exactly which row every subsequent lookup (`activate_plan`, "resume this idea") must target. Resolve AD-6's "idea/plan" disjunction to one canonical owner (idea, since the rate is sourced "at idea-generation time").

---

## F8 — Step-progression state machine ("current step") is a behavioral gap, not just a schema detail — MEDIUM

`get_current_step`, `start_step`, and `complete_step` are three separate plain-code tools (AD-4), but no AD defines what "current step" means in the window between a `start_step` call and its matching `complete_step` — i.e., once a step has been started but not finished, is it still "current," or does "current" always mean "the next not-yet-started step"? CAP-3 requires revealing "only the current and immediate-next step," so this isn't cosmetic.

- **Builder A:** single pointer (`current_step_id`), advanced only by `complete_step`; `start_step` merely timestamps the step row.
- **Builder B:** two pointers (`active_step_id` set by `start_step`, separate from the completed-through index used by `complete_step`).

`get_current_step`'s answer to "what's current/next" differs between the two builds precisely during that in-between window — a user who has started but not finished a step sees different plan-progress framing depending on which builder wrote the backend. The spine defers this ("Exact Postgres schema (column-level detail) — left for implementation") but this is a state-machine/behavioral decision CAP-3/CAP-4 depend on, not a column-naming choice.

**Fix direction:** AD-3 or AD-4 should state the step-progression state machine explicitly (e.g., "current" = the earliest step not yet `complete_step`'d; `start_step` only records an acknowledgment timestamp and never changes which step is "current").

---

## F9 — Idea→plan generation timing is unpinned, and the two natural readings differ 5x in cost and in whether CAP-6's guarantee even holds — MEDIUM

No AD fixes *when* `create_plan` first runs for a given idea.

- **Builder A:** calls `create_plan` eagerly for all 5 suggested ideas right after `generate_ideas` returns — 5 LLM calls per completed intake. Every idea already has a `draft`/`paused` plan, so "switch to a bookmarked idea's plan without regenerating" (CAP-6 success) is trivially true from the start.
- **Builder B:** calls `create_plan` lazily, only the first time an idea transitions to `selected` — matching CAP-3's literal wording ("Once the user selects an idea, the agent produces a draft plan"). Bookmarked-but-never-selected ideas have zero plan rows. The *first* time a user switches to a previously-only-bookmarked idea, standing up its first plan is indistinguishable from "regenerating from scratch" — because there is nothing to resume yet — which contradicts the literal wording of CAP-6's success criterion for that first switch.

Neither AD-4, AD-13, nor AD-14 pins generation timing, so both are spine-compliant, yet they differ 5x in LLM-call volume per intake and disagree on whether CAP-6's "without regenerating from scratch" guarantee actually holds the first time a user explores a bookmarked idea.

**Fix direction:** State explicitly when `create_plan` is triggered relative to idea status transitions (e.g., "a draft plan is created the first time an idea is selected or explicitly opened for preview; CAP-6's no-regeneration guarantee applies from the second visit onward" — or commit to eager generation for all 5 if the LLM-call budget allows it).

---

## F10 — Audio-retention window ("no longer than needed to produce the transcript") has two compliant endpoints — LOW

AD-9/AD-10: "No raw audio is retained beyond what's needed to produce the transcript."

- **Builder A:** deletes the audio the instant the transcription call returns.
- **Builder B:** retains the audio until the user confirms/submits the edited transcript, reasoning that a re-record/re-transcribe affordance during review is part of "what's needed."

Both are "no longer than needed" — they just disagree on where "needed" ends. Low severity (privacy exposure window differs by seconds-to-minutes, not an architectural clash), but worth tightening since it's a stated compliance constraint, not just an implementation nicety.

**Fix direction:** State the exact endpoint (e.g., "deleted immediately after the transcription call returns; no re-transcribe affordance in v1").

---

## F11 — CAP-5 projection formula isn't pinned by any AD — LOW (flagged for completeness)

The "baseline rate × hours × consistency" formula lives only in `engagement-mechanics.md` (non-normative companion), not in any AD. "Consistency rate" could be a trailing-window completion ratio or an all-time-since-activation ratio — two equally AD-compliant `get_projection` implementations (both deterministic, both reading the AD-6-persisted baseline rate, both plain-code per AD-4) produce different numeric output for identical underlying data. This doesn't violate any AD's letter — none of AD-4/AD-5/AD-6 touches the formula itself — but it's the kind of exploitable gap the brief asked to surface, and CAP-5's own success criterion ("the projection value changes between two check-ins with different actual progress") is satisfied by both, hiding the divergence from the stated verification test.

**Fix direction:** Either promote the formula from `engagement-mechanics.md` into an AD (pin the consistency-window definition), or explicitly mark it as intentionally unpinned/left to implementation discretion so it isn't silently assumed to be architecture-level-fixed.

---

## Summary table

| # | Seam | Severity |
|---|------|----------|
| F1 | AD-3 self-contradicts on graph-state vs. Postgres ownership of current-step/plan-id | Critical |
| F2 | "Exactly one active plan" — no mandated transaction/constraint/per-user scope | Critical |
| F3 | `failurePattern` enum DB representation not bound to the Zod source of truth | High |
| F4 | Voice interface contract under-specifies statefulness and v1 `speakResponse` coverage | High |
| F5 | Moderation-vs-cache ordering on `web_search` can silently bypass AD-11 | High |
| F6 | AD-12 regeneration loop has no cap or resilience-policy home | Medium |
| F7 | Plan-revision has no terminal/superseded status — ambiguous row identity | High |
| F8 | Step-progression state machine (current/start/complete) undefined | Medium |
| F9 | Idea→plan generation timing unpinned (eager vs. lazy, 5x cost difference) | Medium |
| F10 | Audio-retention window endpoint ambiguous | Low |
| F11 | CAP-5 projection formula not pinned by any AD | Low |
