# Independent Review — ARCHITECTURE-SPINE.md (Second Income Coach)

Reviewer role: independent rubric walker, not the author. Target document:
`_bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md`
Checked against: `_bmad-output/specs/spec-second-income-coach/SPEC.md`, `stack.md`, `engagement-mechanics.md`.

Overall verdict: a well-structured, mostly-consistent spine with good traceability for the bulk of CAP-1..CAP-6, but it has one SPEC-constraint coverage gap (agent-output moderation), one real internal contradiction with no resolving tool (LLM-backed tools shown writing hard state that AD-4 says only plain-code tools may write), and a second internal inconsistency about where the baseline-rate web search actually happens. Several smaller sequencing/ownership gaps and one skipped operational sub-dimension (backend framework / secrets / streaming) round out the findings. Not a rewrite — these are fixable with edits to a handful of ADs plus one or two new tool/AD entries.

---

## 1. Divergence points fixed vs. missed

### 1.1 [HIGH] Agent-output moderation is claimed but not actually implemented
- AD-11's `Binds` line says "all (user input **and agent output**)", and SPEC.md's constraints explicitly require: "All user input **and agent output** pass through a moderation check (Mistral Moderation 2) before being processed or shown."
- But AD-11's `Rule` only wires Mistral Moderation 2 at two hook points: `before_model` (user input) and `wrap_tool_call` around `web_search` (untrusted external search results re-entering model context). Neither of these screens the agent's own final response text before it is shown to the user.
- AD-12 is a different, narrower mechanism: it is explicitly "not Mistral Moderation," and it is scoped only to CAP-4 responses (guilt/streak-language), not to all agent output, and not to jailbreak/PII categories.
- Net effect: there is no described hook that runs Mistral Moderation on the agent's outgoing response in general (e.g. CAP-2/CAP-3/CAP-5 responses, or CAP-4 responses for categories other than guilt-language). This is carried through identically in `stack.md`'s Moderation section, so it's not a one-off wording slip in the spine — the underlying design has the gap.
- This is a real coverage gap against the SPEC constraint, not just a documentation nit: two independently-built units could reasonably differ on whether/where output moderation happens, because no AD actually tells them to add it.
- Fix: either extend AD-11 with an explicit `after_model` (or equivalent) Mistral Moderation pass over the full agent output for all capabilities, or explicitly narrow the `Binds`/constraint-satisfaction claim and justify why output-side general moderation is not needed (unlikely to be defensible given the SPEC wording "mandatory, not optional").

### 1.2 [HIGH/MODERATE] No named mechanism persists generate_ideas'/create_plan's own output, and the diagrams contradict AD-4's letter
- AD-4's Rule states: "No tool that mutates intake/idea/step/check-in/plan/activation state is ever LLM-backed." Its own `generate_ideas`/`create_plan` tools are explicitly LLM-backed, "generation only."
- Yet the five generated ideas and the draft plan/steps clearly must land in the Postgres hard-state tables (AD-3) for the rest of the system (`set_idea_status`, `get_current_step`, `activate_plan`, etc.) to operate on them. No plain-code tool in the AD-4 list performs this initial insert — `set_idea_status` only flips status on *existing* idea rows; there is no analogous "save ideas" / "save plan" tool.
- The Dependency-direction diagram and the Structural-seed diagram both draw an arrow from `LLMT` (LLM-backed tools) directly to `PG` (Postgres hard state) — i.e., they depict exactly the thing AD-4's sentence, read literally, forbids.
- A charitable reading reconciles this (AD-4's "Prevents" list — intake submission, idea *status*, step completion, timeline math, projection math, plan activation — notably omits "idea/plan creation," so maybe mechanically saving one's own freshly-generated content was meant to be fine, while only post-hoc *decisions* about that state must be plain-code). But the document never says this explicitly, and AD-4's own sentence doesn't carve out this exception. Two builders could legitimately land in different places: one lets `generate_ideas`/`create_plan` do their own deterministic Postgres insert as a "mechanical save" at the end of an otherwise LLM-backed tool; another reads AD-4 literally and insists on a separate deterministic persistence tool (with the LLM-backed tool returning content only, per "generation only").
- Fix: add one clarifying sentence to AD-4 (or AD-3) stating explicitly whether an LLM-backed tool may perform the deterministic Postgres insert of its own freshly-generated content, or add the missing plain-code persistence tool(s) to the list and adjust the diagrams accordingly.

