import type { ChatOpenAI } from '@langchain/openai';
import type { Env } from '../config/env.js';
import { createChatModel } from '../agent/model.js';
import { JUDGE_MODEL_IDS, type JudgeModelId } from './constants.js';

/**
 * Story 6.2 (AC3/AC4): the two pinned judge models, built exactly the way
 * `createChatModel` builds any other OpenRouter id (no registry validation
 * inside it, Code Map) — passed as `createTrajectoryLLMAsJudge`'s `judge`
 * param (never the `model: "provider:id"` string form, which assumes a
 * native provider API rather than routing through OpenRouter).
 */
export function createJudgeModels(env: Pick<Env, 'OPENROUTER_API_KEY'>): Record<JudgeModelId, ChatOpenAI> {
  return Object.fromEntries(JUDGE_MODEL_IDS.map((id) => [id, createChatModel(env, id)])) as Record<JudgeModelId, ChatOpenAI>;
}
