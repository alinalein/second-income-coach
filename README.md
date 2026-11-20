# Second Income Coach

> An AI agent that turns "I want extra income" into a tailored plan and sticks with you through it — without guilt-tripping you when life gets in the way.

## Purpose

Second Income Coach is an AI agent that turns "I want extra income" into a tailored plan, then stays with the user through it — generating ideas matched to their actual skills/time/risk appetite, breaking the chosen one into small sequenced steps, and checking in without guilt-tripping when life gets in the way.

## Usefulness

People who want a second income stream face two barriers:

1. **Idea paralysis** — generic "extra income idea" lists aren't matched to actual skills, time, or risk appetite.
2. **Inconsistent follow-through** — momentum breaks after a life disruption, with no low-friction, judgment-free way back in.

Idea-generation quizzes already solve half of this. None pair tailored ideas with a non-punitive accountability loop. Second Income Coach does both.

## Target Audience

Anyone exploring a second income stream who has stalled before — on idea-overload, on a plan that didn't fit their actual time/budget/risk tolerance, or after a life disruption broke their momentum and left them with no judgment-free way back in.

## Getting started

**Prerequisites:** Node.js 20.19+ (the architecture spine targets Node 26 once generally available), Docker (for local Postgres), npm 10+.

1. Copy the environment template and fill in the keys in its section 1 (Google, session secret, OpenRouter, Mistral, Tavily, LangSmith) — every required variable is validated at backend startup (`src/config/env.ts`); a missing one fails fast with a clear message naming it, instead of a silent crash or hang:
   ```bash
   cp .env.example .env
   ```
2. Start local Postgres (Docker Compose):
   ```bash
   docker compose up -d
   ```
3. Install dependencies (npm workspaces: `shared`, `src`, `web` — one install, both sides import shared Zod schemas via `@app/shared`):
   ```bash
   npm install
   ```
4. Run both the Express backend and the React frontend:
   ```bash
   npm run dev
   ```
   - API: http://localhost:3000 — health checks at `GET /api/health` and `GET /api/health/db`
   - Frontend: http://localhost:5173 — Vite dev server, proxies `/api` to the backend (same-origin in production)

Other commands:

| Command | Does |
|---|---|
| `npm run build` | Production build of `shared`, `src`, and `web` |
| `npm run lint` | ESLint across the whole repo (`react/no-danger` enforced) |
| `npm run typecheck` | `tsc --noEmit` for every workspace |
| `npm test` | Vitest for every workspace |
| `npm run db:up` / `npm run db:down` | Start/stop the local Postgres container |
| `npm run eval` | Full eval suite on demand (real model + judge calls over OpenRouter, never part of `npm test`); needs `OPENROUTER_API_KEY` in `.env` |
| `npm run eval:report` | Builds the evaluation report from the last `npm run eval` results (run `eval` first); also refreshes `src/evals/published/eval-results.json` (committed — the Evaluation page reads it) when the run was complete, never from a partial/`-t` run |
| `npm run eval:latency` | Measures only the start-step reply latency per model (about 20 short real calls, a few cents) and merges it into `src/evals/published/eval-results.json` |
| `npm run smoke:ideas` | Regression smoke test: runs the real `generate_ideas` pipeline once against the test DB with a seeded, heavy idea-history fixture user, prints per-stage timings, exits 1 on too few ideas or a budget overrun; needs `OPENROUTER_API_KEY`/`MISTRAL_API_KEY` in `.env` |
| `npm run check` | `typecheck` + `lint` + `npm test` (against the test DB) + `smoke:ideas`, in order — the one command to run before committing |

The frontend defaults to light mode; the dark-mode toggle (top-right) persists the choice in `localStorage` across reloads. Teal accent tokens and contrast ratios are pinned in `stack.md` and wired in `web/src/index.css`.

## What it does

