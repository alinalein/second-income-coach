# Known Weaknesses, Improvement Suggestions & Grading Traceability

Technical background for anything below: [`TECHNICAL-RATIONALE.md`](TECHNICAL-RATIONALE.md). Numbers below are the real figures from the committed [`src/evals/published/eval-results.json`](../src/evals/published/eval-results.json) (run date 2026-11-19), never rounded up.

## Known weaknesses & improvement suggestions

Trimmed to the most significant weaknesses (short "Weakness" headline, max ~8 words, with the full detail in Impact/Suggestion) — see git history for the previously-removed KW-2/KW-7/KW-8/KW-9 entries (voice v2 deferral, search-budget tuning, eval-only cost bookkeeping, registry price re-verification) if that detail is needed again.

| ID | Weakness | Impact | Suggestion |
|---|---|---|---|
| KW-1 | No proactive push or email reminders yet. | A user who doesn't reopen the app never gets a proactive nudge; the timeline only re-adjusts on their next visit. | Add a scheduled job (e.g. Cloud Scheduler) plus a notification channel (push/email) once a channel is actually available; keep the lazy check as the fallback. |
| KW-3 | Mistral jailbreak filter catches only half. | Moderation alone would miss half of these specific injection phrasings; the system doesn't depend on moderation alone for this — the agent's own rules plus the dedicated outcome-based guardrail tests (8/8 passing) catch all four regardless of Mistral's score. | Treat Mistral Moderation 2 as still pending its own full validation against a labelled test set (unchanged open item from the architecture spine); don't rely on its jailbreak score alone as the injection defense. |
| KW-4 | 3 of 32 judge scores errored. | The quality score for those cases is missing, shown as an explicit error row, never a fabricated score. The two judges are occasionally slow, and one model is occasionally too slow for its node timeout. | Re-run the affected cases, or raise the judge timeout / node timeout for quality cases; keep the explicit error-row mechanism. |
| KW-5 | One judge also scores its own model. | A self-judged score could be biased relative to the other models it also judges. | The report already discloses which judge scored which model (see table below); keep this overlap or swap in a third, non-registry judge if stricter independence is wanted later. |
| KW-6 | No load testing at demo scale. | Unknown behavior under concurrent real users; cold-start/scale-to-zero behavior is only validated once deployed. | Load-test after Story 7.3 deploy; monitor Cloud Run cold-start latency against Neon's auto-wake in practice. |

## Edge cases and potential problems

| ID | Scenario | What happens | Suggestion |
|---|---|---|---|
| EC-1 | The user lives outside UTC. | "Once per day" (the energy question) and missed-day counting use UTC calendar days, so a day can start or end at an odd local hour. | Store the user's time zone and compute days in it. |
| EC-2 | The user asks the plan chat about a step that is neither current nor next (e.g. "what exactly was step 3?"). | The model only sees the current and next step (AD-4 cap), so it cannot answer and says so instead of guessing. Found in end-to-end testing. | Let `get_current_step` also return already-completed steps (past steps carry no spoiler risk); keep the cap for future steps. |
| EC-3 | The user clicks through plans and actions very quickly. | The rate limits can answer 429 (general 600/min, plan actions 40/min after being raised). The UI recovers on the next request. | Show a short "slow down" notice instead of a raw error. |
| EC-4 | One idea of a batch fails (timeout, unsupported income rate). | The failing slot is dropped instead of failing the whole batch, so fewer than `IDEAS_PER_BATCH` ideas can be returned. | Offer "generate one more" automatically when a batch is short. |

## Code improvement suggestions

| ID | Suggestion | Why |
|---|---|---|
| CI-2 | Add one browser end-to-end smoke test (intake, ideas, select, activate, check in, projection). | Today the full journey is only checked by hand; unit and eval tests do not cover the UI-to-API wiring. |
| CI-3 | Model the `generate_ideas` pipeline (search, draft, validate, retry) as an explicit LangGraph `StateGraph`. | Timeouts and retries would then be set per node, and the flow could be drawn and traced step by step. |
| CI-4 | Validate Mistral's jailbreak category against a labelled test set (see KW-3) and add the cases the agent rules alone currently catch. | The filter flagged 2 of 4 injection inputs; a larger set shows the real detection rate. |

## Grading traceability

| Grading criterion | Evidence |
|---|---|
| Agent Purpose | [README § What it does](../README.md#what-it-does), [README § Usefulness](../README.md#usefulness) |
| Core Functionality | [README § Example Use Case](../README.md#example-use-case), [TECHNICAL-RATIONALE § Agent loop](TECHNICAL-RATIONALE.md#agent-loop), [TECHNICAL-RATIONALE § Tool boundary](TECHNICAL-RATIONALE.md#tool-boundary-llm-backed-vs-plain-code-vs-mcp), `src/tools/`, `src/evals/published/eval-results.json` (100% tool-call accuracy for all 4 models, 13/13 each, above the 80% target; 55/55 guardrail tests passing) |
| User Interface | `web/src/` (React app), [README § Getting started](../README.md#getting-started) |
| Technical Implementation | [TECHNICAL-RATIONALE.md](TECHNICAL-RATIONALE.md) in full (agent shape, tool boundary, error handling, security, idea generation, models/cost, memory), [README § Project structure](../README.md#project-structure), [ARCHITECTURE-SPINE.md](../_bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md) |
| Documentation / reflection | [README.md](../README.md), [TECHNICAL-RATIONALE.md](TECHNICAL-RATIONALE.md), this document, the **Quality & Decisions page** (`/quality`, signed-in only, linked from the sidebar footer — Story 7.5) |

## Eval numbers behind the table above (verbatim from `eval-results.json`)

- **Trajectory/tool-call accuracy** (target 80% per model, 13 deterministic cases each): `openai/gpt-6-luna` 13/13 (100%), `google/gemini-3.8-flash` 13/13 (100%), `anthropic/claude-haiku-4.5` 13/13 (100%), `anthropic/claude-sonnet-5.5` 13/13 (100%).
- **Safety/guardrail suites** (100% pass bar, zero tolerance): 55/55 passing across direct prompt-injection (8/8), `web_search` moderation (5/5), general moderation (22/22), guilt/streak-language (19/19), and the `activate_plan` HITL-bypass negative test (1/1).
- **Judges**: `google/gemini-3.8-flash` and `deepseek/deepseek-v4.1-flash`, each scoring all 4 models' quality cases. `google/gemini-3.8-flash` is also a user-selectable registry entry (see KW-5); `deepseek/deepseek-v4.1-flash` is judge-only.
- **Cost**: total estimated $0.1168 across the three priced models' eval-run calls (`openai/gpt-6-luna` $0.0031, `google/gemini-3.8-flash` $0.0497, `anthropic/claude-haiku-4.5` $0.0640); `anthropic/claude-sonnet-5.5` (eval-only, no registry price, AD-20) and both judges' own calls are excluded from this figure.
