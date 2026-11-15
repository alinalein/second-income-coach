import { describe, expect, it } from 'vitest';
import { fakeModel } from '@langchain/core/testing';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { buildSystemPrompt, createCoachAgent, PERSONALITY_PROMPTS, DEFAULT_PERSONALITY } from './index.js';

// AC3: "the `prompt` function instructs the model to reply in that message's
// language ... re-evaluated every turn". AC4: "personality tone and reply
// language come from the same `prompt` function, not separate per-language
// definitions" — asserted by calling the one function and checking both
// concerns are present in its single output, and that the output is stable
// across calls (no hidden per-language branching).
describe('buildSystemPrompt (AC3/AC4: personality + reply-language in one prompt function)', () => {
  it('includes both the default personality tone and a language-matching instruction, identically on every call', () => {
    const first = buildSystemPrompt();
    const second = buildSystemPrompt();

    expect(DEFAULT_PERSONALITY).toBe('friendly');
    expect(first).toContain(PERSONALITY_PROMPTS.friendly);
    expect(first).toMatch(/same language/i);
    expect(first).toMatch(/German or English/);
    expect(second).toBe(first);
  });
});

// Hook-integration test (same pattern as `moderation.test.ts`'s
// `createModerationMiddleware (hook integration)` block): without this,
// nothing above the pure-function level would catch `buildSystemPrompt`
// being dropped from, or the wrong function wired into, `createCoachAgent`'s
// `middleware` array — asserts the actual model invocation receives a
// system message equal to `buildSystemPrompt()`'s output.
describe('createCoachAgent (hook integration: systemPrompt middleware wiring)', () => {
  it("invokes the model with a system message equal to buildSystemPrompt()'s output", async () => {
    const model = fakeModel().respond(new AIMessage('Sure, happy to help!'));
    const agent = createCoachAgent({
      env: { OPENROUTER_API_KEY: 'test-key', MISTRAL_API_KEY: 'test-key' },
      checkpointer: new MemorySaver(),
      model,
      classify: async () => ({}),
    });

    await agent.invoke(
      { messages: [new HumanMessage('Hello')] },
      { configurable: { thread_id: 'discovery:test-user' } },
    );

    const [call] = model.calls;
    const systemMessage = call?.messages.find((message) => message._getType() === 'system');
    expect(systemMessage?.text).toBe(buildSystemPrompt());
  });
});
