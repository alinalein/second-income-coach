import type { ChatOpenAI } from '@langchain/openai';
import type { LLMResult } from '@langchain/core/outputs';
import type { Env } from '../config/env.js';
import { createChatModel } from '../agent/model.js';
import { JUDGE_MODEL_IDS, type JudgeModelId } from './constants.js';

/** One real judge-model call's own token usage (Review Triage Log /
 * epics.md Story 7.5 follow-up: "capturing [judge cost] needs a callback
 * seam in judges.ts" — this is that seam). `complete: false` means the
 * underlying `ChatOpenAI` call reported no token usage at all — a floor,
 * never a guessed number (AD-21). */
export interface JudgeCallUsage {
  judgeId: JudgeModelId;
  inputTokens: number;
  outputTokens: number;
  complete: boolean;
}

/**
 * Story 6.2 (AC3/AC4): the two pinned judge models, built exactly the way
 * `createChatModel` builds any other OpenRouter id (no registry validation
 * inside it, Code Map) — passed as `createTrajectoryLLMAsJudge`'s `judge`
 * param (never the `model: "provider:id"` string form, which assumes a
 * native provider API rather than routing through OpenRouter).
 *
 * `onUsage` (User-requested, 2026-11-20): `createTrajectoryLLMAsJudge`
 * calls `judge.invoke(...)` internally with no way to pass per-call config
 * through, so usage is captured the only other way available — a
 * `handleLLMEnd` callback bound to the model instance itself at
 * construction time, reading the same `llmOutput.tokenUsage` shape
 * `@langchain/openai`'s `ChatOpenAI` always attaches. Fires once per real
 * judge call made through either returned model, for as long as the whole
 * eval run keeps reusing these two shared instances (Design Notes: "judges
 * in `JUDGE_MODEL_IDS` score ... sequentially").
 */
export function createJudgeModels(
  env: Pick<Env, 'OPENROUTER_API_KEY'>,
  onUsage?: (usage: JudgeCallUsage) => void,
): Record<JudgeModelId, ChatOpenAI> {
  return Object.fromEntries(
    JUDGE_MODEL_IDS.map((id) => {
      const callbacks = onUsage
        ? [
            {
              handleLLMEnd: (output: LLMResult) => {
                const tokenUsage = output.llmOutput?.tokenUsage as
                  | { promptTokens?: number; completionTokens?: number }
                  | undefined;
                onUsage({
                  judgeId: id,
                  inputTokens: tokenUsage?.promptTokens ?? 0,
                  outputTokens: tokenUsage?.completionTokens ?? 0,
                  complete: tokenUsage !== undefined,
                });
              },
            },
          ]
        : undefined;
      return [id, createChatModel(env, id, callbacks)];
    }),
  ) as Record<JudgeModelId, ChatOpenAI>;
}
