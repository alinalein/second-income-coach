import { isAIMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Story 6.3 (AC: "the eval run's own estimated cost ... against the actual
 * calls the eval run itself made"): token usage summed from the real
 * `AIMessage.usage_metadata` OpenRouter's OpenAI-compatible API attaches to
 * every chat-completion response LangChain's `ChatOpenAI` returns — no new
 * instrumentation needed, just reading what's already on the trajectory.
 * `complete: false` means at least one AI message in the trajectory carried
 * no `usage_metadata` (e.g. a provider that didn't report usage for that
 * call) — the summed figures are then a floor, not a precise total.
 */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  complete: boolean;
}

export function sumUsage(messages: readonly BaseMessage[]): CallUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let sawAiMessage = false;
  let complete = true;

  for (const message of messages) {
    if (!isAIMessage(message)) continue;
    sawAiMessage = true;
    const usage = message.usage_metadata;
    if (usage) {
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
    } else {
      complete = false;
    }
  }

  return { inputTokens, outputTokens, complete: sawAiMessage && complete };
}
