import type { Env } from '../config/env.js';
import { MODERATION_MODEL_NAME } from './moderation.js';

/**
 * AD-20: "The model registry ... is the single source for pricing - no price
 * is ever hardcoded elsewhere." Every provider here is routed through
 * OpenRouter with the one `OPENROUTER_API_KEY` the rest of this codebase
 * already requires (`src/agent/model.ts`'s existing Design Note: "one key
 * covers every provider in the model registry, not just OpenAI") — `mistral`
 * is the one exception, for the moderation entry below, which reuses the
 * already-required `MISTRAL_API_KEY` moderation already depends on
 * (`src/agent/moderation.ts`). No story has introduced a provider that needs
 * its own new key yet, so `ModelProvider` only lists these two.
 */
export type ModelProvider = 'openrouter' | 'mistral';

/**
 * AD-20: "The moderation model (AD-11) and the transcription model (AD-9)
 * are never exposed as user-selectable options, regardless of registry
 * contents." `category` is what `listSelectableModels` filters on — adding a
 * further transcription entry needs no
 * change to that filter, only a new entry with `category: 'transcription'`.
 */
export type ModelCategory = 'chat' | 'moderation' | 'transcription' | 'translation';

export interface ModelRegistryEntry {
  readonly id: string;
  readonly provider: ModelProvider;
  readonly displayName: string;
  readonly category: ModelCategory;
  readonly pricePerMillionInputTokens: number;
  readonly pricePerMillionOutputTokens: number;
  readonly priceAsOf: string;
}

/**
 * The first entry is the default model (`DEFAULT_MODEL_ID` below) — same
 * identity `src/agent/model.ts` hardcoded pre-Story-5.1 as `COACH_MODEL_NAME`
 * ("openai/gpt-6-luna", routed via OpenRouter's OpenAI-compatible endpoint).
 *
 * Pricing/`priceAsOf` for the three `chat` entries were checked against
 * OpenRouter's own per-model pages (each id's `https://openrouter.ai/<id>`
 * page, cross-checked against a second source quoting the same OpenRouter
 * rate), not from memory — each is OpenRouter's standard (non-batch) listed
 * rate for that exact id; the `:batch` variant of the same model is a
 * cheaper, separate id this registry does not list. `claude-haiku-4.5`'s
 * price still needs the user's own verification (see its own comment).
 *
 * `mistralai/mistral-large-4-0` was removed (previously here, flagged
 * unverified): in production it consistently exceeded
 * `src/agent/model.ts`'s `MODEL_CALL_TIMEOUT_MS` while every other entry
 * responded normally. Its OpenRouter page itself resolves (HTTP 200), but
 * independent sources describe Mistral Large 4 as still in OpenRouter
 * public preview as of its Oct 2026 launch, which would explain the
 * consistently slow/absent response relative to the other (presumably GA)
 * entries. Re-add it once it's confirmed stable.
 */
/**
 * Story 2.7: the internal-only model `translate-idea-cards.ts` calls for
 * idea-card translation — same never-user-selectable precedent as
 * `MODERATION_MODEL_NAME` (category !== 'chat' excludes it from
 * `listSelectableModels`). Defined here, not hand-copied at its one call
 * site, same AD-16 "no raw literal duplicated" discipline. Declared before
 * `MODEL_REGISTRY` (not after, like `MODERATION_MODEL_NAME`'s own import)
 * since the registry entry below references it.
 *
 * **Live-bug fix (post-handoff):** originally `'openai/gpt-6-mini'`, an id
 * invented by analogy with the existing chat entries' naming and never
 * actually verified against this account's real OpenRouter catalog — every
 * real translate call failed immediately with `400 ... is not a valid model
 * ID` (reproduced live, from the running dev server's own error log, not a
 * guess). Pointed at the exact same id as `DEFAULT_MODEL_ID` instead — the
 * one entry already proven live-working by every `generate_ideas`/chat
 * call — since "never in the user-selectable registry" is a `category`
 * property (this entry's own `category: 'translation'` already satisfies
 * it, same mechanism as the moderation entry below), not a constraint on
 * which literal id the underlying call may use.
 *
 * Story 2.6 AC3 (measured, not guessed): one real `translateIdeaCards` call
 * against `anthropic/claude-haiku-4.5` as a swap candidate, same single
 * one-idea translation request on both sides, real OpenRouter credentials,
 * same dev Postgres — `openai/gpt-6-luna` (current): 2436ms;
 * `anthropic/claude-haiku-4.5` (candidate): 5107ms, roughly 2.1x slower, not
 * faster. No real latency win, so this stays `openai/gpt-6-luna` per the
 * spec's own "keep it unless a measured win" rule.
 */
export const TRANSLATION_MODEL_ID = 'openai/gpt-6-luna';

/**
 * Story 2.10: the internal-only model `classify-failure-pattern.ts` calls to
 * classify `failurePattern` for a direct (non-agent-loop) intake save —
 * reuses `TRANSLATION_MODEL_ID`'s exact registry entry (same id/category:
 * 'translation', already excluded from `listSelectableModels`), same
 * never-user-selectable precedent — no new model id, no new env var, no
 * migration.
 */