| # | Capability |
|---|---|
| CAP-1 | Structured intake (skills, interests, time, risk tolerance, budget) that also classifies *why* past attempts stalled, into one of five failure patterns |
| CAP-2 | 3 tailored income ideas per batch (more on request), each with a rationale tied to at least 3 intake fields; bookmark, reject, or request more |
| CAP-3 | A draft plan of small, sequenced steps — sized to the user's failure pattern — revealing only the current + next step |
| CAP-4 | Ongoing check-ins by text or voice (recorded → transcribed → user-confirmed); missed check-ins auto-reshuffle the timeline, no shame |
| CAP-5 | A live income/opportunity projection that updates with real progress |
| CAP-6 | Human-confirmed plan activation (HITL) — only one plan active at a time, others pause rather than vanish |
| CAP-7 | Settings: agent personality, model choice (transparent pricing registry), UI language, currency |
| CAP-8 | Token count + estimated cost shown under every response |
| CAP-9 | Thumbs up/down feedback, never gating the chat |
| CAP-10 | Bilingual (German/English) chat, matched per message to whatever language the user used |
| CAP-11 | A signed-in "Evaluation & Decisions" page (`/evaluation`, linked in the sidebar footer): eval results, key architecture decisions, and a reflection — all generated from source, never hand-copied |

Full detail: [`_bmad-output/specs/spec-second-income-coach/SPEC.md`](_bmad-output/specs/spec-second-income-coach/SPEC.md).

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 6.0.3 (pinned below 7.x: typescript-eslint hard-errors on TS 7 as of 2026-11-15) |
| Runtime | Node.js 26 (Active LTS) |
| Frontend | React 19.3.1 (React Compiler), TanStack Query |
| Backend | Express |
| Agent framework | LangChain `createAgent` on the LangGraph.js runtime |
| Persistence | Postgres (Neon) — hard state, checkpointing, and semantic memory (pgvector) |
| Auth | Google OAuth (`google-auth-library`) |
| Moderation | Mistral Moderation 2 |
| Voice (v1) | Whisper large-v3-turbo (transcription, via OpenRouter) |
| i18n | `react-i18next` |
| Schemas | Zod (shared backend/frontend, types via `z.infer`) |
| DB access | Drizzle ORM (parameterized by construction) |
| API security | `helmet`, `cors` (origin allowlist), `express-rate-limit` |
| Evals | `agentevals` + Vitest, traced in LangSmith |
| Hosting | Cloud Run (app) + Neon (Postgres), local-only until after the live demo |

## Architecture at a glance

One LLM agent with tool-calling, built with LangChain's `createAgent` on the LangGraph.js runtime. Tools split into three kinds — LLM-backed generation (`generate_ideas`, `create_plan`), deterministic plain-code Postgres read/write (intake, ideas, steps, check-ins, projection, activation, settings, feedback), and one MCP tool (`web_search`, grounds idea generation only) — so no nondeterministic call is ever allowed to mutate state.

Full technical rationale (agent loop, tool boundary, code structure, error handling, security, agent-vs-RAG justification, models/cost, memory): [`docs/TECHNICAL-RATIONALE.md`](docs/TECHNICAL-RATIONALE.md). Architecture overview (diagrams, models in use, dependency direction): [`ARCHITECTURE-SPINE.md`](_bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md).

## Project structure

npm workspaces: `shared` (Zod schemas and money helpers used by both sides), `src` (Express backend and agent), `web` (React frontend).

```text
shared/
  schemas/         # Zod schemas imported by backend and frontend
  money.ts         # currency handling
src/
  agent/           # createAgent wiring, middleware hooks, model registry, moderation,
                   # guilt-language check, voice transcription, progress/SSE mapping,
                   # memory, resilience config
  tools/
    llm/           # generate_ideas, create_plan
    plain/         # submit_intake, set_idea_status, get_current_step, start_step,
                   # complete_step, record_check_in, get_projection, activate_plan,
                   # set_personality, set_model, set_ui_language, set_currency,
                   # record_feedback
    mcp/           # web_search (Tavily, via @langchain/mcp-adapters)
  db/              # Postgres access via Drizzle ORM (schema, migrations)
  config/          # env.ts - startup validation of every env var
  api/             # Express app and routes consumed by the frontend
  evals/           # agentevals + Vitest trajectory/quality suites, report generation, latency measurement
  content/         # data behind the Evaluation page (key decisions, docs parsing)
  scripts/         # smoke-ideas: live check of idea generation
web/
  src/
    features/      # sidebar, ideas, intake, plan workspace, settings, ...
    chat/          # ChatThread / ChatMessage (Markdown rendering)
    components/    # shared UI components
    locales/       # en/ and de/ translation namespaces (react-i18next)
    i18n/          # i18n wiring
```

## Example Use Case

A walkthrough of one full user journey, end to end:

