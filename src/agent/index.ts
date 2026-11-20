import { z } from 'zod';
import { and, eq, gte } from 'drizzle-orm';
import { createAgent, dynamicSystemPromptMiddleware } from 'langchain';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { RetryPolicy } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { isAIMessage, type BaseMessage } from '@langchain/core/messages';
import type { Env } from '../config/env.js';
import type { createDb } from '../db/client.js';
import { getUserSettings } from '../db/settings-repository.js';
import { createChatModel, createModelSelectionMiddleware } from './model.js';
import { DEFAULT_MODEL_ID } from './registry.js';
import { DEFAULT_PERSONALITY, PERSONALITY_PROMPTS, resolvePersonality, type Personality } from './personality.js';
import { createModerationMiddleware, lastMessageOfType, type ClassifyText } from './moderation.js';
import { createGuiltLanguageMiddleware } from './guilt-language.js';
import { createProgressMiddleware } from './progress.js';
import { createForceToolChoiceMiddleware } from './toolChoice.js';
import { applyModelNodeResilience, MODEL_NODE_TIMEOUT_MS } from './resilience.js';
import { sumTurnUsage, type TurnUsage } from './turn-cost.js';
import { recallMemories, type MemorySearchStore } from './memory.js';
import { createSubmitIntakeTool } from '../tools/plain/submit_intake.js';
import { createGenerateIdeasTool } from '../tools/llm/generate_ideas.js';
import { derivePlanIdFromThreadId, startOfUtcDay } from '../tools/plain/get_current_step.js';
import { plans, checkIns } from '../db/schema/index.js';

/**
 * AD-25: "personality × language is handled as one prompt-construction step,
 * not as separate per-language personality definitions". This instruction is
 * deliberately language-agnostic text (not computed per message) — the model
 * itself matches the user's most recent message's language (AC3), re-
 * evaluating it on every turn since this function runs before every model
 * call via `dynamicSystemPromptMiddleware` below, not just once per thread.
 */
const REPLY_LANGUAGE_INSTRUCTION =
  "Always reply in the same language the user's most recent message is written in — German or English — " +
  'regardless of any other setting. Re-decide this for every reply; do not stick to a language from earlier in ' +
  'the conversation if the user has since switched.';

/**
 * Code Map: "add a `prompt: (state) => [SystemMessage]` option to the
 * `createAgent(...)` call". The installed `langchain@1.6.5`'s `createAgent`
 * only accepts a *static* `systemPrompt: string | SystemMessage` — there is
 * no per-turn `prompt` callback field on `CreateAgentParams`. The equivalent,
 * still-inside-`createAgent`-construction mechanism this version exposes is
 * `dynamicSystemPromptMiddleware`, added to the same `middleware` array the
 * moderation middleware already lives in (AD-25: "a prompt-construction
 * concern ... not a routing concern" — this keeps it there, not in
 * `api/routes/chat.ts`). `buildSystemPrompt` is exported standalone so its
 * output can be asserted directly in a unit test without constructing a
 * LangGraph runtime.
 *
 * Story 5.3b (AD-2): `memories` is this turn's already-retrieved,
 * already-bounded (top-3, similarity floor, char cap — `recallMemories`)
 * per-user semantic memories, folded in as one more prompt section when
 * present. Omitted (or empty) when there's nothing to recall, or when the
 * caller has no `memoryStore` configured at all — the prompt is then
 * byte-identical to before this story. Review fix: phrased as an explicit
 * standing instruction (not a soft "if useful" hint) — a user's past
 * feedback is meant to actually change behavior on a similar topic, not be
 * optional color commentary the model can take or leave.
 */
export function buildSystemPrompt(
  personality: Personality = DEFAULT_PERSONALITY,
  memories: string[] = [],
  extra?: string,
): string {
  const base = extra
    ? `${PERSONALITY_PROMPTS[personality]} ${REPLY_LANGUAGE_INSTRUCTION} ${extra}`
    : `${PERSONALITY_PROMPTS[personality]} ${REPLY_LANGUAGE_INSTRUCTION}`;
  if (memories.length === 0) return base;

  const memorySection = memories
    .map((memory) => `- The user previously said: "${memory}". Follow it for similar topics.`)
    .join('\n');
  return `${base}\n\nThe user gave this feedback on earlier replies. Treat each as a standing instruction:\n${memorySection}`;
}