### 1.3 [MODERATE] Contradiction/ambiguity about where the baseline income rate is web-searched
- AD-6's Rule is clear and specific: the baseline rate is "sourced via `web_search` **at idea-generation time**," persisted on the idea/plan record, and `get_projection` "reads the stored rate; it is never re-fetched or silently recomputed later."
- But three other places in the same document describe it differently:
  - Namespace mapping (top of doc): "`web_search` ... shared by `generate_ideas` **and the baseline-rate sourcing behind `get_projection`**."
  - AD-5's Rule: "`web_search` ... is the one MCP tool used, for grounding CAP-2 idea suggestions **and CAP-5 baseline-rate research**."
  - Capability → Architecture Map: CAP-5's row lists `tools/plain/get_projection, tools/mcp/web_search` — implying `web_search` lives inside/behind `get_projection` itself.
- All three read naturally as "`get_projection` calls `web_search`," which directly contradicts AD-6's "never re-fetched" rule. If a builder implements from the namespace mapping or the capability map instead of AD-6's prose, they will wire a second, forbidden re-fetch path.
- Fix: reword the namespace mapping and AD-5 to say the baseline-rate research happens inside `generate_ideas` (CAP-2, at idea-generation time) and is merely *read* by `get_projection`; remove `web_search` from CAP-5's capability-map row (or annotate it as "read-only consumer of a value sourced under CAP-2").

### 1.4 [MODERATE] CAP-3's "only current + next step visible" rule has no clearly owning mechanism
- CAP-3's success criterion ("only the current and next step are visible at any time") is a hard, testable invariant, but no AD assigns it to a specific enforcement point. `get_current_step` is the obvious candidate (it's literally the read path), but it is not listed anywhere in the Capability → Architecture Map against CAP-3 (or even CAP-4, where it also does the missed-check-in detection per AD-15).
- This interacts with `engagement-mechanics.md`'s failure-pattern table, which for "gets stuck" says the next 2–3 steps are "always pre-staged internally, never just the current one" — implying a structural question (is the full ordered step list generated and stored at `create_plan` time uniformly for every failure pattern, with visibility purely a query-time filter in `get_current_step`? Or does generation itself vary by pattern?) that the spine never resolves.
- Fix: add `get_current_step` to the CAP-3 (and CAP-4) row of the Capability → Architecture Map, and add one sentence (to AD-3 or AD-13) stating that `create_plan` always generates/persists the full ordered step list up front and that visibility limiting is purely a `get_current_step` read-time filter.

### 1.5 [MODERATE] CAP-4's "energy/status input precedes any task ask" sequencing rule is untraced
- SPEC's CAP-4 intent requires "a lightweight energy/status input precedes any task ask" as a hard sequencing constraint. No AD or tool-boundary text in the spine names which tool represents this input or enforces the ordering.
- The most plausible mapping — `record_check_in` is the energy/status input, distinct from the task-oriented `start_step`/`complete_step` — is never stated. Without it, one builder could fold energy/status into the same tool call as the task "start," or skip the ordering constraint by asking about the task first.
- Fix: state explicitly (in AD-4 or a new line under CAP-4 in the map) that `record_check_in` is the energy/status check-in, that it must be called/answered before any `start_step` prompt is issued, and how that ordering is enforced (agent reasoning order vs. a structural gate).

