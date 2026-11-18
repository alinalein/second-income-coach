import { z } from 'zod';
import { microMoneySchema } from '../money.js';

/**
 * Story 1.3: the shared chat message shape, used by both the backend's
 * `POST`/`GET /api/chat/messages` routes and the frontend's `ChatThread`/
 * `ChatMessage` components. `kind` distinguishes a normal agent reply
 * (`'message'`) from the two fixed moderation/safety texts (`'notice'`) and a
 * model-failure fallback (`'error'`), so the UI can render each distinctly
 * (Code Map: "message list, text input, 'notice'/'error' kinds styled
 * distinctly from 'message' bubbles").
 *
 * Spec 2.12: split out of `index.ts` into its own file — `check-ins.ts`'s
 * own AC8 `chatMessage` field and `progress.ts`'s `resultEventSchema` both
 * need `chatMessageSchema` directly; importing it back from `index.ts`
 * (which itself re-exports both of those files) is a circular import that
 * a bundler's module-evaluation order can resolve with `chatMessageSchema`
 * still uninitialized at the point either file reads it (confirmed live —
 * `index.ts`'s own re-export position never fixed it, only removing the
 * cycle did). This file has no dependency on `index.ts` at all, so neither
 * of those two files' own imports from it are circular anymore.
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