/** Story 4.3 (AD-25): folded into the system prompt's `extra` section only
 * when a turn's `configurable.voiceDetectedLanguage` is set (Code Map) —
 * the transcript text itself usually already signals its language, but a
 * short/ambiguous edited transcript may not; this gives the model the
 * stronger signal `gpt-transcribe`'s own language hint (AD-26) already
 * resolved, on top of (never instead of) `REPLY_LANGUAGE_INSTRUCTION`'s
 * general "match the user's most recent message" rule. */
const VOICE_LANGUAGE_HINT_DE = 'The user just sent this message by voice; gpt-transcribe detected it as German.';
const VOICE_LANGUAGE_HINT_EN = 'The user just sent this message by voice; gpt-transcribe detected it as English.';

/**
 * Pure helper (Code Map) — `extra` is whatever this agent instance's own
 * `extraSystemInstruction` already resolved to (or `undefined`);
 * `voiceDetectedLanguage` is `runtime.configurable?.voiceDetectedLanguage`,
 * read by the `systemPrompt` callback below. Any value other than the two
 * recognized language codes (including `undefined`, the no-voice case) is a
 * no-op — `extra` passes through unchanged.
 */
export function appendVoiceLanguageHint(extra: string | undefined, voiceDetectedLanguage: unknown): string | undefined {
  const hint = voiceDetectedLanguage === 'de' ? VOICE_LANGUAGE_HINT_DE : voiceDetectedLanguage === 'en' ? VOICE_LANGUAGE_HINT_EN : undefined;
  if (!hint) return extra;
  return extra ? `${extra} ${hint}` : hint;
}

/**
 * Design Notes: "Thread id shape: `discovery:${userId}`, not bare `userId` —
 * reserves the `plan:${planId}` naming Epic 3 introduces per AD-18."
 */
export function buildDiscoveryThreadId(userId: string): string {
  return `discovery:${userId}`;
}

/**
 * Story 2.2 follow-up fix 4: a third, internal-only thread kind — not one
 * of AD-18's two user-visible kinds (discovery/plan). `src/api/routes/
 * ideas.ts`'s `POST /generate` invokes the agent here instead of on the
 * discovery thread, so its auto-generated trigger message (and the
 * resulting reply) is never checkpointed into, and so never rendered from,
 * the thread `GET /api/chat/messages` reads. Still `${kind}:${userId}` —
 * `generate_ideas`'s `deriveUserIdFromThreadId` derives the user id the
 * same way regardless of which kind prefixes it.
 */
export function buildIdeasTriggerThreadId(userId: string): string {
  return `ideas-trigger:${userId}`;
}

/**
 * Story 2.2 follow-up fix round 3, fix 1: the same internal-only pattern as
 * `buildIdeasTriggerThreadId`, for `src/api/routes/intake.ts`'s own
 * auto-generated "Call the submit_intake tool..." trigger — it had the
 * identical bug (persisted into, and rendered from, the discovery thread
 * `GET /api/chat/messages` reads) from Story 2.1 onward, just not caught
 * until live testing surfaced it alongside the ideas one.
 */
export function buildIntakeTriggerThreadId(userId: string): string {
  return `intake-trigger:${userId}`;
}

/**
 * Story 3.1 (AD-18): "exactly one plan thread per plan, created when that
 * plan's draft is first generated". Reserved shape (Design Notes in
 * `buildDiscoveryThreadId`'s own comment above) — never the discovery
 * thread, never shared across plans. `src/api/routes/plans.ts` mints a
 * `planId` and builds this thread id *before* `create_plan` has written any
 * row, so the id itself can't come from a DB lookup.
 */
export function buildPlanThreadId(planId: string): string {
  return `plan:${planId}`;
}

