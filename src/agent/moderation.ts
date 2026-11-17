import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Mistral } from '@mistralai/mistralai';
import { createMiddleware } from 'langchain';
import type { Env } from '../config/env.js';
import { detectReplyLanguage } from './language.js';

/** Intent: "Moderation: Mistral Moderation 2 (`mistral-moderation-2603`, via
 * the official `@mistralai/mistralai` SDK)". */
export const MODERATION_MODEL_NAME = 'mistral-moderation-2603';

/** Intent: the fixed, user-facing text for a `beforeModel` jailbreak
 * rejection. Story 1.4 adds German/English translation keys for this exact
 * string — it must not be duplicated with different wording anywhere else. */
export const JAILBREAK_REJECTION_MESSAGE =
  "I can't help with that request. Let's get back to your second income goals — what would you like to work on?";

/** Story 1.4 (AC2): the German form of `JAILBREAK_REJECTION_MESSAGE`, picked
 * by `detectReplyLanguage` on the rejected message. Colocated here (not in
 * `web/src/locales/`) per Design Notes — the checkpointer only ever persists
 * final, already-resolved `BaseMessage` text, never a translation key. */
export const JAILBREAK_REJECTION_MESSAGE_DE =
  'Dabei kann ich nicht helfen. Lass uns zu deinen Zielen für ein Nebeneinkommen zurückkehren — woran möchtest du arbeiten?';

/** Intent: the fixed, user-facing text for an `afterModel` unsafe-output
 * replacement. */
export const UNSAFE_RESPONSE_FALLBACK_MESSAGE =
  "I wasn't able to give a safe response to that — let's try a different angle. What would you like to focus on?";

/** Story 1.4 (AC2): the German form of `UNSAFE_RESPONSE_FALLBACK_MESSAGE`,
 * picked by `detectReplyLanguage` on the triggering human message. */
export const UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE =
  'Ich konnte darauf keine sichere Antwort geben — lass uns einen anderen Ansatz versuchen. Worauf möchtest du dich konzentrieren?';

// Design Notes: "history read-back re-derives `kind` by exact text match —
// so every language variant needs to be in the set" — all 4 literals, not
// just the EN pair.
const NOTICE_TEXTS: ReadonlySet<string> = new Set([
  JAILBREAK_REJECTION_MESSAGE,
  JAILBREAK_REJECTION_MESSAGE_DE,
  UNSAFE_RESPONSE_FALLBACK_MESSAGE,
  UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE,
]);

/**
 * AC: "the shared `ChatThread`/`ChatMessage` component ... error and
 * neutral-notice rendering". The checkpointer stores plain `BaseMessage`s,
 * not our `kind` metadata, so both the send route's reply and the history
 * read-back classify a reply's `kind` the same way: by comparing its text
 * against this story's two fixed moderation texts.
 */
export function classifyAssistantMessageKind(text: string): 'message' | 'notice' {
  return NOTICE_TEXTS.has(text) ? 'notice' : 'message';
}

export type ModerationCategories = Record<string, boolean>;

/** Injectable seam (same DI pattern as `createAuthRouter`'s `oauthClient`):
 * production wires the real Mistral Moderation 2 call; tests inject a fake
 * that returns controlled categories without a network call. */
export type ClassifyText = (text: string) => Promise<ModerationCategories>;

/**
 * Exported (Story 2.2 Code Map: "reuse exported `ClassifyText`/
 * `defaultClassify(env)`") so `src/agent/moderation-web-search.ts`'s
 * `wrapToolCall` hook can reuse this exact Mistral Moderation 2 call
 * instead of re-implementing a second one — a one-word, additive, non-
 * behavior-changing export, not a change to this file's own logic.
 */
export function defaultClassify(env: Pick<Env, 'MISTRAL_API_KEY'>): ClassifyText {
  const client = new Mistral({ apiKey: env.MISTRAL_API_KEY });
  return async (text: string) => {
    const response = await client.classifiers.moderate({ model: MODERATION_MODEL_NAME, inputs: text });
    return (response.results[0]?.categories ?? {}) as ModerationCategories;
  };
}

