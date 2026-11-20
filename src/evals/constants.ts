import { MODEL_REGISTRY } from '../agent/registry.js';

/**
 * Story 6.2 (AC5): the 80% per-model tool-call-accuracy target, as one named
 * tunable constant — never hardcoded again elsewhere in `src/evals/`.
 */
export const TRAJECTORY_ACCURACY_TARGET = 0.8;

/**
 * Story 6.2 (Boundary): evaluated here only — never added to
 * `MODEL_REGISTRY` or any selectable list (AC6/AC7). Built the same way as
 * every registry chat model (`createChatModel(env, EVAL_ONLY_MODEL_ID)`),
 * which validates nothing against the registry itself.
 */
export const EVAL_ONLY_MODEL_ID = 'anthropic/claude-sonnet-5.5';

/**
 * Story 6.2 (AC3/AC4): the two, and only two, models that ever judge a
 * quality case — pinned by exact id, never a caller-supplied/registry-driven
 * value.
 */
export const JUDGE_MODEL_IDS = ['google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash'] as const;

export type JudgeModelId = (typeof JUDGE_MODEL_IDS)[number];

/**
 * Story 6.2 (AC6): the 4 models exercised by the trajectory eval suite — the
 * 3 registry `chat`-category ids (read live off `MODEL_REGISTRY`, never
 * hand-copied — AD-16's "never hand-copied separately" precedent) plus the
 * one eval-only id above.
 */
export const EVAL_MODEL_IDS: readonly string[] = [
  ...MODEL_REGISTRY.filter((entry) => entry.category === 'chat').map((entry) => entry.id),
  EVAL_ONLY_MODEL_ID,
];

/** User-requested (2026-11-20): how many real `buildStartStepAckMessage`
 * calls each model gets for the ack-latency median/max — shared by
 * `trajectory.eval.ts`'s own dedicated `it`s (part of the full `npm run
 * eval` run) and `measure-latency.ts`'s standalone `npm run eval:latency`
 * (same measurement, same constant, never two numbers drifting apart). */
export const ACK_LATENCY_CALLS_PER_MODEL = 5;

/** Any fixed, plausible step title — `buildStartStepAckMessage` only uses
 * it to name the step in the prompt; it isn't what's being measured. */
export const ACK_LATENCY_STEP_TITLE = 'Post your first listing';
