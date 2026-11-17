import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createModelSelectionMiddleware, MODEL_CALL_TIMEOUT_MS, MODEL_FALLBACK_NOTICE, MODEL_FALLBACK_NOTICE_DE } from './model.js';
import { DEFAULT_MODEL_ID } from './registry.js';

const CONFIGURED_ENV = { OPENROUTER_API_KEY: 'key', MISTRAL_API_KEY: 'key' };
const NO_OPENROUTER_ENV = { OPENROUTER_API_KEY: '', MISTRAL_API_KEY: 'key' };
const REQUESTED_MODEL_ID = 'anthropic/claude-haiku-4.5';

type FakeModel = { __modelId: string };
type FakeHandler = (request: { model: FakeModel }) => Promise<AIMessage>;
type FakeMiddleware = { wrapModelCall: (request: unknown, handler: FakeHandler) => Promise<AIMessage> };

function buildMiddleware(env: typeof CONFIGURED_ENV) {
  const buildModel = vi.fn((_env: unknown, modelId: string): FakeModel => ({ __modelId: modelId }));
  const deps = { env, buildModel } as unknown as Parameters<typeof createModelSelectionMiddleware>[0];
  return createModelSelectionMiddleware(deps) as unknown as FakeMiddleware;
}

function fakeRequest(humanText: string) {
  return { messages: [new HumanMessage(humanText)], runtime: { context: { modelId: REQUESTED_MODEL_ID } } };
}

function lastRequestedModelId(handler: ReturnType<typeof vi.fn>): string {
  const lastCall = handler.mock.calls.at(-1) as [{ model: FakeModel }];
  return lastCall[0].model.__modelId;
}

// AC: "a model selection -> ... subsequent turns are answered by the newly
// selected model" / "the selected provider's key is missing ... the system
// falls back to the default model and shows a neutral notice - never a hard
// error." / AD-21: "the model id actually used" is tagged onto
// `response_metadata` on every path through this middleware, not just the
// common case — folded into this same table-driven test rather than a
// separate one, since it's the identical selected-vs-fallback split.
describe('createModelSelectionMiddleware: provider availability', () => {
  it.each([
    ['provider configured', CONFIGURED_ENV, REQUESTED_MODEL_ID, undefined],
    ['provider key missing', NO_OPENROUTER_ENV, DEFAULT_MODEL_ID, MODEL_FALLBACK_NOTICE],
  ] as const)('%s -> handler called with %s, notice %s', async (_label, env, expectedModelId, expectedNotice) => {
    const handler = vi.fn<FakeHandler>(async () => new AIMessage('the answer'));
    const response = await buildMiddleware(env).wrapModelCall(fakeRequest('Hello there'), handler);

    expect(lastRequestedModelId(handler)).toBe(expectedModelId);
    expect(response.text).toBe(expectedNotice ? `${expectedNotice}\n\nthe answer` : 'the answer');
    expect(response.response_metadata?.resolvedModelId).toBe(expectedModelId);
  });
});

// AC (same as above): "a call to the selected model fails -> falls back to
// the default model and shows a neutral notice", with the notice's DE/EN
// pick following the same `detectReplyLanguage`-on-the-triggering-message
// rule as every other fixed text (AD-25).
describe('createModelSelectionMiddleware: model-call failure', () => {
  it.each([
    ['English triggering message', 'Hello there', MODEL_FALLBACK_NOTICE],
    ['German triggering message', 'Ich möchte etwas fragen', MODEL_FALLBACK_NOTICE_DE],
  ] as const)('%s -> falls back to the default model with the matching notice', async (_label, humanText, expectedNotice) => {
    const handler = vi.fn<FakeHandler>().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(new AIMessage('the answer'));

    const response = await buildMiddleware(CONFIGURED_ENV).wrapModelCall(fakeRequest(humanText), handler);

    expect(lastRequestedModelId(handler)).toBe(DEFAULT_MODEL_ID);
    expect(response.text).toBe(`${expectedNotice}\n\nthe answer`);
  });

  // Code Map bug fix: `withFallbackNotice` used to reconstruct a bare
  // `AIMessage` with only `id`/`content`, silently dropping `usage_metadata`
  // — a latent gap for AD-21's "sum every model call's tokens", since a
  // fallback call's own usage would vanish from the turn's total the moment
  // its notice was prepended.
  it('preserves usage_metadata on the fallback response instead of dropping it', async () => {
    const handler = vi.fn<FakeHandler>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new AIMessage({ content: 'the answer', usage_metadata: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } }),
      );

    const response = await buildMiddleware(CONFIGURED_ENV).wrapModelCall(fakeRequest('Hello there'), handler);

    expect(response.usage_metadata).toEqual({ input_tokens: 12, output_tokens: 34, total_tokens: 46 });
    expect(response.response_metadata?.resolvedModelId).toBe(DEFAULT_MODEL_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: a selected model that never resolves (hangs, or an
  // unresponsive/invalid provider endpoint) used to be invisible to this
  // middleware's `try`/`catch` — only a *rejected* call was caught — so the
  // call just kept waiting until the outer node-level timeout aborted the
  // *whole* node, which LangGraph then retried from scratch against the
  // same hanging model every time (observed: repeated `NodeTimeoutError`
  // retries when switching to a Mistral model). This asserts the fallback
  // now resolves well before that outer timeout would ever fire.
  it('falls back to the default model if the selected model never resolves, without waiting out the full node timeout', async () => {
    vi.useFakeTimers();

    const handler = vi.fn<FakeHandler>((request) =>
      request.model.__modelId === DEFAULT_MODEL_ID ? Promise.resolve(new AIMessage('the answer')) : new Promise<AIMessage>(() => {}),
    );

    const responsePromise = buildMiddleware(CONFIGURED_ENV).wrapModelCall(fakeRequest('Hello there'), handler);
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    const response = await responsePromise;

    expect(lastRequestedModelId(handler)).toBe(DEFAULT_MODEL_ID);
    expect(response.text).toBe(`${MODEL_FALLBACK_NOTICE}\n\nthe answer`);
  });
});