### 1.6 [MINOR / open question] Idea bulk-status transition and bookmarked→plan sequencing are underspecified
- AD-13 states idea status transitions `suggested → selected | bookmarked | rejected`, but SPEC's CAP-2 wording ("the user selects one... the other 4 are retained as bookmarked") reads like selecting one idea *automatically* bulk-transitions the other 4 to `bookmarked`. AD-13 doesn't say whether that transition is automatic or requires a separate explicit per-idea action, leaving `suggested` vs `bookmarked` as the resting state for non-selected ideas ambiguous.
- Relatedly, CAP-6 says a user can "later activate a different bookmarked idea's plan without regenerating from scratch" — but CAP-3 only runs `create_plan` "once the user selects an idea." If "bookmarked" here really means "previously selected, now paused" (consistent with AD-13's pause/resume rule), that's fine and already covered; but if it can also mean an idea that was *never* selected/planned, it's unclear whether `activate_plan` implicitly triggers `create_plan` first or whether that's a separate required step.
- Low risk (likely resolves to the "paused plan" reading already covered by AD-13/AD-14), but worth one clarifying sentence.

---

## 2. Enforceability of AD Rules

Most Rules are enforceable by code-review/type-level inspection (AD-1 through AD-17 largely name specific packages, tool lists, or mechanisms a reviewer can check against). Notable exceptions / softenings:

- AD-11 (see §1.1): the Rule as written does not actually prevent what its own `Binds` claims it covers (agent output).
- AD-4 (see §1.2): the Rule's absolute wording ("no tool that mutates ... state is ever LLM-backed") is not fully consistent with the diagrams it's paired with, which weakens its enforceability as a bright-line test — a reviewer checking "did any LLM-backed tool write state" would get different answers depending on whether they trust the text or the diagram.
- AD-6 vs. AD-5/namespace mapping/capability map (see §1.3): same issue — the enforceable rule (AD-6) is undercut by contradicting text elsewhere that a builder might follow instead.
- The rest (AD-2, AD-3, AD-7 through AD-10, AD-12 through AD-17) are each internally enforceable and do prevent their stated divergence — e.g. AD-3's "service handles via `runtime.context`, never graph state fields" is enforceable almost for free by TypeScript's `GraphState` type shape; AD-8/AD-9/AD-10 cleanly separate interface from implementation and from compute location; AD-14 correctly reuses the runtime's own HITL primitive instead of inventing one; AD-15 correctly scopes itself to v1 only.

---

## 3. Deferred — load-bearing check

Walked every Deferred bullet for whether it could let two independently-built units diverge:

- **v2 voice** — safe; AD-8's interface contract is exactly what prevents divergence here.
- **Plant/gamification companion** — safe; pure non-goal, no interface depends on it.
- **Background-job missed-check-in detection** — safe; AD-15 fully specifies the v1 substitute (lazy detection in `get_current_step`), so nothing is silently load-bearing.
- **Exact Postgres schema (column-level)** — safe; only the backend (`db/`) touches Postgres directly per the tool list, so column-naming disagreement can't arise between independently-built units (there's only one unit touching this surface).
- **Exact preselected range boundaries for time/budget/risk-tolerance fields** — SPEC itself authorizes deferring this to "Architecture/UX." The spine correctly declines to invent values, but flags: as of this review, no UX companion document (DESIGN.md/EXPERIENCE.md) exists yet in the architecture folder. This is safe only as long as those boundaries get fixed in one place (Zod schema, per AD-16) before both frontend and backend are built from it — currently there is no document that owns this yet, so it is deferred correctly but not yet *resolved* anywhere.
- **Final adoption of Mistral Moderation 2** — self-flagged already as pending evaluation; this is the right way to defer it (mechanism/hook-placement is fixed and mandatory per AD-11, only the specific model is pending), not a finding beyond what's already disclosed.
- **UI visual design** — correctly out of scope for this spine/altitude.
- **Exact retry counts/timeouts/backoff** — safe; AD-7 fixes the mechanism and which tool classes get which policy shape, only the numbers are deferred, and nothing about cross-unit divergence depends on knowing the number in advance.

No deferred item was found to be secretly load-bearing beyond the time/budget/risk boundary caveat above (which is a "not yet resolved," not a design flaw).

---

## 4. Named tech currency — flags, not re-verification

Per instructions, these are flagged as asserted-from-training-data-shaped claims this reviewer could not independently re-verify (reviewer's own knowledge cutoff is January 2026; several of these claims are dated after that cutoff), not claims known to be wrong:

- `gpt-transcribe` "2026-07-29 release"; `whisper-1`/`gpt-4o-transcribe`/`gpt-4o-mini-transcribe` "deprecated August 2026... leaves the API February 2027" (AD-9, stack.md) — specific, falsifiable, post-cutoff dates. AD-9 is tagged `[VERIFIED]`, which is the right instinct given how load-bearing the voice-model choice is (it drove a supersession of an earlier decision) — flagging only because the specificity of the exact dates is worth double-checking against OpenAI's actual deprecation notice before this is treated as closed, if that hasn't already happened via a web-search-backed check.
- `mistral-moderation-2603` (Mistral Moderation 2, "March 2026") — post-cutoff, unverified by this reviewer. Already self-flagged in Deferred as pending evaluation, which is the correct hedge regardless.
- `gpt-audio-mini-2025-12-15` — pinned as an exact dated snapshot for v2, which is explicitly deferred/not-being-built-now work. Pinning an exact snapshot this far ahead of actual use risks staleness by the time v2 is built; consider noting "current `gpt-audio-mini` release at v2 build time" instead of hard-pinning today's snapshot id. Minor.
- TypeScript 7.0.2, Vite 8, `langchain@1.5.18`/`@langchain/core@1.2.18`, LangGraph.js 1.4.x, `@langchain/mcp-adapters` 2.0+ — plausible given the document's Nov 2026 date and known release cadences (e.g. Node's even-year LTS promotion pattern checks out independently of any single fact lookup), but these specific patch/minor numbers are beyond this reviewer's training knowledge to confirm.
- By contrast, the deployment/infra claims (Cloud Run's always-free 2M req/month scale-to-zero tier, Neon's auto-wake-on-query vs. Supabase's free-tier pause-and-manual-resume, Cloud SQL's lack of a perpetual free tier) are all consistent with this reviewer's own training-era knowledge and read as checked/correct, not just asserted.
- Documentation nit: version-currency verification is only tagged at the AD level (`[VERIFIED]` appears on AD-1, AD-2, AD-5, AD-7, AD-9, AD-14), not at the Stack-table row level, so a reader can't tell from the table alone which of the many precise version/date claims were actually checked vs. carried over from general knowledge.

