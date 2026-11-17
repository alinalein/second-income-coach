import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createMessageFeedbackItem } from './MessageFeedback';
import type { ChatMessage as ChatMessageType } from '@app/shared';

function makeMessage(role: ChatMessageType['role'] = 'assistant'): ChatMessageType {
  return { id: 'msg-1', role, kind: 'message', content: 'Here are some ideas.', createdAt: new Date().toISOString() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Story 5.3 AC: "rate any response thumbs up/down ... record_feedback
// persists it" / I/O matrix: "Change/remove rating ... Upsert on change;
// row deleted on remove".
describe('MessageFeedback (createMessageFeedbackItem)', () => {
  it('renders nothing for a user message — feedback is only for agent responses', () => {
    const MessageFeedback = createMessageFeedbackItem('/api/chat/messages');
    const { container } = render(<MessageFeedback message={makeMessage('user')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('posts a rating on click and marks the button pressed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ feedback: { rating: 'up', comment: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const MessageFeedback = createMessageFeedbackItem('/api/chat/messages');
    render(<MessageFeedback message={makeMessage()} />);

    fireEvent.click(screen.getByLabelText('Good response'));

    await waitFor(() => expect(screen.getByLabelText('Good response')).toHaveAttribute('aria-pressed', 'true'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/messages/msg-1/feedback',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ rating: 'up' }) }),
    );
  });

  it('removes the rating via DELETE when the already-active thumb is clicked again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ feedback: { rating: 'down', comment: null } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const MessageFeedback = createMessageFeedbackItem('/api/chat/messages');
    render(<MessageFeedback message={makeMessage()} />);

    fireEvent.click(screen.getByLabelText('Bad response'));
    await waitFor(() => expect(screen.getByLabelText('Bad response')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByLabelText('Bad response'));
    await waitFor(() => expect(screen.getByLabelText('Bad response')).toHaveAttribute('aria-pressed', 'false'));

    expect(fetchMock).toHaveBeenLastCalledWith('/api/chat/messages/msg-1/feedback', expect.objectContaining({ method: 'DELETE' }));
  });
});