// Mistral Moderation 2's input-side category used for AD-11's jailbreak check.
const JAILBREAK_CATEGORY = 'jailbreaking';
// ...and its PII category.
const PII_CATEGORY = 'pii';
// Output-side harmful-content categories considered "unsafe" for the
// `afterModel` fallback — deliberately excludes `pii`/`jailbreaking`, which
// are input-side concepts.
const UNSAFE_OUTPUT_CATEGORIES = [
  'sexual',
  'hate_and_discrimination',
  'violence_and_threats',
  'dangerous',
  'criminal',
  'selfharm',
];

function flaggedCategories(categories: ModerationCategories, keys: readonly string[]): string[] {
  return keys.filter((key) => categories[key] === true);
}

/**
 * Boundary: "No log destination (incident logs, LangSmith metadata, error
 * logs) ever contains raw user message text — only flags/categories/ids/
 * lengths." This is the one place an incident is logged, so every caller
 * goes through it rather than hand-rolling `console.*` calls that might slip
 * raw text in.
 */
export function logModerationIncident(
  event: 'jailbreak_rejected' | 'pii_redacted' | 'pii_flagged_unredacted' | 'unsafe_output_replaced',
  details: { threadId?: string; length: number; categories?: string[] },
): void {
  console.warn(`[moderation] ${event}`, details);
}

const PII_REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]'],
  [/\+?\b\d[\d\s().-]{7,}\d\b/g, '[redacted-number]'],
];

/**
 * Mistral's moderation endpoint only returns category flags/scores, never
 * redacted text or span offsets — cleaning flagged content is this module's
 * own responsibility (Intent: "PII → clean/redact, log, don't reject").
 * Deterministic, plain-code regex scrub; not a general-purpose PII detector.
 */
export function redactPii(text: string): string {
  return PII_REDACTION_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export type UserMessageVerdict =
  | { action: 'pass' }
  | { action: 'reject'; content: string }
  | { action: 'redact'; content: string };

/**
 * `beforeModel` decision logic (I/O matrix: "Jailbreak attempt" / "PII in
 * input"), as a pure function over an already-classified category map so it
 * can be unit-tested without a real Mistral call or a LangGraph agent.
 */
export async function evaluateUserMessage(
  text: string,
  classify: ClassifyText,
  threadId: string | undefined,
): Promise<UserMessageVerdict> {
  const categories = await classify(text);

  if (flaggedCategories(categories, [JAILBREAK_CATEGORY]).length > 0) {
    logModerationIncident('jailbreak_rejected', { threadId, length: text.length });
    const content = detectReplyLanguage(text) === 'de' ? JAILBREAK_REJECTION_MESSAGE_DE : JAILBREAK_REJECTION_MESSAGE;
    return { action: 'reject', content };
  }

  if (flaggedCategories(categories, [PII_CATEGORY]).length > 0) {
    const redacted = redactPii(text);
    // `redactPii` only strips the sub-categories it has patterns for
    // (email/phone) — Mistral's `pii` flag also covers ones it doesn't
    // (address, name, id, etc.), where nothing textually changes. Logging
    // `pii_redacted` unconditionally would overclaim cleaning happened;
    // log a distinct event when the text passed through unchanged instead.
    logModerationIncident(redacted !== text ? 'pii_redacted' : 'pii_flagged_unredacted', {
      threadId,
      length: text.length,
    });
    return { action: 'redact', content: redacted };
  }

  return { action: 'pass' };
}

export type AssistantMessageVerdict = { action: 'pass' } | { action: 'replace'; content: string };

/**
 * `afterModel` decision logic (I/O matrix: "Unsafe model output"), same
 * pure-function shape as `evaluateUserMessage` above. `humanText` is the
 * last human message in the conversation (the turn that triggered this
 * reply) — used only to pick the EN/DE form of the fixed fallback (AC2), not
 * passed to `classify`, which still only ever sees the assistant's own text.
 */
export async function evaluateAssistantMessage(
  text: string,
  classify: ClassifyText,
  threadId: string | undefined,
  humanText?: string,
): Promise<AssistantMessageVerdict> {
  const categories = await classify(text);
  const flagged = flaggedCategories(categories, UNSAFE_OUTPUT_CATEGORIES);

  if (flagged.length > 0) {
    logModerationIncident('unsafe_output_replaced', { threadId, length: text.length, categories: flagged });
    const content =
      detectReplyLanguage(humanText ?? '') === 'de' ? UNSAFE_RESPONSE_FALLBACK_MESSAGE_DE : UNSAFE_RESPONSE_FALLBACK_MESSAGE;
    return { action: 'replace', content };
  }

  return { action: 'pass' };
}

export function lastMessageOfType(messages: BaseMessage[], type: 'human' | 'ai'): BaseMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!._getType() === type) return messages[i];
  }
  return undefined;
}