/**
 * Story 3.2 (AD-14): a fourth internal-only thread kind — same precedent as
 * `buildIdeasTriggerThreadId`/`buildIntakeTriggerThreadId`. `activate_plan`'s
 * pause/resume runs on its own checkpointed graph (`src/tools/plain/
 * activate_plan.ts`), never on the user-visible `plan:${planId}` chat thread
 * (`buildPlanThreadId`) — a different graph topology sharing that thread id
 * would risk deserializing an incompatible checkpoint.
 */
export function buildPlanActivationThreadId(planId: string): string {
  return `plan-activation:${planId}`;
}

const DISCOVERY_THREAD_PREFIX = 'discovery:';

/** Inverse of `buildDiscoveryThreadId` — Story 5.1 needs the `userId` back
 * out of `runtime.configurable.thread_id` to look up `user_settings` per
 * turn, without `src/api/routes/chat.ts` (which builds that thread id)
 * having to pass it through separately. */
export function extractUserIdFromThreadId(threadId: string | undefined): string | undefined {
  if (!threadId?.startsWith(DISCOVERY_THREAD_PREFIX)) return undefined;
  const userId = threadId.slice(DISCOVERY_THREAD_PREFIX.length);
  return userId.length > 0 ? userId : undefined;
}

/**
 * Story 5.3b (AD-2) review fix: prefers an explicitly passed `configurable.
 * userId` — the mechanism `chat.ts`/`plan-chat.ts` both now use when
 * invoking the agent — over parsing it out of `thread_id` via
 * `extractUserIdFromThreadId`, which only ever resolves a userId for the
 * `discovery:` thread kind. A `plan:${planId}` thread has no embedded
 * userId at all, so without this, both the `user_settings` lookup below and
 * memory retrieval silently no-op on every plan-chat turn even though the
 * route already knows the userId. Falls back to the old thread-id parsing
 * so any caller that still only passes `thread_id` keeps working unchanged.
 */
export function resolveUserId(configurable: Record<string, unknown> | undefined): string | undefined {
  const explicit = configurable?.userId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return extractUserIdFromThreadId(configurable?.thread_id as string | undefined);
}

/** The per-turn values the outer node resolves from `user_settings` and
 * hands to the inner `createAgent` as middleware context (AD-20: personality
 * for `buildSystemPrompt`, `modelId` for `createModelSelectionMiddleware`).
 * Story 4.5 (AC4): `planCompleted` is resolved the same per-turn way — from
 * `plans.status`, keyed off the thread id, whenever this is a plan thread.
 * Bug fix (user-reported, live): `checkedInEnergyToday` the same way again —
 * today's `checkIns.energy` (if any), keyed off the user id. */
const agentContextSchema = z.object({
  personality: z.string().optional(),
  modelId: z.string().optional(),
  planCompleted: z.boolean().optional(),
  checkedInEnergyToday: z.string().optional(),
});

/**
 * Story 4.5 (AC4): "add the note ... that the plan is completed, so the
 * model answers questions about finished steps and does not try to start
 * steps." The tool-level rejection (`assertPlanActive`, `step-state.ts`)
 * already blocks `start_step`/`complete_step` on a completed plan either
 * way — this just stops the model from attempting (and getting a rejected
 * tool call back) in the first place, and steers it toward answering from
 * history instead.
 */
const PLAN_COMPLETED_SYSTEM_NOTE =
  'This plan is already completed — every step is finished, so there is no current step. For any question ' +
  'about a completed step (e.g. what a specific step was), call get_current_step — it returns every ' +
  'completed step, not just what is in the conversation history. Never call start_step or complete_step on ' +
  'this plan, and never suggest starting a new step on it.';

function withPlanCompletedNote(extraSystemInstruction: string | undefined, planCompleted: boolean | undefined): string | undefined {
  if (!planCompleted) return extraSystemInstruction;
  return [extraSystemInstruction, PLAN_COMPLETED_SYSTEM_NOTE].filter(Boolean).join(' ');
}

