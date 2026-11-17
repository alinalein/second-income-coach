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
    // Bug fix (user-reported): the active thumb needs a visibly distinct
    // style, not a one-step muted-to-foreground text color change.
    expect(screen.getByLabelText('Good response')).toHaveClass('text-primary');
  });

  // UI fix (user-reported): a comment is written in a modal dialog
  // (matching the reference screenshot), not an inline-expanding input row.
  it('closes the comment modal and shows the saved comment back after a successful save', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ feedback: { rating: 'up', comment: null } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feedback: { rating: 'up', comment: 'Great plan!' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const MessageFeedback = createMessageFeedbackItem('/api/chat/messages');
    render(<MessageFeedback message={makeMessage()} />);

    fireEvent.click(screen.getByLabelText('Good response'));
    await waitFor(() => expect(screen.getByLabelText('Good response')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByText('Add a comment'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Add a comment (optional)'), { target: { value: 'Great plan!' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('“Great plan!”')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/chat/messages/msg-1/feedback',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ rating: 'up', comment: 'Great plan!' }) }),
    );
  });

  // The modal's own "Cancel" must discard the typed draft without ever
  // calling the feedback endpoint a second time.
  it('discards the draft comment and makes no request when Cancel is clicked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ feedback: { rating: 'up', comment: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const MessageFeedback = createMessageFeedbackItem('/api/chat/messages');
    render(<MessageFeedback message={makeMessage()} />);

    fireEvent.click(screen.getByLabelText('Good response'));
    await waitFor(() => expect(screen.getByLabelText('Good response')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByText('Add a comment'));
    fireEvent.change(screen.getByPlaceholderText('Add a comment (optional)'), { target: { value: 'Never mind' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('“Never mind”')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial thumbs-up POST
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
