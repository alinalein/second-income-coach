import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  containsGuiltLanguage,
  createGuiltLanguageMiddleware,
  NEUTRAL_CHECKIN_FALLBACK_EN,
  NEUTRAL_CHECKIN_FALLBACK_DE,
} from './guilt-language.js';

// AD-12: "the 'no streak-shaming/guilt language' constraint ... mechanically
// verifiable." Table-driven over the pure matcher — both languages, and the
// two neutral fallback texts themselves must never self-trigger.
describe('containsGuiltLanguage (AD-12: mechanically verifiable check)', () => {
  it.each([
    ['EN streak-broken phrasing', "You broke your streak, but that's okay.", true],
    ['EN accusatory missed phrasing', "You missed your check-in yesterday.", true],
    ['EN shame/guilt wording', "No need to feel guilty about it.", true],
    ['EN fell-behind framing', "You fell behind on your plan.", true],
    ['DE streak-broken phrasing', 'Deine Serie ist leider unterbrochen.', true],
    ['DE accusatory missed phrasing', 'Du hast deinen Check-in verpasst.', true],
    ['DE shame wording', 'Das muss dir nicht peinlich sein, aber du bist schuldig.', true],
    ['neutral EN check-in question', 'How are you feeling today — low, medium, or high energy?', false],
    ['warm EN completion text', "Nice work finishing 'List your first item' — that's a solid step forward.", false],
    ['neutral DE check-in question', 'Wie ist deine Energie heute — niedrig, mittel oder hoch?', false],
    [
      'the EN neutral fallback itself never self-triggers',
      NEUTRAL_CHECKIN_FALLBACK_EN,
      false,
    ],
    [
      'the DE neutral fallback itself never self-triggers',
      NEUTRAL_CHECKIN_FALLBACK_DE,
      false,
    ],
  ] as const)('%s -> %s', (_name, text, expected) => {
    expect(containsGuiltLanguage(text)).toBe(expected);
  });
});

function state(messages: (HumanMessage | AIMessage)[]) {
  return { messages };
}

// AD-12: "Regeneration is capped at a bounded number of attempts ...; if
// still flagged after that, fall back to a generic neutral check-in
// message." Two scenarios, each driven by a fake model whose scripted
// replies control which branch fires.
describe('createGuiltLanguageMiddleware (AD-12: bounded regeneration + neutral fallback)', () => {
  it('accepts a regenerated reply once it stops triggering, within the cap', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(new AIMessage('Still mentions a broken streak.'))
      .mockResolvedValueOnce(new AIMessage('Welcome back, ready for your next step?'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `createMiddleware`'s return type doesn't narrow `afterModel` to the plain-function form we configured it with (same pattern as `moderation.test.ts`).
    const middleware = createGuiltLanguageMiddleware({ model: { invoke } }) as any;

    const aiMessage = new AIMessage({ id: 'ai-1', content: 'You broke your streak.' });
    const result = await middleware.afterModel(state([new HumanMessage('hi'), aiMessage]), { configurable: {} });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect((result as { messages: AIMessage[] }).messages[0]!.text).toBe('Welcome back, ready for your next step?');
  });

  it('falls back to the fixed neutral message once the regeneration cap is exhausted', async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage('You missed your check-in again.'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
    const middleware = createGuiltLanguageMiddleware({ model: { invoke }, maxRegenerations: 2 }) as any;

    const aiMessage = new AIMessage({ id: 'ai-1', content: 'You broke your streak.' });
    const result = await middleware.afterModel(state([new HumanMessage('hi'), aiMessage]), { configurable: {} });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect((result as { messages: AIMessage[] }).messages[0]!.text).toBe(NEUTRAL_CHECKIN_FALLBACK_EN);
  });

  it('picks the German fallback when the triggering human message was German', async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage('Du hast deinen Check-in verpasst.'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
    const middleware = createGuiltLanguageMiddleware({ model: { invoke }, maxRegenerations: 1 }) as any;

    const aiMessage = new AIMessage({ id: 'ai-1', content: 'Deine Serie ist unterbrochen.' });
    const result = await middleware.afterModel(state([new HumanMessage('Ich bin wieder da.'), aiMessage]), {
      configurable: {},
    });

    expect((result as { messages: AIMessage[] }).messages[0]!.text).toBe(NEUTRAL_CHECKIN_FALLBACK_DE);
  });

  it('passes a clean reply through unchanged', async () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
    const middleware = createGuiltLanguageMiddleware({ model: { invoke } }) as any;

    const aiMessage = new AIMessage({ id: 'ai-1', content: 'Welcome back, ready for your next step?' });
    const result = await middleware.afterModel(state([new HumanMessage('hi'), aiMessage]), { configurable: {} });

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

// Story 6.1 AC ("Given each of the 3 personalities (CAP-7) / the guilt/
// streak-language guardrail test runs / it is run once per personality, not
// just the default one"). AD-20: "Personality ... is a prompt layer only -
// it never changes the tool boundary or bypasses any constraint" - personality
// has no parameter on `createGuiltLanguageMiddleware`/`containsGuiltLanguage`
// at all, so the guardrail must catch and replace guilt language the same
// way regardless of which personality's own tone produced the flagged reply.
describe('createGuiltLanguageMiddleware (Story 6.1 AC: once per personality, not just the default)', () => {
  it.each([
    ['formal', 'You failed to complete your check-in as scheduled.'],
    ['friendly', "Aw, you broke your streak — that's a bummer, but let's bounce back!"],
    ['terse', 'Streak broken. You missed it.'],
  ] as const)('falls back to the neutral message for a flagged reply in the "%s" personality\'s tone', async (_personality, flaggedText) => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage(flaggedText));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
    const middleware = createGuiltLanguageMiddleware({ model: { invoke }, maxRegenerations: 1 }) as any;

    const aiMessage = new AIMessage({ id: 'ai-1', content: flaggedText });
    const result = await middleware.afterModel(state([new HumanMessage('hi'), aiMessage]), { configurable: {} });

    expect((result as { messages: AIMessage[] }).messages[0]!.text).toBe(NEUTRAL_CHECKIN_FALLBACK_EN);
  });
});