/**
 * Bug fix (user-reported, live): "I already clicked High on today's
 * check-in pop-up, then started chatting and the model asked me how I'm
 * feeling today again." `record_check_in`'s own tool description tells the
 * model to "ask a brief question about their energy or status" as part of
 * its own reasoning — with no awareness of the pop-up's *separate* write
 * (`POST /api/plans/:planId/check-in`), it had no way to know that already
 * happened today. Same precedent as `PLAN_COMPLETED_SYSTEM_NOTE` just
 * above: a plain system note, not a new tool/schema change.
 */
function withCheckedInNote(extraSystemInstruction: string | undefined, checkedInEnergyToday: string | undefined): string | undefined {
  if (!checkedInEnergyToday) return extraSystemInstruction;
  const note =
    `The user already checked in today (energy: ${checkedInEnergyToday}) via the app's own check-in pop-up. ` +
    'Never ask how they are feeling/their energy today again, and never call record_check_in again today — ' +
    'treat today as already checked in.';
  return [extraSystemInstruction, note].filter(Boolean).join(' ');
}

/**
 * Story 5.2 (AD-21): this turn's summed token usage plus the model id that
 * actually answered it — `undefined` only when the turn produced no AI
 * message at all (e.g. a moderation `beforeModel` short-circuit, which
 * `jumpTo: 'end'`s before any model call happens). `modelId` comes from the
 * *last* new AI message that carries a `resolvedModelId` (Code Map:
 * `src/agent/model.ts`'s `tagResolvedModelId`) — the one that actually
 * produced this turn's final reply, which is also the one a mid-turn
 * fallback (I/O matrix: "Fallback mid-turn") leaves tagged as the default
 * model.
 */
export interface TurnUsageWithModel extends TurnUsage {
  modelId?: string;
}

/**
 * Bug fix (user-reported: plan-chat replies showed thumbs but no cost line
 * at all, not even a token count). Root cause: `src/api/index.ts` passes a
 * pre-built `model` into every production `createCoachAgent(...)` call
 * (Follow-up fix round 7, AD-7 — shares one `ChatOpenAI` client instead of
 * building one per agent) — but `createCoachAgent`'s own middleware wiring
 * treats *any* injected `model` as "this is a test, skip
 * `createModelSelectionMiddleware`" (see its own comment below), so
 * `model.ts`'s `tagResolvedModelId` never runs in production, for *any*
 * agent (chat/ideas/plans) — `resolvedModelId` was never present to read,
 * for any turn, ever (confirmed: zero `message_costs` rows existed despite
 * real prior conversations). Falls back to `response_metadata.model_name`
 * — the raw, provider-native field `@langchain/openai`'s own converter sets
 * from the actual completion response's `model` field on *every* real call,
 * independent of which middleware ran — before giving up. Prefers the
 * explicit `resolvedModelId` tag when present (covers the fallback-to-
 * default-model path's own notice-prefixed message, which still carries it
 * forward) since that's a stronger, in-house signal than the provider's own
 * echo.
 */
function resolveTurnModelId(newMessages: readonly BaseMessage[]): string | undefined {
  for (let i = newMessages.length - 1; i >= 0; i -= 1) {
    const message = newMessages[i];
    if (!message || !isAIMessage(message)) continue;
    const metadata = message.response_metadata as { resolvedModelId?: string; model_name?: string } | undefined;
    const modelId = metadata?.resolvedModelId ?? metadata?.model_name;
    if (modelId) return modelId;
  }
  return undefined;
}

/**
 * Code Map: "extend to a custom `Annotation.Root` with an added `turnUsage`
 * channel (reducer: replace)". Spreads `MessagesAnnotation.spec` rather than
 * redefining the `messages` channel by hand, so this stays additive — every
 * existing reader of `state.messages`/`result.messages` is unaffected.
 */
const CoachAgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  turnUsage: Annotation<TurnUsageWithModel | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
});

