import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageCost } from './MessageCost';
import type { ChatMessage as ChatMessageType, MessageCost as MessageCostType } from '@app/shared';

function makeMessage(cost?: MessageCostType): ChatMessageType {
  return { id: 'msg-1', role: 'assistant', kind: 'message', content: 'Here are some ideas.', createdAt: new Date().toISOString(), cost };
}

afterEach(() => {
  cleanup();
});

// Story 5.2 AC: "token count and estimated cost under each response" / AD-21:
// "a model with no registered price shows token count only ... never a
// guessed or zero cost" — both branches of the one display decision.
describe('MessageCost', () => {
  it('renders nothing for a message with no cost (every user message, and direct-path replies)', () => {
    const { container } = render(<MessageCost message={makeMessage(undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the token counts and estimated amount, labeled as an estimate, for a converted EUR cost', () => {
    render(
      <MessageCost
        message={makeMessage({ modelId: 'openai/gpt-6-luna', inputTokens: 100, outputTokens: 200, amount: { amountMicroUnits: 500_000, currencyCode: 'EUR' }, isEstimate: true })}
      />,
    );

    expect(screen.getByText('100/200 tokens (in/out)')).toBeInTheDocument();
    expect(screen.getByText(/€0[.,]50/)).toBeInTheDocument();
    expect(screen.getByLabelText('estimate')).toBeInTheDocument();
  });

  // Bug fix (user-reported): a typical turn's cost (a fraction of a cent)
  // used to round to a misleading "€0.00" — it now shows enough decimals to
  // be meaningful instead of disappearing.
  it('shows extra decimals for a sub-cent amount instead of rounding it to €0.00', () => {
    render(
      <MessageCost
        message={makeMessage({ modelId: 'openai/gpt-6-luna', inputTokens: 869, outputTokens: 532, amount: { amountMicroUnits: 327, currencyCode: 'EUR' }, isEstimate: true })}
      />,
    );

    expect(screen.queryByText('€0.00')).not.toBeInTheDocument();
    expect(screen.getByText('€0.000327')).toBeInTheDocument();
  });

  it('shows only the token counts, no money figure, when amount is null (no registry price match)', () => {
    render(<MessageCost message={makeMessage({ modelId: 'some/unregistered-model', inputTokens: 100, outputTokens: 200, amount: null, isEstimate: false })} />);

    expect(screen.getByText('100/200 tokens (in/out)')).toBeInTheDocument();
    expect(screen.queryByText('estimate')).not.toBeInTheDocument();
    expect(screen.queryByText(/[€$]/)).not.toBeInTheDocument();
  });
});