export const INTAKE_CLASSIFIER_MODEL_ID = TRANSLATION_MODEL_ID;

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
  {
    id: 'openai/gpt-6-luna',
    provider: 'openrouter',
    displayName: 'GPT-6 Luna',
    category: 'chat',
    pricePerMillionInputTokens: 0.1,
    pricePerMillionOutputTokens: 0.5,
    priceAsOf: '2026-11-14',
    // Above a 272K-input-token long-context threshold, OpenRouter prices
    // this id at $0.20/$0.75 per 1M input/output tokens instead. There is
    // no `long_context_tier` (or similar) field on `ModelRegistryEntry` to
    // hold that second rate, so it's recorded here as a comment only, per
    // instruction, rather than adding one.
  },
  {
    id: 'google/gemini-3.8-flash',
    provider: 'openrouter',
    displayName: 'Gemini 3.8 Flash',
    category: 'chat',
    pricePerMillionInputTokens: 0.75,
    pricePerMillionOutputTokens: 3.75,
    priceAsOf: '2026-11-14',
    // The output price bills thinking tokens at the same per-token rate as
    // regular output tokens (no separate reasoning-token rate). Per
    // OpenRouter, this id's price rises to $1.50/$7.50 from 2027-01-01 —
    // deliberately not implemented as date-based logic; this registry entry
    // will need a manual update on/after that date.
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    provider: 'openrouter',
    displayName: 'Claude Haiku 4.5',
    category: 'chat',
    pricePerMillionInputTokens: 1,
    pricePerMillionOutputTokens: 5,
    priceAsOf: '2026-11-16',
    // Looked up on OpenRouter's own model page for this id (standard,
    // non-batch rate) rather than from memory — still flagged for the
    // user's own verification before this is treated as final.
  },
  {
    // Same literal as `MODERATION_MODEL_NAME` (imported, not hand-copied —
    // AD-16's "never hand-copied separately" applies to this id too, even
    // though it's a plain string constant rather than a Zod schema).
    id: MODERATION_MODEL_NAME,
    provider: 'mistral',
    displayName: 'Mistral Moderation 2',
    category: 'moderation',
    // Never priced per-token in practice and never displayed (category !==
    // 'chat' is filtered out before reaching any UI) — 0 is a placeholder,
    // not a claim about Mistral's actual moderation pricing.
    pricePerMillionInputTokens: 0,
    pricePerMillionOutputTokens: 0,
    priceAsOf: '2026-11-01',
  },
  {
    // Story 2.7: idea-card translation — `category: 'translation'` keeps
    // this out of `listSelectableModels`'s existing `chat`-only filter
    // without widening that filter itself, same mechanism the moderation
    // entry above already relies on.
    id: TRANSLATION_MODEL_ID,
    provider: 'openrouter',
    displayName: 'GPT-6 Luna (translation)',
    category: 'translation',
    // Never priced per-token in practice and never displayed (category !==
    // 'chat' is filtered out before reaching any UI) — 0 is a placeholder,
    // same precedent as the moderation entry above.
    pricePerMillionInputTokens: 0,
    pricePerMillionOutputTokens: 0,
    priceAsOf: '2026-11-17',
  },
] as const;

export const DEFAULT_MODEL_ID: string = MODEL_REGISTRY[0]!.id;

type ProviderEnv = Partial<Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>>;

const PROVIDER_ENV_KEYS: Record<ModelProvider, keyof ProviderEnv> = {
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

export function isProviderConfigured(provider: ModelProvider, env: ProviderEnv): boolean {
  return Boolean(env[PROVIDER_ENV_KEYS[provider]]);
}

export function findModelEntry(id: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((entry) => entry.id === id);
}

/**
 * AC: "the settings screen lists selectable models ... only providers with a
 * configured server-side key appear, and the moderation/transcription models
 * never appear as options."
 */
export function listSelectableModels(env: ProviderEnv): ModelRegistryEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.category === 'chat' && isProviderConfigured(entry.provider, env));
}

/**
 * AC: "an unknown or no-longer-selectable id resolves to the default model
 * rather than erroring." Deliberately checks registry *membership* (does a
 * `chat`-category entry with this id exist at all), not live key-configured
 * status — a currently-registered id whose provider key has since gone
 * missing is a *runtime* fallback concern (shown to the user with a notice,
 * `src/agent/model.ts`'s `createModelSelectionMiddleware`), not a silent
 * resolution one. Only a genuinely unrecognized id (never existed, or
 * existed as a moderation/transcription entry) resolves here, silently.
 */
export function resolveModelId(id: string | null | undefined): string {
  if (!id) return DEFAULT_MODEL_ID;
  const entry = findModelEntry(id);
  if (!entry || entry.category !== 'chat') return DEFAULT_MODEL_ID;
  return entry.id;
}
