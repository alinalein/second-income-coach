import { z } from 'zod';
import { chatMessageSchema } from './chat.js';

/**
 * Story 1.5 Code Map: the turn-scoped SSE wire contract (AD-19 amended).
 * `progressEventSchema` carries one registry-sourced step key per real
 * `beforeModel`/`wrapModelCall`/`afterModel`/`wrapToolCall` boundary (AC1);
 * `step` is never blank and never the raw internal hook/tool name — only a
 * fixed key from `src/agent/progress.ts`'s registry. Imports `chatMessageSchema`
 * from `./chat.js` rather than redefining it, so `resultEventSchema`'s
 * `message` field is the exact same validator both chat routes already use
 * (Code Map: "`resultEventSchema` (`{type:'result', message: chatMessageSchema}`)").
 * Spec 2.12: imports directly from `./chat.js` (not `./index.js`) — see that
 * file's own doc comment for why the indirect, circular route is unsafe.
 */
export const progressEventSchema = z.object({
  type: z.literal('progress'),
  step: z.string().min(1),
});

export type ProgressEvent = z.infer<typeof progressEventSchema>;

/**
 * AC4/AC6: the terminal SSE frame for a turn — the final, already-moderated
 * answer (or fixed error/notice fallback), closing the stream.
 *
 * `z.lazy(() => chatMessageSchema)`, not a direct reference: `index.ts`
 * re-exports this module via `export * from './progress.js'`, so the two
 * files form an ESM import cycle. ESM evaluates a module's dependencies
 * (this one) to completion *before* the importing module's own top-level
 * code runs, so a direct `message: chatMessageSchema` reference would
 * capture `chatMessageSchema` before `index.ts` has defined it. Wrapping in
 * `z.lazy` defers the reference to first-parse time, by which point both
 * modules have finished loading.
 */
export const resultEventSchema = z.object({
  type: z.literal('result'),
  message: z.lazy(() => chatMessageSchema),
});

export type ResultEvent = z.infer<typeof resultEventSchema>;
