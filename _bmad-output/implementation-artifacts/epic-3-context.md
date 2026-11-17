# Epic 3 Context: Plan Creation & Activation

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users turn a chosen idea into a concrete, timed plan broken into small steps, and must explicitly confirm it before it goes live - so they always know exactly what to do first and are never stuck with a plan they didn't agree to. They can later switch which bookmarked idea's plan is active without losing progress on the others. This epic also delivers the plan workspace shell - the single unified screen (status + chat) that this epic, Epic 4, and parts of Epic 5 all build into.

## Stories

- Story 3.1: Draft Plan Generation with Failure-Pattern-Aware Steps
- Story 3.2: Human-Confirmed Plan Activation
- Story 3.3: Switching Between Plans

## Requirements & Constraints

- `create_plan` produces ordered steps with a timeline, saved as `draft` (never active); it runs lazily - only on an idea's first selection, or re-selection with no existing plan - never eagerly for all bookmarked ideas.
- Step granularity reflects the user's classified `failurePattern` (e.g. smaller milestones for overwhelm, pre-staged next steps for "gets stuck").
- Only the current and immediate-next step are ever visible to the user; the read path that enforces this is the sole path - no other query may expose further steps.
- The LLM's plan output is validated against the shared Zod schema before the write; a validation failure is retried or surfaced as an error, never saved as a draft.
- A plan's first creation spins up a dedicated plan thread, distinct from the discovery thread and from any other plan's thread.
- Activation requires an explicit human-confirmation pause before a plan becomes active. Confirming activates it and, in the same atomic step, pauses any previously active plan; exactly one plan may be active per user at any time, enforced at the database level (not just in application code).
- Submitting a modification to a draft validates it against the schema and saves it back to the same draft row (status stays `draft`); the user confirms separately to activate.
- Rejecting a draft with feedback regenerates its content in place via `create_plan` - the same plan row, never a new row.
- With no active plan yet, the system reports zero active plans cleanly rather than erroring.
- Switching plans: the current active plan becomes `paused` (never deleted) as part of activating another. Reactivating a paused plan resumes its existing steps/progress without regenerating it. Selecting a bookmarked idea with no plan yet runs `create_plan` for the first time. A plan newly created via a switch still must pass through the same human-confirmation gate before becoming active - switching never bypasses it. After any switch, exactly one plan remains active.

## Technical Decisions

- Tool boundary: `create_plan` is LLM-backed - one tool invocation that performs the nondeterministic LLM call then a deterministic, Zod-validated Postgres write inside the same function (no separate persistence tool). `get_current_step` and `activate_plan` are plain-code/deterministic. No tool that mutates plan state is ever LLM-backed.
- Plan lifecycle: `draft` -> `active` | `paused` -> `completed`; at most one plan row per idea at any time; at most one `active` plan per user, enforced via a database-level partial unique constraint applied inside a single transaction that atomically deactivates the old plan and activates the new one - never two separate non-transactional updates.
- `activate_plan`'s human-in-the-loop pause uses the LangGraph runtime's built-in interrupt/resume pattern (or the agent framework's built-in HITL middleware) - no bespoke pause mechanism is introduced.
- Thread topology: exactly one plan thread per plan, created when that plan's draft is first generated; never shared across plans or users, and never blended with the single per-user discovery thread.
- Hard state this epic depends on (current step, timeline, failure pattern, plan/idea status) lives in dedicated Postgres tables and is always read fresh at the start of any tool call that needs it - never cached in or trusted from conversational/checkpointer state.
- Plan and idea status enums live in the shared Zod schema location; the database's enum/constraint representation is generated from or kept in lockstep with them, never hand-copied.
- Workspace shell ownership: this epic (3.1) owns the `PlanWorkspace` layout file (status sidebar/header + chat column, narrow-screen collapse, route) and the `StatusPanel` (current+next step, timeline) - no later story restructures that layout file. The shared `ChatThread`/`ChatMessage` component itself was built in Epic 1; this epic extends it additively (a footer-item extension point, a chat-input extension point, a projection-card slot) rather than replacing or duplicating it. Those extension points stay empty here and are filled later: message cost line (Epic 5), message thumbs/feedback (Epic 5, must never disable the chat input), voice input mode (Epic 4), projection card content (Epic 4), and the start/complete-step and check-in controls (Epic 4, rendered by `StatusPanel`/the chat input without editing the panel's layout).
- The draft review/confirm/modify/reject panel (Story 3.2) and the plan switcher (Story 3.3) are each their own component, rendered into/alongside the workspace rather than inside the layout file; 3.1 itself renders a draft plan read-only.
- Free-form follow-up questions asked inside an existing plan thread are answered by the agent in context, not limited to fixed check-in actions.

## UX & Interaction Patterns

Reuses Epic 1's established shell and visual system (light-default theme with dark toggle, glass style, teal accent) - no new visual-system decisions here. The plan workspace is a single unified screen: a status sidebar/header (current+next step, timeline) and a projection-card slot alongside one chat thread - never split into separate "Overview" and "Chat" tabs. On narrow/mobile screens the sidebar collapses into a compact header above the chat rather than disappearing or moving to a separate screen.

## Cross-Story Dependencies

- Story 3.1 depends on Epic 2: a `selected` idea and the persisted `failurePattern` (Story 2.1) drive the first draft.
- Story 3.2 depends on 3.1's draft plan and the workspace's draft-review extension point.
- Story 3.3 depends on 3.2's activation/pause mechanics and the one-active-plan constraint, and reuses 3.1's lazy `create_plan` path for ideas with no plan yet.
- The workspace shell, `ChatMessage` extension points, and projection-card slot built here are filled in by later stories in Epic 4 (step/check-in controls, voice input, projection content) and Epic 5 (message cost, message feedback) - those stories must extend, not restructure, this shell.