export interface CreateCoachAgentDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY' | 'IDEAS_PER_BATCH' | 'DAILY_SEARCH_BUDGET'>;
  checkpointer: BaseCheckpointSaver;
  /** Pre-built chat model: production passes the one shared instance
   * (`src/api/index.ts`); tests pass a fake. */
  model?: BaseChatModel;
  /** Test-only seam: a fake moderation classifier instead of a real Mistral call. */
  classify?: ClassifyText;
  /** The shared db handle: `submit_intake` persists through it and (Story 5.1,
   * AD-20) each turn reads `user_settings` from it — `api/index.ts` already
   * builds one `createDb(env)` pool for `AppDeps`; this reuses that same
   * instance rather than opening a second pool. */
  db: ReturnType<typeof createDb>['db'];
  /** Story 2.2 (AD-5): the one MCP tool (`web_search`), constructed async
   * in `src/api/index.ts` via `MCPAdapter.listTools()` before
   * `createCoachAgent(...)` is called. Boundary: never added to this
   * agent's own `tools: [...]` below — passed through only as a dependency
   * into `generate_ideas`'s factory, which binds it to its own nested,
   * uncheckpointed `createAgent` instance. */
  webSearchTool: DynamicStructuredTool;
  /** Story 2.2 follow-up fix 1 (AD-7): overrides the outer `'model'` node's
   * timeout — defaults to the standard chat/intake budget. `src/api/
   * index.ts` builds a second `createCoachAgent(...)` instance with
   * `IDEAS_MODEL_NODE_TIMEOUT_MS` here, used only by the ideas route; chat
   * and `submit_intake` keep using the default-timeout instance. */
  modelNodeTimeoutMs?: number;
  /** Story 2.2 round 9, fix (a): overrides the outer `'model'` node's retry
   * policy — defaults to the standard 3-attempt policy. `src/api/index.ts`
   * passes `IDEAS_MODEL_NODE_RETRY_POLICY` (no retry) for the same ideas-
   * only agent instance above, so a timeout there fails the turn instead of
   * re-running the whole thing (including every search) from scratch. */
  modelNodeRetryPolicy?: RetryPolicy;
  /** Story 6.2 (AD-23): test-only seam for the trajectory eval harness
   * (`src/evals/harness.ts`) — overrides the hardcoded `tools: [...]` array
   * below wholesale. Lets an eval case swap in a schema-identical, instant
   * fake `generate_ideas` (its real factory makes its own nested real-model
   * call, which would compound per-model eval cost) while still reusing the
   * real `submit_intake` tool unmodified. Omitted in production — defaults
   * to today's exact two-tool wiring, so this is purely additive. */
  tools?: DynamicStructuredTool[];
  /** Story 4.1/4.2 (CAP-4): an extra, agent-specific system-prompt
   * instruction appended after the reply-language instruction — used only
   * by `src/api/index.ts`'s `plansAgent` instance for its check-in-ordering
   * and neutral-gap-greeting guidance. Omitted everywhere else, so every
   * other agent's prompt is unchanged. */
  extraSystemInstruction?: string;
  /** Story 4.2 (AD-12): wires the dedicated guilt-language `afterModel`
   * check (`src/agent/guilt-language.ts`) into this agent's middleware —
   * scoped to CAP-4, so only `plansAgent` passes `true`. */
  includeGuiltLanguageCheck?: boolean;
  /** Story 5.3b (AD-2): the per-user semantic memory store — optional so
   * every existing caller (and every test that doesn't care about memory)
   * keeps working unchanged. When omitted, the system prompt is built
   * exactly as before this story (no memory lookup at all). */
  memoryStore?: MemorySearchStore;
}

/**
 * Wires the model, Mistral-moderation middleware, and node-level resilience
 * into one compiled, Postgres-checkpointed LangGraph graph (Code Map:
 * "`createCoachAgent()` wiring all of it into one compiled graph").
 *
 * The actual ReAct loop is `createAgent` itself (AC: "processed by a
 * `createAgent` instance on the LangGraph.js runtime"). It's nested here as
 * this graph's single `"model"` node — `createAgent` compiles its own graph
 * internally with no seam to call `setNodeDefaults` on before that happens,
 * so the one retry/timeout policy for the model call (AD-7) is applied at
 * this outer level instead, around the whole agent turn. The Postgres
 * checkpoint lives on this outer graph only; the inner
 * `createAgent` instance is stateless and re-invoked with the full message
 * history on every turn.
 */