export interface CreateModerationMiddlewareOptions {
  /** Test-only seam — see `ClassifyText`. */
  classify?: ClassifyText;
}

/**
 * Measurement (user-requested): logs how long each moderation step actually
 * takes, so a real run's numbers can answer "does Mistral matter" for
 * latency rather than guessing. `skipped` covers both "never ran" (the
 * trigger-message bypass below) and "nothing to check" (no text on this
 * message) — both are zero-cost, distinguished by `reason`.
 */
function logModerationTiming(
  event: 'moderation_before' | 'moderation_after',
  elapsedMs: number,
  extra: { skipped?: boolean; reason?: string } = {},
): void {
  console.log(`[moderation] ${event}`, { elapsedMs, ...extra });
}

/**
 * Mistral Moderation 2 at `beforeModel`/`afterModel` (Intent). Built with
 * `createMiddleware` — per epic-1-context.md: "Its built-in hooks
 * (`beforeModel`/`wrapToolCall`/`afterModel`, etc.) are the only
 * cross-cutting mechanism" — so moderation never lives outside the agent's
 * own middleware list.
 */
export function createModerationMiddleware(
  env: Pick<Env, 'MISTRAL_API_KEY'>,
  options: CreateModerationMiddlewareOptions = {},
) {
  const classify = options.classify ?? defaultClassify(env);

  return createMiddleware({
    name: 'MistralModerationMiddleware',
    beforeModel: {
      // Declares the jailbreak short-circuit this hook may take (Intent:
      // "jailbreak → reject the turn ... return the fixed response").
      canJumpTo: ['end'],
      hook: async (
        state: { messages: BaseMessage[] },
        runtime: { configurable?: { thread_id?: string; skipInputModeration?: boolean } },
      ) => {
        // Perf fix (user-requested): the lazy `create_plan` trigger message
        // ("call create_plan now") is server-authored, never user input —
        // there is nothing to screen. Scoped to the one call site that sets
        // this flag (`src/api/routes/plans.ts`); every other caller (real
        // user messages, including this same plan thread's own later
        // follow-up questions) never sets it, so AD-11's screening of actual
        // user input is unchanged everywhere else.
        if (runtime.configurable?.skipInputModeration) {
          logModerationTiming('moderation_before', 0, { skipped: true, reason: 'server_authored_trigger' });
          return undefined;
        }

        const lastHuman = lastMessageOfType(state.messages, 'human');
        if (!lastHuman?.text) {
          logModerationTiming('moderation_before', 0, { skipped: true, reason: 'no_text' });
          return undefined;
        }

        const start = Date.now();
        const verdict = await evaluateUserMessage(lastHuman.text, classify, runtime.configurable?.thread_id);
        logModerationTiming('moderation_before', Date.now() - start);

        if (verdict.action === 'reject') {
          return { messages: [new AIMessage({ content: verdict.content })], jumpTo: 'end' as const };
        }
        if (verdict.action === 'redact') {
          // Same id as the message being replaced: the reducer merges by id
          // in place rather than appending a duplicate (Intent: "clean/
          // redact ... processing continues", not a second message).
          return { messages: [new HumanMessage({ id: lastHuman.id, content: verdict.content })] };
        }
        return undefined;
      },
    },
    afterModel: async (state: { messages: BaseMessage[] }, runtime: { configurable?: { thread_id?: string } }) => {
      const lastAi = lastMessageOfType(state.messages, 'ai');
      if (!lastAi?.text) {
        logModerationTiming('moderation_after', 0, { skipped: true, reason: 'no_text' });
        return undefined;
      }

      const lastHuman = lastMessageOfType(state.messages, 'human');
      const start = Date.now();
      const verdict = await evaluateAssistantMessage(
        lastAi.text,
        classify,
        runtime.configurable?.thread_id,
        lastHuman?.text,
      );
      logModerationTiming('moderation_after', Date.now() - start);

      if (verdict.action === 'replace') {
        return { messages: [new AIMessage({ id: lastAi.id, content: verdict.content })] };
      }
      return undefined;
    },
  });
}
