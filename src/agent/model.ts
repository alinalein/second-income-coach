import { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../config/env.js';

/**
 * Intent: "Model: `gpt-6-luna` (OpenAI, via `@langchain/openai`) — the single
 * hardcoded default until Story 5.1's registry/selection UI exists." Exported
 * so tests and `src/agent/index.ts` share the one literal instead of each
 * hard-coding it separately.
 */
export const COACH_MODEL_NAME = 'gpt-6-luna';

/**
 * Builds the agent's chat model. A thin factory (mirrors `createDb`/
 * `createSessionMiddleware`) so `src/agent/index.ts` can inject a fake model
 * in tests instead of constructing a real `ChatOpenAI`.
 */
export function createChatModel(env: Pick<Env, 'OPENAI_API_KEY'>): ChatOpenAI {
  return new ChatOpenAI({ model: COACH_MODEL_NAME, apiKey: env.OPENAI_API_KEY });
}
