import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware } from 'langchain';
import { detectReplyLanguage } from './language.js';
import { lastMessageOfType } from './moderation.js';

/**
 * AD-12: "capped at a bounded number of attempts (e.g. 2)." Two
 * regenerations plus the original reply = 3 total attempts before the
 * fallback below is used.
 */
export const GUILT_LANGUAGE_MAX_REGENERATIONS = 2;

/**
 * AD-12's own fallback — same fixed DE/EN-constant-pair precedent as
 * `moderation.ts`'s `UNSAFE_RESPONSE_FALLBACK_MESSAGE`. Deliberately never
 * interpolates a day count or any other detail of the gap — the same exact
 * sentence regardless of how many check-ins were missed (NFR1/Story 4.2 AC:
 * "identical for any number of missed check-ins").
 */
export const NEUTRAL_CHECKIN_FALLBACK_EN =
  "Good to have you back — no need to explain a gap. I've adjusted your timeline, so whenever you're ready, let's pick up with your next step.";

export const NEUTRAL_CHECKIN_FALLBACK_DE =
  'Schön, dass du wieder da bist — du musst keine Pause erklären. Ich habe deinen Zeitplan angepasst, also lass uns einfach bei deinem nächsten Schritt weitermachen, sobald du bereit bist.';

const GUILT_LANGUAGE_REGENERATION_INSTRUCTION =
  'Rewrite your previous reply so it never mentions a broken/reset streak, never tells the user they missed, ' +
  "skipped, or failed to do something, and uses no guilt, shame, or disappointment language. Keep the same " +
  'information and warmth, just phrased neutrally and encouragingly, in the same language as before.';

/**
 * AD-12: "a separate, lightweight check ... scoped to CAP-4 responses
 * only — not Mistral Moderation." Deterministic keyword/phrase matching
 * (English + German) rather than a second model call, so it's mechanically
 * verifiable and unit-testable without any network access — same spirit as
 * `moderation.ts`'s own `redactPii` regex scrub.
 */
const GUILT_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /\bstreak\b[^.!?]{0,30}\b(broke|broken|lost|reset|ended)\b/i,
  /\b(broke|broken|reset)\b[^.!?]{0,30}\bstreak\b/i,
  /\byou (missed|skipped|failed to|didn't|haven't|forgot to)\b/i,
  /\byou should have\b/i,
  /\blet (yourself|us) down\b/i,
  /\b(shame|shameful|guilt|guilty|disappointed|disappointing)\b/i,
  /\bfell (behind|off track)\b/i,
  // German equivalents.
  /\b(serie|streak)\b[^.!?]{0,30}\b(unterbrochen|verloren|gerissen)\b/i,
  /\bdu hast\b[^.!?]{0,30}\b(verpasst|übersprungen|nicht geschafft)\b/i,
  /\bdu hättest\b/i,
  /\b(scham|schämen|schuldig|enttäuscht)\b/i,
  /\bzurückgefallen\b/i,
];

export function containsGuiltLanguage(text: string): boolean {
  return GUILT_LANGUAGE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface CreateGuiltLanguageMiddlewareDeps {
  model: Pick<BaseChatModel, 'invoke'>;
  /** Test-only seam — defaults to `GUILT_LANGUAGE_MAX_REGENERATIONS`. */
  maxRegenerations?: number;
}

/**
 * AD-12: the dedicated `afterModel` guilt-language check, wired only into
 * the plan-thread agent (CAP-4 scope — `src/api/index.ts`'s `plansAgent`),
 * never the discovery/ideas agents. On trigger: regenerate the reply up to
 * `maxRegenerations` times; if still flagged, replace it with the fixed
 * neutral fallback (DE/EN, picked off the triggering human message, same
 * precedent as `moderation.ts`'s own fallback picks).
 */
export function createGuiltLanguageMiddleware({ model, maxRegenerations = GUILT_LANGUAGE_MAX_REGENERATIONS }: CreateGuiltLanguageMiddlewareDeps) {
  return createMiddleware({
    name: 'GuiltLanguageMiddleware',
    afterModel: async (state: { messages: BaseMessage[] }, runtime: { configurable?: { thread_id?: string } }) => {
      const lastAi = lastMessageOfType(state.messages, 'ai');
      if (!lastAi?.text) return undefined;

      let text = lastAi.text;
      let attempts = 0;

      while (containsGuiltLanguage(text) && attempts < maxRegenerations) {
        attempts += 1;
        console.warn('[guilt-language] guilt_language_regenerated', { threadId: runtime.configurable?.thread_id, attempt: attempts });
        const regenerated = await model.invoke([...state.messages.slice(0, -1), new HumanMessage(GUILT_LANGUAGE_REGENERATION_INSTRUCTION)]);
        text = regenerated.text ?? '';
      }

      if (containsGuiltLanguage(text)) {
        console.warn('[guilt-language] guilt_language_fallback', { threadId: runtime.configurable?.thread_id });
        const lastHuman = lastMessageOfType(state.messages, 'human');
        const fallback = detectReplyLanguage(lastHuman?.text ?? '') === 'de' ? NEUTRAL_CHECKIN_FALLBACK_DE : NEUTRAL_CHECKIN_FALLBACK_EN;
        return { messages: [new AIMessage({ id: lastAi.id, content: fallback })] };
      }

      if (text !== lastAi.text) {
        return { messages: [new AIMessage({ id: lastAi.id, content: text })] };
      }
      return undefined;
    },
  });
}
