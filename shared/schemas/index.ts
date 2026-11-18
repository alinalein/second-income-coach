import { z } from 'zod';
import { microMoneySchema } from '../money.js';

/**
 * Story 1.1 placeholder schema.
 *
 * This is the one shared Zod schema location importable by both the Express
 * backend (`src/`) and the React frontend (`web/`) via the `@app/shared`
 * package — proving the workspace wiring end to end. It is intentionally
 * domain-free: no idea/plan/check-in/settings shapes belong here yet (those
 * land with the stories that introduce them). The backend's health route and
 * the frontend's status indicator both import and validate against this same
 * schema, with its TypeScript type derived via `z.infer` — never hand-written.
 */
export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  service: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * Story 1.2: the authenticated-user shape returned by `GET /api/auth/session`
 * and consumed by the frontend's `useAuthStatus()` hook to decide which view
 * to render (I/O matrix: "authenticated view renders"). Mirrors the
 * `healthStatusSchema` pattern above — one shared Zod schema, imported by
 * both sides, with its TypeScript type derived via `z.infer`.
 */
export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1),
  picture: z.string().nullable(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z.object({
  user: authUserSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

/**
 * Story 1.3: the shared chat message shape, used by both the backend's
 * `POST`/`GET /api/chat/messages` routes and the frontend's `ChatThread`/
 * `ChatMessage` components. `kind` distinguishes a normal agent reply
 * (`'message'`) from the two fixed moderation/safety texts (`'notice'`) and a
 * model-failure fallback (`'error'`), so the UI can render each distinctly
 * (Code Map: "message list, text input, 'notice'/'error' kinds styled
 * distinctly from 'message' bubbles").
 */
/**
 * Story 5.2 (AD-21/AD-27): the display-only shape attached to an assistant
 * `ChatMessage` that was produced by a `chat.ts`/`plan-chat.ts` turn
 * (Boundary: a direct-path flow or a user message never carries this).
 * `amount` is `null` only when the turn's resolved model had no registry
 * price match — token counts still show either way, never a guessed/zero
 * figure. `isEstimate` mirrors `ConvertedMoney.isEstimate` (`shared/
 * money.ts`): `true` only for a genuine currency conversion, never for a
 * same-currency (or no-price) amount.
 *
 * Bug fix (epics.md amendment): `amount` is `MicroMoney`, not `Money` — a
 * typical per-message AI cost is a fraction of a cent, which `Money`'s
 * minor-unit (cent) granularity rounds straight to zero.
 */
export const messageCostSchema = z.object({
  modelId: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  amount: microMoneySchema.nullable(),
  isEstimate: z.boolean(),
});

export type MessageCost = z.infer<typeof messageCostSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  kind: z.enum(['message', 'notice', 'error']),
  content: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** Story 5.2: present only on an assistant reply from a `chat.ts`/
   * `plan-chat.ts` turn that carried a model call — absent on every user
   * message and on any direct-path reply (Boundary). */
  cost: messageCostSchema.optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Story 5.3 (AD-4/AD-22): thumbs up/down plus an optional comment, posted to
 * `POST .../messages/:messageId/feedback`. The comment passes through the
 * same `evaluateUserMessage` moderation (AD-11) already used for chat
 * input — this schema only validates shape, never moderation outcome.
 */
export const feedbackRatingSchema = z.enum(['up', 'down']);

export type FeedbackRating = z.infer<typeof feedbackRatingSchema>;

export const recordFeedbackRequestSchema = z.object({
  rating: feedbackRatingSchema,
  comment: z.string().min(1).optional(),
});

export type RecordFeedbackRequest = z.infer<typeof recordFeedbackRequestSchema>;

/** The stored result after moderation — `comment` is `null` when none was
 * submitted, or when a submitted one was dropped for a jailbreak flag
 * (I/O matrix: "rating still stored, comment dropped"). */
export const messageFeedbackSchema = z.object({
  rating: feedbackRatingSchema,
  comment: z.string().nullable(),
});

export type MessageFeedback = z.infer<typeof messageFeedbackSchema>;

export const recordFeedbackResponseSchema = z.object({
  feedback: messageFeedbackSchema,
});

export type RecordFeedbackResponse = z.infer<typeof recordFeedbackResponseSchema>;

/**
 * Intent: "the shared Zod message schema ... enforces a 4000-char max; an
 * over-length message is rejected at the schema boundary, never silently
 * truncated." This is the one place that limit is defined — both
 * `sendMessageRequestSchema` below and the frontend's input affordance import
 * it rather than hard-coding the number twice.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 4000;

export const sendMessageRequestSchema = z.object({
  content: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(CHAT_MESSAGE_MAX_LENGTH, `Message cannot exceed ${CHAT_MESSAGE_MAX_LENGTH} characters`),
});

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const sendMessageResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

export const chatHistoryResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export type ChatHistoryResponse = z.infer<typeof chatHistoryResponseSchema>;

/**
 * Intent: "A model call that still fails after its configured retries
 * returns the user a clear, generic error ... the process stays up." One
 * shared literal — the backend's resilience-exhausted fallback
 * (`src/agent/resilience.ts`) and the frontend's own transport-failure
 * fallback (`web/src/chat/ChatThread.tsx`) both import this instead of each
 * hard-coding the same sentence separately.
 */
export const MODEL_FAILURE_MESSAGE =
  "Something went wrong on our end and I couldn't generate a response. Please try again in a moment.";

export * from './intake.js';
export * from './ideas.js';
export * from './idea-translations.js';
export * from './plans.js';
export * from '../money.js';
export * from '../region.js';
export * from './settings.js';
export * from './check-ins.js';

/**
 * Story 1.5: the turn-scoped SSE progress/result wire contract. Re-exported
 * at the END of this file (not the top) — `progress.ts` imports
 * `chatMessageSchema` back from this module, and this file's own
 * `chatMessageSchema` export must already be initialized by the time that
 * circular import is resolved.
 */
export * from './progress.js';