export function createCoachAgent({
  env,
  checkpointer,
  model,
  classify,
  db,
  webSearchTool,
  modelNodeTimeoutMs = MODEL_NODE_TIMEOUT_MS,
  modelNodeRetryPolicy,
  tools,
  extraSystemInstruction,
  includeGuiltLanguageCheck,
  memoryStore,
}: CreateCoachAgentDeps) {
  const chatModel = model ?? createChatModel(env, DEFAULT_MODEL_ID);
  const progress = createProgressMiddleware();
  const moderation = createModerationMiddleware(env, { classify });
  // Story 5.3b (AD-2): async so this can call `recallMemories` before each
  // model call (`dynamicSystemPromptMiddleware`'s own callback type accepts
  // `Promise<string | SystemMessage>` — see its `.d.ts`). `userId` is
  // resolved via `resolveUserId` — the explicit `configurable.userId` both
  // `chat.ts` and `plan-chat.ts` now pass, so memory surfaces on both the
  // discovery thread and a plan thread alike (review fix: the thread-id-
  // parsing fallback alone only ever worked for the discovery thread).
  // Boundary: "Retrieval failure never blocks a turn" — `recallMemories`
  // itself never throws, and no `memoryStore` at all is just as safe a
  // no-memory path as a `userId`/human-text miss below.
  const systemPrompt = dynamicSystemPromptMiddleware<{ personality?: string; planCompleted?: boolean; checkedInEnergyToday?: string }>(
    async (state, runtime) => {
      const personality = resolvePersonality(runtime.context?.personality);
      // Story 4.3 (AD-25): voice language hint, then the 4.5 plan-completed
      // note, then the checked-in-today note (bug fix, user-reported, live).
      const extra = withCheckedInNote(
        withPlanCompletedNote(
          appendVoiceLanguageHint(extraSystemInstruction, runtime.configurable?.voiceDetectedLanguage),
          runtime.context?.planCompleted,
        ),
        runtime.context?.checkedInEnergyToday,
      );
      if (!memoryStore) return buildSystemPrompt(personality, [], extra);

      // Hardening: the Boundary ("retrieval failure never blocks a turn")
      // previously only covered `recallMemories`'s own internals. Wrapping
      // the whole lookup closes any other path here (e.g. an unexpected
      // `resolveUserId`/`lastMessageOfType` edge case) too — a model call
      // this middleware feeds must never fail because memory lookup did.
      try {
        const userId = resolveUserId(runtime.configurable);
        const lastHuman = lastMessageOfType(state.messages, 'human');
        if (!userId || !lastHuman?.text) return buildSystemPrompt(personality, [], extra);

        const memories = await recallMemories(memoryStore, userId, lastHuman.text);
        return buildSystemPrompt(personality, memories, extra);
      } catch (error) {
        console.error('[agent] memory-augmented system prompt failed, falling back to the base prompt:', {
          error: (error as Error)?.message,
        });
        return buildSystemPrompt(personality, [], extra);
      }
    },
  );
  const forceToolChoice = createForceToolChoiceMiddleware();
  // Story 4.2 (AD-12): CAP-4-scoped only — `includeGuiltLanguageCheck` is
  // `true` only for `plansAgent` (`src/api/index.ts`).
  const guiltLanguage = includeGuiltLanguageCheck ? [createGuiltLanguageMiddleware({ model: chatModel })] : [];

  // Story 5.1 (AD-20): per-turn model swapping only applies to the real,
  // registry-backed model. A test that injects its own fake `model` (the
  // seam above) wants that exact instance invoked on every turn, never
  // swapped out underneath it by the registry-driven middleware below.
  const middleware = model
    ? [progress, moderation, ...guiltLanguage, systemPrompt, forceToolChoice]
    : [progress, moderation, ...guiltLanguage, systemPrompt, forceToolChoice, createModelSelectionMiddleware({ env })];

  // Story 1.5 Design Notes: `progress` goes first so its `beforeModel` always
  // fires, even when `moderation`'s own `beforeModel` jumps straight to
  // `end` on a jailbreak reject.
  const reactAgent = createAgent({
    model: chatModel,
    middleware,
    contextSchema: agentContextSchema,
    tools: tools ?? [createSubmitIntakeTool(db), createGenerateIdeasTool(db, chatModel, webSearchTool, env)],
  });

  const graph = new StateGraph(CoachAgentState).addNode('model', async (state, runtime) => {
    // Story 5.1 (AD-20): resolve this turn's personality/model from
    // `user_settings`, keyed by `userId` (review fix, Story 5.3b:
    // `resolveUserId` prefers the explicit `configurable.userId` both
    // routes now pass, so this lookup also now works on a plan thread,
    // not just the discovery thread) — no settings lookup (and defaults
    // throughout) when `db` wasn't supplied.
    const userId = resolveUserId(runtime.configurable);
    const settings = db && userId ? await getUserSettings(db, userId) : undefined;

    // Story 4.5 (AC4): resolved once per turn, same precedent as the
    // personality/model lookup above — `derivePlanIdFromThreadId` only ever
    // matches a `plan:${planId}` thread id, so this is a no-op (and no extra
    // query) on every other thread kind (discovery, ideas-trigger, etc.).
    // Fail-open: a lookup error never blocks the turn, it just leaves the
    // note off.
    const planId = derivePlanIdFromThreadId(runtime.configurable?.thread_id as string | undefined);
    let planCompleted = false;
    if (db && planId) {
      try {
        const [plan] = await db.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).limit(1);
        planCompleted = plan?.status === 'completed';
      } catch (error) {
        console.error('[agent] plan-completion lookup failed, defaulting to not-completed:', { planId, error: (error as Error)?.message });
      }
    }

    // Bug fix (user-reported, live): resolved the same fail-open way again
    // — today's check-in energy (if any), keyed off the user id, never the
    // plan id (same precedent as `getCheckInStatus`'s own "no planId filter
    // at all, by design": a check-in recorded against *any* of the user's
    // plans today counts for every plan/thread).
    let checkedInEnergyToday: string | undefined;
    if (db && userId) {
      try {
        const [checkIn] = await db
          .select({ energy: checkIns.energy })
          .from(checkIns)
          .where(and(eq(checkIns.userId, userId), gte(checkIns.createdAt, startOfUtcDay(new Date()))))
          .limit(1);
        checkedInEnergyToday = checkIn?.energy;
      } catch (error) {
        console.error('[agent] check-in-status lookup failed, defaulting to not-checked-in:', { userId, error: (error as Error)?.message });
      }
    }

    // `runtime` (a `LangGraphRunnableConfig`, which extends `RunnableConfig`)
    // carries `configurable` (incl. `thread_id`) alongside the callback/
    // tracing fields `reactAgent.invoke` expects; forwarding it as-is keeps
    // the inner agent's LangSmith run nested under this node's run instead of
    // starting a disconnected one. `context` is added on top for the two
    // middlewares above to read.
    const result = await reactAgent.invoke(
      { messages: state.messages },
      { ...runtime, context: { personality: settings?.personality, modelId: settings?.model ?? undefined, planCompleted, checkedInEnergyToday } },
    );

    // Story 5.2 (AD-21): "sums every model call made during that turn's full
    // agent-loop execution" — scoped to just this turn's own new AI messages
    // (`result.messages.slice(state.messages.length)`), never the thread's
    // whole history, so a later turn in the same thread never re-sums an
    // earlier turn's tokens.
    const newMessages = result.messages.slice(state.messages.length);
    const turnUsage: TurnUsageWithModel = { ...sumTurnUsage(newMessages), modelId: resolveTurnModelId(newMessages) };

    return { messages: result.messages, turnUsage };
  });

  graph.addEdge(START, 'model').addEdge('model', END);

  return applyModelNodeResilience(graph, modelNodeTimeoutMs, modelNodeRetryPolicy).compile({ checkpointer });
}

export type CoachAgent = ReturnType<typeof createCoachAgent>;