1. **Intake** — Mara signs in with Google and fills out the intake form: skills/interests ("cooking, grew up helping run a small family restaurant"), available time ("under 5 hours/week"), budget ("under €100"), risk tolerance ("low"), and what stopped her before — a free-text answer the agent classifies into a failure pattern (e.g. *life disruption*) alongside the structured fields. `submit_intake` persists all of it.
2. **Ideas** — Mara asks for income ideas. `generate_ideas` grounds each candidate in a `web_search`-sourced demand signal and a sourced baseline income rate (both persisted with their citation), then writes a batch of tailored ideas — each with a rationale tied back to at least 3 of her intake answers. She can bookmark, reject, or ask for another batch.
3. **Select** — Mara picks "home-cooked meal subscriptions for busy neighbors." `set_idea_status` marks it `selected`; `create_plan` lazily generates a draft plan of small, sequenced steps sized to her failure pattern, revealing only the current step and the next one.
4. **Activate** — Mara reviews the draft plan and confirms it. `activate_plan`'s human-in-the-loop gate pauses for that explicit confirmation before the plan becomes `active` — enforced by a database constraint, not just the UI, so only one plan is ever active at a time.
5. **Check in** — A few days in, Mara records a check-in by voice; the transcription model produces an editable transcript she confirms before it's submitted. `record_check_in` logs it; `start_step`/`complete_step` acknowledge her progress on the current step. If she misses a check-in, the next time she opens the app `get_current_step` detects it and reshuffles the timeline — no guilt language, ever.
6. **Projection** — Mara opens her plan and sees a live income/opportunity projection: `get_projection` combines the persisted baseline rate with her actual logged progress, updating as she completes more steps.

## Documentation map

| Document | Contents |
|---|---|
| [`SPEC.md`](_bmad-output/specs/spec-second-income-coach/SPEC.md) | Canonical contract: capabilities, constraints, non-goals, success signal |
| [`stack.md`](_bmad-output/specs/spec-second-income-coach/stack.md) | Full stack/version detail |
| [`engagement-mechanics.md`](_bmad-output/specs/spec-second-income-coach/engagement-mechanics.md) | Income-projection formula and check-in mechanics detail |
| [`evals.md`](_bmad-output/specs/spec-second-income-coach/evals.md) | Eval tooling, test composition, report requirements |
| [`ARCHITECTURE-SPINE.md`](_bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md) | Architecture diagrams, models in use, dependency direction, deferred items |
| [`epics.md`](_bmad-output/planning-artifacts/epics.md) | Full epic/story breakdown with acceptance criteria |
| [`sprint-status.yaml`](_bmad-output/implementation-artifacts/sprint-status.yaml) | Live implementation tracking |
| [`docs/TECHNICAL-RATIONALE.md`](docs/TECHNICAL-RATIONALE.md) | Agent loop, tool boundary, code structure, error handling, security, agent-vs-RAG, models/cost, memory |
| [`docs/KNOWN-WEAKNESSES.md`](docs/KNOWN-WEAKNESSES.md) | Known weaknesses, improvement suggestions, grading-criterion traceability |

## Not built in v1, and what comes next

- **No gamified layer** (avatar, pet, plant, points) and **no streak counters or guilt-based nudges**, anywhere. This is a product principle, not a gap.
- **No live FX API:** currency conversion uses one configured rate, labeled an estimate.
- **Voice v2 (speech-to-speech):** v1 is record, transcribe, user confirms the transcript. A speech-to-speech model would remove the review step; its availability must be re-checked before any v2 work.
- **Background job and proactive notifications:** missed check-ins are detected when the app is opened (AD-15). A scheduler and a push/email channel are not designed.
- **Planned for v2: feedback on new idea batches.** Every time a user presses "Generate new ideas" after their first batch (never on the very first generation), a dismissible pop-up asks what we should consider for them this time ("What should we improve or consider in your next ideas?"). It is asked on every new generation, because users notice more things that matter for their plan over time, so the plans keep matching what the user really has in mind. Skipping is always possible and never blocks generation. The answer is moderated, stored as per-user memory (same store as the response feedback of Story 5.3) and folded into the planning and writing prompts of that next batch; it applies once, to that batch. Open point: wording in DE/EN.

## Open work

Epics 1-6 and Story 7.5 are built. Still open (see [`sprint-status.yaml`](_bmad-output/implementation-artifacts/sprint-status.yaml)):

- **Story 7.6:** final code quality pass.
- **Story 7.3 (optional):** deploy to Cloud Run + Neon; the demo runs locally.
