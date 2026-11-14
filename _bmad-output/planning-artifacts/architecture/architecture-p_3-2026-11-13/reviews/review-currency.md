# Currency Review — ARCHITECTURE-SPINE.md (Second Income Coach)

**Lens:** Verify every committed decision was web-researched or reality-checked rather than asserted from training data — current library/framework versions, that each named technology still exists and fits, and (greenfield) the live defaults of any starter it leans on. Flag anything that could be out of date and wasn't confirmed against the web, the project, or the current starter.

**Reviewed file:** `/Users/lin/Desktop/p_3/_bmad-output/planning-artifacts/architecture/architecture-p_3-2026-11-13/ARCHITECTURE-SPINE.md`

**Review date:** 2026-11-13 (all "current" / "latest" findings below are as of this date)

**Method:** Every named package, version string, API/method name, and model name in the Stack table and in the AD rules was treated as an unverified claim and checked via live web search against npm registries, vendor docs/changelogs, release-note aggregators, and vendor community/deprecation notices. "Confirmed" = matches what's live today. "Stale" = was true at some point but is no longer the current/latest state. "Syntax/naming mismatch" = the named technology is real but the specific API surface described doesn't match the real TypeScript API (a training-data leak from the Python ecosystem). No starter/scaffold tool (e.g. `create-vite`, a BMAD or framework starter template) is named anywhere in the spine or in SPEC.md, so the "live defaults of a starter" sub-check has no applicable target here — noted, not a gap.

---

## Overall assessment

Nothing in the Stack table or AD rules refers to a fabricated package or a technology that doesn't exist — every named library, package, and model was found to be real. However, the review surfaced four classes of problems that are exactly what this lens is designed to catch: (1) several `[VERIFIED]`-tagged version pins are already one-to-several releases behind the real npm latest as of today; (2) one normative pattern (AD-5's `MultiServerMCPClient`) is written against an API that the cited package version has since deprecated; (3) the middleware hook names and HITL resume syntax used throughout the AD rules are written in **Python LangChain convention** (`before_model`, `wrap_model_call`, `Command(resume=value)`), not the real **TypeScript** API (`beforeModel`, `wrapModelCall`, `new Command({resume: value})`) — a strong signal of an asserted-from-training-data claim rather than a verified one, despite `[VERIFIED]` tags on the surrounding rules; and (4) one deferred model pin (`gpt-audio-mini-2025-12-15`) has a live deprecation notice that wasn't caught.

---

## Findings

### 1. [HIGH] AD-1, AD-7, AD-11, AD-12, Consistency Conventions — middleware hook names are Python syntax, not TypeScript

