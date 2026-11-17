import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { ChatMessage, CHAT_TEXT_CLASS } from './ChatMessage';
import type { ChatMessage as ChatMessageType } from '@app/shared';

function makeMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-1',
    role: 'assistant',
    kind: 'message',
    content: 'Here are some ideas.',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

// AC7 / I/O matrix: "Markdown reply with a `<script>`/`<img onerror>`
// payload ... renders as inert escaped text ... never executes" — and the
// positive case: real Markdown structure (bold, list) renders as actual
// elements, not literal `*`/`#` characters.
describe('ChatMessage (AC7: safe Markdown rendering, no raw HTML)', () => {
  it('renders bold text and a list as real elements, not literal Markdown syntax', () => {
    render(<ChatMessage message={makeMessage({ content: '**Bold idea**\n\n- First\n- Second' })} />);

    expect(screen.getByText('Bold idea').tagName).toBe('STRONG');
    expect(screen.getByText('First').tagName).toBe('LI');
    expect(screen.getByText('Second').tagName).toBe('LI');
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it('renders a <script>/<img onerror> payload as inert text, never as a live element', () => {
    const { container } = render(
      <ChatMessage message={makeMessage({ content: '<script>window.__pwned = true</script><img src=x onerror="alert(1)">' })} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  // AC7's Given clause scopes Markdown to "an agent response containing
  // Markdown" — a user-typed message is never run through the renderer, so
  // literal `**`/`#` characters a user types stay literal in their own bubble.
  it('renders a user-typed message as plain text, never interpreting Markdown syntax', () => {
    const { container } = render(
      <ChatMessage message={makeMessage({ role: 'user', content: '**please** help with a #2 plan' })} />,
    );

    expect(screen.getByText('**please** help with a #2 plan')).toBeInTheDocument();
    expect(container.querySelector('strong')).toBeNull();
  });
});

// AC8: "any chat text (user/assistant/notices) ... all uses one shared font
// size; Markdown structure differs by weight/spacing only." Review follow-up:
// a notice/error now renders through the exact same bubble as a normal
// message — same background, border, radius, padding, font size — no
// separate grey-pill style; the only remaining distinction is the bubble's
// (non-visual) accessibility `role`.
describe('ChatMessage (AC8 + review follow-up: notices/errors share the message bubble, role stays non-visual)', () => {
  it.each([
    ['a plain message bubble', makeMessage({ content: 'Plain reply.' }), undefined],
    ['a notice', makeMessage({ kind: 'notice', content: 'Notice text.' }), 'status'],
    ['an error', makeMessage({ kind: 'error', content: 'Error text.' }), 'alert'],
  ] as const)('%s uses the same bubble styling and shared font size, with role kept non-visual', (_label, message, expectedRole) => {
    render(<ChatMessage message={message} />);

    const bubble = screen.getByText(message.content).closest('.rounded-xl');
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass('rounded-xl', 'border', 'border-border', 'px-4', 'py-2', 'bg-card', 'text-foreground', CHAT_TEXT_CLASS);
    if (expectedRole) {
      expect(bubble).toHaveAttribute('role', expectedRole);
    } else {
      expect(bubble).not.toHaveAttribute('role');
    }
  });

  it('applies the same shared font size to a Markdown heading as to plain bubble text', () => {
    render(<ChatMessage message={makeMessage({ content: '# A heading' })} />);

    const heading = screen.getByText('A heading');
    expect(heading.tagName).toBe('H1');
    expect(heading.className.split(' ')).toContain(CHAT_TEXT_CLASS);
  });
});

// AC5: "the moderated final answer, when revealed, then it's via a
// client-side typing effect over the complete, already-safe text". The
// reveal renders through the same Markdown pipeline as the complete text
// throughout (not plain text swapped for Markdown at the end), hiding a
// trailing unclosed marker — `**`, a bare heading `#`, a bare list `1.` —
// until it closes, so the user never sees raw Markdown syntax (AD-32).
describe('ChatMessage (AC5: client-side typing reveal, Markdown-aware)', () => {
  it.each([
    // [label, content, ms to advance to land mid-marker, expected text at
    // that point, the word to find once fully revealed, its final tag]
    // Markdown trims the trailing space before the (not-yet-closed) marker.
    ['an unclosed bold marker', 'Hello **Bold** world', 160, 'Hello', 'Bold', 'STRONG'],
    ['a bare heading marker', '# Hello', 40, '', 'Hello', 'H1'],
    ['a bare ordered-list marker', '1. First', 60, '', 'First', 'LI'],
  ] as const)('hides %s until it closes, then renders it as real Markdown', (_label, content, midTickMs, expectedMidText, finalWord, finalTag) => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ChatMessage message={makeMessage({ content })} animate />);

      // Mid-reveal, landing exactly where the marker is open but not yet
      // closed: only the safe prefix before it shows — never the raw marker.
      act(() => {
        vi.advanceTimersByTime(midTickMs);
      });
      expect(container.textContent).toBe(expectedMidText);

      // Once fully revealed, the marker has closed and renders as real
      // Markdown structure, exactly like the non-animated render.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText(finalWord).tagName).toBe(finalTag);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the reveal entirely for a notice/error kind, even when animate is true', () => {
    render(<ChatMessage message={makeMessage({ kind: 'notice', content: 'Notice text.' })} animate />);

    expect(screen.getByText('Notice text.')).toBeInTheDocument();
  });
});

// Bug fix (user-reported): footer items (cost/feedback) used to render
// fully visible and clickable for the whole duration of the typing reveal.
// They now stay mounted (so a footer item's own in-session state, e.g.
// `MessageFeedback`'s rating, is never lost) but invisible and
// non-interactive until the reveal finishes, then fade in.
describe('ChatMessage (bug fix: footer items wait for the typing reveal to finish)', () => {
  function TestFooterItem() {
    return <span>footer-item</span>;
  }

  it('hides footer items (opacity-0, non-interactive) while revealing, then fades them in once done', () => {
    vi.useFakeTimers();
    try {
      render(<ChatMessage message={makeMessage({ content: 'A fairly long reply to reveal over several ticks.' })} animate footerItems={[TestFooterItem]} />);

      const footer = screen.getByText('footer-item').parentElement!;
      expect(footer.className).toMatch(/opacity-0/);
      expect(footer.className).toMatch(/pointer-events-none/);

      // Two separate `act()` calls: the first drains the reveal's own
      // interval (flipping `isRevealing` to false only after it returns,
      // since a passive effect reacting to that flip doesn't run until
      // `act()` settles); the second lets that effect's own follow-up
      // `setTimeout` (scheduled only once the first `act()` settled) fire.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(footer.className).toMatch(/opacity-100/);
      expect(footer.className).not.toMatch(/pointer-events-none/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows footer items immediately for a non-animated (history) message, no fade delay', () => {
    render(<ChatMessage message={makeMessage()} footerItems={[TestFooterItem]} />);

    const footer = screen.getByText('footer-item').parentElement!;
    expect(footer.className).toMatch(/opacity-100/);
  });
});