---

## 5. Dimensions this altitude owns — silence check

Checked systematically for a dimension left completely silent (not deferred, not decided, just absent):

- **Deployment & environments** — present and reasonably thorough (Local → Cloud Run + Neon, with explicit comparative rationale against Supabase and Cloud SQL). Good.
- **Infra/provider strategy** — present (Cloud Run + Neon chosen with reasons).
- **Operations — secrets/config management** — **silent**. No mention anywhere of how API keys (OpenAI/voice model, Mistral Moderation, the web-search MCP provider, Google OAuth client secret, LangSmith) are managed or differ between local `.env` and Cloud Run deployment (e.g. Secret Manager vs. plain env vars). Not in Deferred either. For a solo course project this is low-stakes but it is a genuinely silent sub-dimension the checklist asks to watch for.
- **Backend HTTP framework** — **silent**. The source tree names an `api/` layer ("Node backend HTTP API consumed by frontend") but no framework (Express/Fastify/Hono/Next route handlers/etc.) is named anywhere, unlike every other layer in the Stack table which is pinned to a specific package and version.
- **Streaming/response delivery model** — **silent**. For a chat-like agent with voice check-ins, whether agent responses are streamed token-by-token to the frontend or returned as a single response is architecturally relevant (affects API shape, AD-16's schemas, and perceived latency) and isn't addressed.
- **Session ↔ LangGraph thread-id mapping** — **silent**. AD-17 establishes *that* Google OAuth is required, but not how an authenticated user's identity maps to a LangGraph thread/checkpointer key, nor whether CAP-1/CAP-2/CAP-3 (which also produce per-user Postgres records per AD-3) require auth from the start or can run anonymously before a later login binds the data to a user. This is the one place AD-17's scope ("CAP-4 and any capability reading per-user persisted state") is a bit too hand-wavy given CAP-1/2/3 output is also per-user state.
- **Observability/logging beyond LangSmith** — present but thin (LangSmith named for tracing); acceptable for this altitude, not flagged as a finding.
- **Error-response contract** — not explicit (AD-16's Zod-schema umbrella plausibly covers it but doesn't say so); minor, not elevated to a full finding.

---

## 6. Contradictions / duplication between ADs

- Contradiction: AD-11's `Binds` vs. its `Rule` (§1.1).
- Contradiction: AD-4's absolute "no LLM-backed tool mutates state" vs. the diagrams' `LLMT → PG` arrow and the missing persistence tool (§1.2).
- Contradiction: AD-6's "sourced at idea-generation time, read-only afterward" vs. the namespace mapping / AD-5 / capability-map's "baseline-rate sourcing behind `get_projection`" framing (§1.3).
- No pure duplication found: AD-9 vs. AD-10 overlap on voice but each adds a distinct constraint (pipeline shape vs. compute/capture location); AD-11 vs. AD-12 overlap on being `after`/`before`-model hooks but cover disjoint categories with an explicit stated reason (AD-12: "Mistral Moderation has no category for this"). No AD was found to be a no-op restatement of another.

---

## Summary table

| # | Finding | Severity |
|---|---|---|
| 1.1 | Agent-output Mistral Moderation claimed (`Binds`) but not actually wired by AD-11's Rule; SPEC constraint not fully met | High |
| 1.2 | No named tool persists `generate_ideas`/`create_plan` output; contradicts AD-4's literal wording and the diagrams | High/Moderate |
| 1.3 | Baseline-rate web-search location contradicted across namespace mapping / AD-5 / capability map vs. AD-6's actual rule | Moderate |
| 1.4 | CAP-3 "current+next step only" visibility rule has no owning mechanism; `get_current_step` missing from capability map | Moderate |
| 1.5 | CAP-4 "energy/status input precedes any task ask" sequencing untraced to any tool/AD | Moderate |
| 1.6 | Idea bulk bookmark-on-select transition, and bookmarked-idea→plan sequencing, underspecified | Minor/open question |
| 4 | Several precise post-cutoff model/version dates asserted without row-level verification marker | Minor |
| 4 | `gpt-audio-mini-2025-12-15` hard-pinned for explicitly deferred v2 work | Minor |
| 5 | Secrets/config management across local vs. Cloud Run environments — silent | Minor |
| 5 | Backend HTTP framework unnamed despite `api/` layer existing in source tree | Minor |
| 5 | Streaming vs. request/response delivery model for agent output — silent | Minor |
| 5 | Session-to-LangGraph-thread-id mapping, and whether auth gates CAP-1/2/3 too — silent | Minor |