- **Claim:** Throughout the spine (AD-1's rule text, AD-7, AD-11, AD-12, and the Consistency Conventions table), hook names are written as `before_agent`, `before_model`, `wrap_model_call`, `wrap_tool_call`, `after_model`, `after_agent`.
- **What I checked:** LangChain's own JS/TS docs (`docs.langchain.com/oss/javascript/langchain/middleware/custom`), the JS API reference (`reference.langchain.com/javascript/langchain/index/AgentMiddleware`), and independent secondary sources (DeepWiki, LangChain v1 JS migration/release docs), confirmed via two independent web searches.
- **What I found:** The real LangChain**.js**/TypeScript middleware API uses **camelCase**: `beforeAgent`, `beforeModel`, `wrapModelCall`, `wrapToolCall`, `afterModel`, `afterAgent`. The snake_case forms used throughout the spine (`before_agent`, `before_model`, `wrap_model_call`, `wrap_tool_call`, `after_model`, `after_agent`) are the **Python** LangChain hook names, not the TypeScript ones. This is the single clearest "asserted from training data, not checked against the project's actual (TS) stack" pattern found in the whole document — it's used consistently and confidently (including inside rules tagged `[VERIFIED]` / `[ADOPTED]`), which is exactly the failure mode this lens exists to catch.
- **Why it matters:** This spine explicitly commits to TypeScript (`langchain@1.5.18`, `@langchain/core@1.2.18`, "TypeScript" called out by name in AD-1). If an implementer treats these AD rules as literal API names, the code won't compile/match the real middleware config shape. It also means AD-1's `[VERIFIED]` tag on "Its built-in middleware hooks (...) are the only cross-cutting hook mechanism" wasn't actually checked against the TS API surface it names.
- **Recommendation:** Replace every snake_case hook name in AD-1, AD-7, AD-11, AD-12, and the Consistency Conventions table with the camelCase TS names (`beforeAgent`, `beforeModel`, `wrapModelCall`, `wrapToolCall`, `afterModel`, `afterAgent`).

### 2. [MEDIUM] AD-14 — `Command(resume=value)` is Python call syntax, not TypeScript

- **Claim:** "LangGraph.js's `interrupt()` / `Command(resume=value)` pattern."
- **What I checked:** Same LangGraph.js HITL sources as Finding 1's underlying research (LangGraph.js fault-tolerance/HITL docs, a LangGraph.js human-in-the-loop walkthrough).
- **What I found:** `interrupt()` and the `Command` resume pattern are both real and current in LangGraph.js. But the call shown, `Command(resume=value)`, is Python keyword-argument syntax. The real TypeScript call is `new Command({ resume: value })` (and in practice the resume payload for `createAgent`'s HITL middleware is a more structured shape like `new Command({ resume: { decisions: [...] } })`, not a bare value). Same root cause as Finding 1: a Python-ecosystem idiom asserted into a TypeScript rule.
- **Why it matters:** Lower severity than Finding 1 because the *pattern* (interrupt/resume) is correctly identified and the package/mechanism claim is right — only the literal syntax shown is wrong, and `[VERIFIED]` here plausibly refers to "this mechanism exists," not to the exact code snippet.
- **Recommendation:** Rewrite as `new Command({ resume: value })` (TS object syntax) when this rule is next touched.

### 3. [HIGH] AD-5 — `MultiServerMCPClient` is the deprecated compatibility path in the cited package version, not the recommended one

- **Claim:** "`@langchain/mcp-adapters` (2.0+) is the only MCP integration path (`MultiServerMCPClient` → `listTools()` → passed to `createAgent`)."
- **What I checked:** npm listing for `@langchain/mcp-adapters` and LangChain's own 2.0 migration doc (`docs.langchain.com/oss/javascript/migrate/langchain-mcp-adapters`).
- **What I found:** `@langchain/mcp-adapters` 2.0+ is real and current (latest 2.0.2). But v2.0 restructures the library around a new `MCPAdapter` primitive ("you don't create clients yourself — you describe each server in an `MCPAdapter`, and the adapter manages the clients for you"). `MultiServerMCPClient` (and its `getTools()`/`listTools()`-style surface) is kept in 2.0 **only as a deprecated compatibility API**; v2 also changed default tool-name prefixing (`{server}__{tool}`) and connection behavior relative to the old client.
- **Why it matters:** AD-5 is tagged `[VERIFIED]` and names the deprecated class as "the only MCP integration path" under the exact version range (2.0+) where it's been superseded. This reads as verified against an older snapshot of the package (pre-2.0, or early-2.0 release notes) rather than against the live 2.0.2 migration guidance — a builder following the rule literally reaches for the compat shim instead of the now-recommended `MCPAdapter`.
- **Recommendation:** Update AD-5 to name `MCPAdapter` as the integration path, or explicitly state `MultiServerMCPClient` is being used *as* the documented deprecated-but-supported path and why.

### 4. [MEDIUM] AD-1 Stack table — `langchain@1.5.18` / `@langchain/core@1.2.18` are already behind current npm latest

- **Claim:** `langchain@1.5.18`, `@langchain/core@1.2.18` (both tagged `[VERIFIED]` in AD-1 and listed in the Stack table).
- **What I checked:** npm version listings for both packages.
- **What I found:** Both versions are real and were current in roughly mid-to-late October 2026. As of today (2026-11-13), npm shows `langchain` at **1.6.5** and `@langchain/core` at **1.3.6** — the pins are a minor version (or more) behind current. They're internally consistent with each other (a real contemporaneous pair), so this isn't a mismatched-peer problem, just staleness.
- **Why it matters:** Pinning a known-good version pair is reasonable practice, but the `[VERIFIED]` tag implies "checked against the web as of now"; the underlying check appears to have been done at an earlier point in time with no "current (unpinned)" fallback the way `@langchain/langgraph-checkpoint-postgres` is handled elsewhere in the same table.
- **Recommendation:** Re-check and re-pin (or switch to "current") immediately before `package.json` is actually written, not at architecture time.

### 5. [MEDIUM] Stack table — "LangGraph.js runtime 1.4.x" is three minors behind current npm latest

- **Claim:** `LangGraph.js runtime | 1.4.x`.
- **What I checked:** npm listing for `@langchain/langgraph` (the actual package name — "LangGraph.js runtime" isn't a separate published package).
- **What I found:** `@langchain/langgraph`'s latest published version today is **1.7.3**. "1.4.x" was a real, shippable version family but is now three minors behind.
- **Why it matters:** Same staleness pattern as Finding 4. Lower risk than Finding 4 since AD-1's rule text doesn't hard-pin an exact LangGraph version (only the Stack table does), but should be re-verified before implementation.
- **Recommendation:** Re-check version at implementation time; consider "current (unpinned)" framing to match how the checkpoint-postgres row is handled.

### 6. [MEDIUM] AD-9 Deferred / Stack table — `gpt-audio-mini-2025-12-15` has a live OpenAI deprecation notice

- **Claim:** `gpt-audio-mini (voice v2, deferred) | gpt-audio-mini-2025-12-15`.
- **What I checked:** OpenAI community/deprecation threads (`community.openai.com` "gpt-audio-mini-replacement" and "Deprecation notice: upcoming model shutdowns in 2026" threads) and model-catalog pages.
- **What I found:** This exact snapshot is real (a genuine OpenAI model/snapshot released Dec 2025). However, independent searches found OpenAI announced **deprecation of `gpt-audio-mini` and this specific `-2025-12-15` snapshot on 2026-07-20**, with shutdown scheduled for **2026-01-20** [sic — community threads give the shutdown as roughly 6 months after the July 2026 announcement; treat the exact shutdown date as needing a direct re-check against OpenAI's own deprecations page rather than trusting either secondary date found], and `gpt-audio-1.5` recommended as the replacement. Note: one research pass also found a conflicting secondary source suggesting the floating `gpt-audio-mini` alias was simply repointed in January 2026 rather than deprecated — the two secondary sources disagree, so this should be treated as "flagged for direct verification against OpenAI's own docs," not as a settled fact.
- **Why it matters:** Lower severity than it would otherwise be because v2 is explicitly Deferred and not being built now — but if this pin is carried forward unexamined when v2 work actually starts, it risks locking onto an already-retired model. This is precisely the kind of claim the lens asks to flag: specific enough to look checked, but not re-verified against the live deprecation timeline as of the spine's own date.
- **Recommendation:** Before any v2 implementation work begins, re-check `gpt-audio-mini` status directly against OpenAI's current models/deprecations page rather than relying on this pin.

### 7. [LOW] AD-9 — `gpt-transcribe` release date off by about one day

- **Claim:** "gpt-transcribe (voice v1) | 2026-07-29 release."
- **What I checked:** OpenAI community announcement thread and model migration cookbook for `gpt-transcribe`.
- **What I found:** Secondary sources consistently cite **2026-07-28** (alongside streaming counterpart `gpt-live-transcribe`), one day earlier than the spine's date. One other secondary source said 2026-08-05. No source matched "2026-07-29" exactly.
- **Why it matters:** Trivial, doesn't change the substance of the decision — flagged only because the lens asks for every discrepancy, however minor.

### 8. [INFO — confirmed, strengthens the decision] `gpt-transcribe` is the currently correct, recommended transcription model

- **What I checked:** OpenAI's transcription model lineup and deprecation notices.
- **What I found:** OpenAI deprecated `whisper-1` and the `gpt-4o-transcribe` family (deprecation ~2026-08-26 per one source; Whisper API shutdown dated Feb 26, 2027 per another), explicitly recommending `gpt-transcribe` ahead of those older models for this use case. Good evidence this specific choice was actually researched against current state rather than defaulted to the (likely training-data-era) `whisper-1`/`gpt-4o-transcribe`.

### 9. [INFO — confirmed, current] `mistral-moderation-2603`

- **What I checked:** Mistral's own model/governance page and changelog, plus third-party model trackers.
- **What I found:** Real, GA, and the currently recommended Mistral moderation model ("Mistral Moderation 2"), released ~March 2026 (minor date disagreement between sources: March 1 vs March 12 — immaterial). Its predecessor `mistral-moderation-2411` was deprecated 2026-03-31. Matches the spine's description (policy categories including jailbreak/PII, large context window) closely. No issue.

### 10. [INFO — confirmed, well-researched] React Compiler / Vite 8 / `@vitejs/plugin-react` v6 chain

- **What I checked:** Vite's own release blog, `@vitejs/plugin-react` changelog/docs, and a corroborating third-party migration write-up.
- **What I found:** Vite 8 (stable March 12, 2026) did unify esbuild+Rollup into a Rust-based Rolldown bundler. `@vitejs/plugin-react` v6 (latest 6.3.0) moved its Refresh transform to Oxc and, as a consequence, dropped built-in Babel pass-through — which is exactly why `@rolldown/plugin-babel` is now needed as an explicit peer alongside `babel-plugin-react-compiler` and `@babel/core` to run React Compiler. `reactCompilerPreset` is a real exported helper. This is a non-trivial, easy-to-hallucinate claim (reflects a breaking internal change) that checks out exactly as described — the clearest example in this spine of correctly researched specificity.

### 11. [INFO — confirmed, current] TypeScript 7.0.2

TypeScript 7.0 (the Go-native "Corsa"/tsgo rewrite) shipped stable 2026-07-08; 7.0.2 is the current latest stable patch (7.1 exists only as dev/beta builds). Accurate and current.

### 12. [INFO — confirmed, current] Node.js 26 (Active LTS)

Node.js 26 was promoted to Active LTS on 2026-10-28, before the spine's 2026-11-13 date — so "Active LTS" is accurate, not premature. Node 24 moved to Maintenance LTS 2026-10-20.

### 13. [INFO — confirmed, current] React 19.3.1

React 19.3.0 shipped 2026-09-09, 19.3.1 followed 2026-10-14 and is the current latest (no React 20 found). Exact match.

### 14. [INFO — confirmed, very current] `google-auth-library` 11.3.3

Published 2026-11-02 (11 days before the review date) and is the current latest npm version — the single tightest-pinned, most clearly re-checked version in the whole Stack table.

### 15. [INFO — confirmed, reasonable framing] `@langchain/langgraph-checkpoint-postgres` / `PostgresSaver`, and `PostgresStore` + pgvector

Package and `PostgresSaver` class are real and current (latest ~1.0.5). `PostgresStore` with native pgvector (HNSW cosine) semantic search for long-term memory is also real and current, available in both open source and LangGraph Platform/managed offerings. Leaving the checkpoint-postgres row as "current (unpinned)" in the Stack table is the right call given the package's iteration speed — this is the pattern Findings 4/5 wish the `langchain`/`@langchain/core`/LangGraph rows had followed too.

### 16. [INFO — confirmed] `createAgent`, `setNodeDefaults`, and HITL middleware exist and behave as described (mechanism-level, not syntax-level)

`createAgent` is real and current as LangChain JS's top-level agent constructor; `setNodeDefaults` is a real LangGraph.js node-config API supporting `RetryPolicy`, `runTimeout`/`idleTimeout`, `CachePolicy`, and per-node `errorHandler`, matching AD-7's description. `createAgent`'s built-in human-in-the-loop middleware does use an `interruptOn` property, matching AD-14's alternative framing. (See Findings 1–2 for the syntax-level naming problems within these otherwise-correct mechanisms.)

### 17. [INFO — confirmed] TanStack Query / LangSmith still exist, still maintained, no renames affecting the spine's usage

TanStack Query is actively released through at least Nov 2026. LangSmith still exists as the product name the spine uses it for (tracing/observability); some LangSmith *sub-products* were renamed in 2026 (LangGraph Platform → LangSmith Deployment, LangGraph Studio → LangSmith Studio, Agent Builder → LangSmith Fleet), but the spine only references "LangSmith" generically, so none of those renames create an actionable gap. Noted for completeness only.

### 18. [INFO — confirmed] Deployment/infra free-tier claims (Neon, Supabase, Cloud Run, Cloud SQL)

- **Claim:** Neon auto-wakes on query after scale-to-zero; Supabase's free tier pauses idle projects and requires manual dashboard resume; Cloud Run's always-free tier gives 2M requests/month and scales to zero; Cloud SQL has no perpetual free tier, only a 30-day trial.
- **What I checked:** Neon's pricing/FAQ, Supabase's official "Project Pausing" documentation, Google Cloud's free-tier documentation, and GCP pricing aggregators.
- **What I found, point by point:**
  - **Neon:** Confirmed. Free-plan compute scales to zero after 5 minutes of inactivity (not configurable on Free) and resumes **automatically** on the next incoming connection/query — no manual step. (Side note not asserted by the spine: Neon's free-tier compute allowance reportedly changed from 50 to 100 CU-hours/month in an Oct 2025 update — if any future doc cites a specific Neon quota number, re-check it; the auto-wake behavior itself is unaffected.)
  - **Supabase:** Confirmed. Free-plan projects pause after 7 days of low/no activity; resuming requires manually opening the Supabase Dashboard and clicking "Resume project" (restorable via Studio for up to 1 year post-pause). This is a real, current, manual-only mechanism — the spine's Neon-vs-Supabase contrast is accurate and current.
  - **Cloud Run:** Confirmed. Always Free tier includes 2M requests/month (plus 360,000 GB-seconds memory, 180,000 vCPU-seconds, 1GB North-America egress/month) and does scale to zero. Google reserves the right to change limits with 30 days' notice (standard boilerplate, not evidence of an imminent change).
  - **Cloud SQL:** Confirmed. Explicitly excluded from GCP's perpetual "Always Free" list; only a 30-day trial plus the general $300/90-day new-customer credit apply.
- **Verdict:** All four infra comparison claims check out as accurate and current as of 2026-11-13 — this section of the spine reads as genuinely researched.

---

## Items the lens asked about but with no material finding beyond what's folded into Findings above

- **Zod ("current")** — live, actively maintained; no currency concern from leaving it unpinned.
- **Starter/scaffold defaults** — no starter template is named anywhere in the spine or SPEC.md (no `create-vite`, framework CLI, or BMAD project starter referenced for this greenfield build), so there are no "live defaults of a starter" to check against. This is a non-finding, not a gap: the spine doesn't make a claim here that needs verifying.

---

## Summary table

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Middleware hook names (`before_model` etc.) are Python syntax, not TS | HIGH | Real API, wrong-language naming used throughout AD-1/7/11/12 |
| 2 | `Command(resume=value)` is Python call syntax, not TS | MEDIUM | Real mechanism, wrong-language syntax in AD-14 |
| 3 | AD-5 `MultiServerMCPClient` vs `MCPAdapter` | HIGH | Deprecated API named as the normative pattern in cited 2.0+ range |
| 4 | `langchain@1.5.18` / `@langchain/core@1.2.18` | MEDIUM | Stale — real latest is 1.6.5 / 1.3.6 |
| 5 | LangGraph.js (`@langchain/langgraph`) "1.4.x" | MEDIUM | Stale — real latest is 1.7.3 |
| 6 | `gpt-audio-mini-2025-12-15` (deferred v2) | MEDIUM | Live deprecation notice found (sources conflict on exact shutdown date — re-check directly before v2 work) |
| 7 | `gpt-transcribe` release date | LOW | Off by ~1 day (07-28 vs claimed 07-29) |
| 8–18 | All other checked claims (model choices, frontend toolchain, TS/Node/React versions, google-auth-library, checkpoint/store packages, createAgent/setNodeDefaults/HITL mechanisms, TanStack/LangSmith, Neon/Supabase/Cloud Run/Cloud SQL) | INFO | Confirmed accurate and current as of 2026-11-13 |
