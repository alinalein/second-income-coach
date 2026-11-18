import { ChatOpenAI } from '@langchain/openai';
import { createMiddleware } from 'langchain';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { Env } from '../config/env.js';
import { DEFAULT_MODEL_ID, findModelEntry, isProviderConfigured } from './registry.js';
import { lastMessageOfType } from './moderation.js';
import { detectReplyLanguage } from './language.js';
import { MODEL_NODE_TIMEOUT_MS } from './resilience.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Builds a chat model for a given registry model id (Story 5.1: previously
 * hardcoded to the one `COACH_MODEL_NAME` literal; every registry chat
 * entry is routed through OpenRouter, so this is still the one factory, now
 * parameterized). A thin factory (mirrors `createDb`/`createSessionMiddleware`)
 * so `createModelSelectionMiddleware` below — and tests — can inject a fake
 * instead of constructing a real `ChatOpenAI`.
 */
export function createChatModel(env: Pick<Env, 'OPENROUTER_API_KEY'>, modelId: string = DEFAULT_MODEL_ID): ChatOpenAI {
  return new ChatOpenAI({
    model: modelId,
    apiKey: env.OPENROUTER_API_KEY,
    configuration: { baseURL: OPENROUTER_BASE_URL },
  });
}

/**
 * AC: "the selected provider's key is missing, or a call to the selected
 * model fails ... the system falls back to the default model and shows a
 * neutral notice to the user - never a hard error." AD-24: this is one of
 * the fixed system texts named as needing both languages "from the moment
 * they're introduced" — same DE/EN-constant-pair pattern as
 * `MODEL_FAILURE_MESSAGE`/`MODEL_FAILURE_MESSAGE_DE` (`src/agent/resilience.ts`)
 * and the moderation module's fixed texts: this is backend-generated final
 * message content (persisted verbatim by the checkpointer), never a
 * frontend i18n key.
 */
export const MODEL_FALLBACK_NOTICE =
  "I couldn't reach your selected model, so I answered using the default model instead.";

export const MODEL_FALLBACK_NOTICE_DE =
  'Ich konnte dein ausgewähltes Modell nicht erreichen und habe stattdessen mit dem Standardmodell geantwortet.';

/**
 * Bug fix: a hung/very-slow call to the user's selected model (e.g. an
 * unresponsive provider, or an invalid/unverified registry id) was never
 * caught by the `try`/`catch` below — only a *rejected* call was. It just
 * kept waiting until `src/agent/resilience.ts`'s node-level 30s timeout
 * (`MODEL_NODE_TIMEOUT_MS`) aborted the *entire* "model" node (settings
 * lookup + moderation + this call), which LangGraph's retry policy then
 * retried from scratch — re-attempting the exact same hanging model call
 * every time, never reaching the fallback-to-default path at all (observed:
 * repeated `NodeTimeoutError` retries when switching to a Mistral model).
 *
 * Half the node budget leaves the other half for `beforeModel`/`afterModel`
 * moderation calls plus the default-model fallback call itself, all within
 * one node invocation — so a slow selected-model call now resolves to the
 * fallback well before the outer node-level timeout would ever fire.
 */
export const MODEL_CALL_TIMEOUT_MS = MODEL_NODE_TIMEOUT_MS / 2;

class ModelCallTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelCallTimeoutError(`model call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

function withFallbackNotice(response: AIMessage, messages: BaseMessage[]): AIMessage {
  // Same DE/EN pick as `moderation.ts`'s fixed texts: detected off the
  // triggering human message, not any UI-language setting (AD-25).
  const lastHuman = lastMessageOfType(messages, 'human');
  const notice = detectReplyLanguage(lastHuman?.text ?? '') === 'de' ? MODEL_FALLBACK_NOTICE_DE : MODEL_FALLBACK_NOTICE;
  // Story 5.2 bug fix (Code Map): previously dropped `usage_metadata` (and
  // `response_metadata`, which now also carries `resolvedModelId` —
  // `tagResolvedModelId` below) by constructing a bare `AIMessage` with only
  // `id`/`content` — a latent gap for AD-21's "sum every model call's
  // tokens", since a fallback call's own usage would silently vanish from
  // the turn's total the moment its notice was prepended. Both fields are
  // now carried forward onto the notice-prefixed message.
  return new AIMessage({
    id: response.id,
    content: `${notice}\n\n${response.text}`,
    usage_metadata: response.usage_metadata,
    response_metadata: response.response_metadata,
  });
}

/**
 * Story 5.2 (AD-21): tags every returned `AIMessage` with the model id that
 * actually answered this call — read back by `src/agent/turn-cost.ts`'s
 * cost computation (via `src/agent/index.ts`'s outer node) to price the
 * turn against the model that really ran, not just the one the user had
 * selected (a fallback swaps this to `DEFAULT_MODEL_ID`). Mutates
 * `response_metadata` in place rather than reconstructing the message — a
 * reconstruction would need to carry forward every other field (notably
 * `tool_calls`, which the inner ReAct loop depends on to resolve its next
 * step), which is exactly the class of bug `withFallbackNotice` had before
 * the fix above; mutating the one field in place can't drop anything else.
 */
function tagResolvedModelId(response: AIMessage, modelId: string): AIMessage {
  response.response_metadata = { ...response.response_metadata, resolvedModelId: modelId };
  return response;
}

export interface CreateModelSelectionMiddlewareDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  /** Test-only seam: a fake per-model-id builder instead of a real `ChatOpenAI`. */
  buildModel?: (env: Pick<Env, 'OPENROUTER_API_KEY'>, modelId: string) => ChatOpenAI;
}

/**
 * Per-turn model swapping (AD-20): `createAgent`'s own `model` option is
 * static for the agent's lifetime, so picking the user's currently selected
 * model each turn has to happen inside a `wrapModelCall` hook instead —
 * swapping `request.model` right before the handler call, based on the
 * `modelId` the outer graph node (`src/agent/index.ts`) resolved from
 * `user_settings` and passed in as middleware context.
 *
 * Resolution here deliberately re-checks the id against the registry (not
 * trusting the context value blindly) and separately checks whether its
 * provider's key is actually configured right now — the "no-longer-
 * selectable" case `src/agent/registry.ts`'s `resolveModelId` doesn't cover,
 * since that only checks registry *membership*. Only one model is ever
 * built per id for the life of this middleware (`modelCache`), not
 * reconstructed every turn.
 */
export function createModelSelectionMiddleware({ env, buildModel = createChatModel }: CreateModelSelectionMiddlewareDeps) {
  const modelCache = new Map<string, ChatOpenAI>();

  function getOrBuildModel(modelId: string): ChatOpenAI {
    const cached = modelCache.get(modelId);
    if (cached) return cached;
    const built = buildModel(env, modelId);
    modelCache.set(modelId, built);
    return built;
  }

  return createMiddleware({
    name: 'ModelSelectionMiddleware',
    wrapModelCall: async (request, handler) => {
      const requestedId = (request.runtime.context as { modelId?: string } | undefined)?.modelId;
      const entry = requestedId ? findModelEntry(requestedId) : undefined;
      const resolvedId = entry && entry.category === 'chat' ? entry.id : DEFAULT_MODEL_ID;

      if (resolvedId === DEFAULT_MODEL_ID) {
        const response = await handler({ ...request, model: getOrBuildModel(DEFAULT_MODEL_ID) });
        return tagResolvedModelId(response, DEFAULT_MODEL_ID);
      }

      if (!isProviderConfigured(entry!.provider, env)) {
        const fallback = await handler({ ...request, model: getOrBuildModel(DEFAULT_MODEL_ID) });
        return withFallbackNotice(tagResolvedModelId(fallback, DEFAULT_MODEL_ID), request.messages);
      }

      try {
        const response = await withTimeout(
          Promise.resolve(handler({ ...request, model: getOrBuildModel(resolvedId) })),
          MODEL_CALL_TIMEOUT_MS,
        );
        return tagResolvedModelId(response, resolvedId);
      } catch (error) {
        // Boundary (same as `moderation.ts`'s `logModerationIncident`): log
        // the model id and error message only, never message content.
        console.error('[model] selected model call failed, falling back to the default model:', {
          modelId: resolvedId,
          error: (error as Error)?.message,
        });
        const fallback = await handler({ ...request, model: getOrBuildModel(DEFAULT_MODEL_ID) });
        return withFallbackNotice(tagResolvedModelId(fallback, DEFAULT_MODEL_ID), request.messages);
      }
    },
  });
}
