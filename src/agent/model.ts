import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../config/env.js';

/**
 * Intent: "Model: `gpt-6-luna` (OpenAI, via OpenRouter's OpenAI-compatible
 * endpoint) — the single hardcoded default until Story 5.1's registry/
 * selection UI exists." Exported so tests and `src/agent/index.ts` share the
 * one literal instead of each hard-coding it separately.
 *
 * Routed through OpenRouter (the user's one key for every provider) rather
 * than OpenAI directly — OpenRouter's model id for this exact model is
 * `openai/gpt-6-luna` (verified against OpenRouter's own model listing, not
 * assumed from its `<provider>/<model>` naming convention alone).
 */
export const COACH_MODEL_NAME = 'openai/gpt-6-luna';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Builds the agent's chat model. A thin factory (mirrors `createDb`/
 * `createSessionMiddleware`) so `src/agent/index.ts` can inject a fake model
 * in tests instead of constructing a real `ChatOpenAI`.
 */
export function createChatModel(env: Pick<Env, 'OPENROUTER_API_KEY'>): ChatOpenAI {
  return new ChatOpenAI({
    model: COACH_MODEL_NAME,
    apiKey: env.OPENROUTER_API_KEY,
    configuration: { baseURL: OPENROUTER_BASE_URL },
  });
}
