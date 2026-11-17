import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { sumUsage } from './usage.js';

/** AC 6.3-3 (cost against the actual calls the eval run made): `sumUsage`
 * is the one place that reads real `usage_metadata` off a trajectory. */
describe('sumUsage', () => {
  it.each([
    [
      'single AI message with usage',
      [new HumanMessage('hi'), new AIMessage({ content: 'ok', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })],
      { inputTokens: 10, outputTokens: 5, complete: true },
    ],
    [
      'two AI messages (tool call + final reply) summed',
      [
        new HumanMessage('hi'),
        new AIMessage({ content: '', usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }),
        new ToolMessage({ content: 'result', tool_call_id: '1' }),
        new AIMessage({ content: 'done', usage_metadata: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } }),
      ],
      { inputTokens: 30, outputTokens: 10, complete: true },
    ],
    [
      'AI message missing usage_metadata marks the result incomplete',
      [new HumanMessage('hi'), new AIMessage('no usage reported')],
      { inputTokens: 0, outputTokens: 0, complete: false },
    ],
    [
      'no AI message at all is incomplete, not zero-by-coincidence',
      [new HumanMessage('hi')],
      { inputTokens: 0, outputTokens: 0, complete: false },
    ],
  ])('%s', (_label, messages, expected) => {
    expect(sumUsage(messages)).toEqual(expected);
  });
});
