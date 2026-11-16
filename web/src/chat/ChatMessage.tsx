import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { ChatMessage as ChatMessageType } from '@app/shared';
import { cn } from '../lib/utils';

/**
 * AC8: "any chat text (user/assistant/notices) ... all uses one shared font
 * size; Markdown structure differs by weight/spacing only." One constant,
 * applied to the bubble (every kind, including notices/errors — review
 * follow-up: no separate pill style) and every Markdown element override
 * below — never a second font-size class anywhere in this file.
 */
export const CHAT_TEXT_CLASS = 'text-sm';

/**
 * AC7/Boundary: "no raw-HTML-passthrough Markdown plugin" — `react-markdown`
 * in its default configuration already never executes embedded HTML
 * (AD-32); `allowedElements`+`unwrapDisallowed` further constrains output to
 * this fixed subset (headings, paragraphs, lists, bold, line breaks),
 * dropping any other tag down to its text content rather than hiding it.
 */
const MARKDOWN_ALLOWED_ELEMENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'strong', 'br'];

/**
 * `react-markdown` passes its own `node` field to every component override
 * (unused here — these are leaf presentational wrappers) — dropped before
 * spreading the rest onto the real DOM element, rather than forwarded as an
 * invalid DOM attribute.
 */
function dropNode<P extends { node?: unknown }>(props: P): Omit<P, 'node'> {
  const rest: Partial<P> = { ...props };
  delete rest.node;
  return rest as Omit<P, 'node'>;
}

// Every override shares `CHAT_TEXT_CLASS` (AC8) — headings/bold are
// distinguished only by `font-*`/spacing utility classes layered on top.
const markdownComponents: Components = {
  h1: (props) => <h1 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-2 font-bold first:mt-0')} {...dropNode(props)} />,
  h2: (props) => <h2 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-2 font-bold first:mt-0')} {...dropNode(props)} />,
  h3: (props) => <h3 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-2 font-semibold first:mt-0')} {...dropNode(props)} />,
  h4: (props) => <h4 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-2 font-semibold first:mt-0')} {...dropNode(props)} />,
  h5: (props) => <h5 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-1 font-semibold first:mt-0')} {...dropNode(props)} />,
  h6: (props) => <h6 className={cn(CHAT_TEXT_CLASS, 'mb-1 mt-1 font-semibold first:mt-0')} {...dropNode(props)} />,
  p: (props) => <p className={cn(CHAT_TEXT_CLASS, 'mb-1 last:mb-0')} {...dropNode(props)} />,
  ul: (props) => <ul className={cn(CHAT_TEXT_CLASS, 'mb-1 list-disc pl-5 last:mb-0')} {...dropNode(props)} />,
  ol: (props) => <ol className={cn(CHAT_TEXT_CLASS, 'mb-1 list-decimal pl-5 last:mb-0')} {...dropNode(props)} />,
  li: (props) => <li className={CHAT_TEXT_CLASS} {...dropNode(props)} />,
  strong: (props) => <strong className={cn(CHAT_TEXT_CLASS, 'font-bold')} {...dropNode(props)} />,
};

// Design Notes: "Reveal rate ... a reasonable default, not a tuned UX value,
// same disclaimer style as resilience.ts's retry/timeout constants."
const TYPING_REVEAL_TICK_MS = 20;
const TYPING_REVEAL_TOTAL_TICKS = 60;

/**
 * Review follow-up (AC5/AD-32): the typing reveal renders its growing prefix
 * through the same `react-markdown` pipeline as the complete text, not plain
 * text swapped for Markdown at the end -- so the user never sees a raw,
 * not-yet-closed marker (`**`, a bare heading `#`, a bare list `1.`). Since
 * the reveal is always a strictly growing prefix of the final, well-formed
 * text, any such marker it finds unclosed *must* be the one currently being
 * typed -- trimming it (and everything after it) back to the last safe point
 * is enough; the next tick's longer prefix naturally includes the close and
 * stops trimming it. Deliberately hides the *whole* still-ambiguous span
 * (marker plus whatever follows it) rather than showing its inner text
 * unstyled then re-rendering it bold/heading once closed -- simpler, and the
 * hidden span is only ever one ~20ms tick wide.
 */
function hideIncompleteMarkdownTail(text: string): string {
  return trimBareListMarker(trimBareHeadingMarker(trimUnclosedEmphasis(text)));
}

// Trailing unclosed `**` (bold) or single `*`: scans forward tracking the
// position where each marker most recently toggled open; whichever is still
// open at the end of the string is the one currently being typed. A plain
// 2-asterisk-or-1 token scan is enough here (no italic/strikethrough support
// to worry about, AD-32's own bold-only scope) -- not a full CommonMark
// delimiter-run implementation.
function trimUnclosedEmphasis(text: string): string {
  let openStrongAt: number | null = null;
  let openEmAt: number | null = null;

  for (let i = 0; i < text.length; ) {
    if (text[i] === '*' && text[i + 1] === '*') {
      openStrongAt = openStrongAt === null ? i : null;
      i += 2;
    } else if (text[i] === '*') {
      openEmAt = openEmAt === null ? i : null;
      i += 1;
    } else {
      i += 1;
    }
  }

  const openAt = [openStrongAt, openEmAt].filter((index): index is number => index !== null);
  return openAt.length === 0 ? text : text.slice(0, Math.min(...openAt));
}

// Trailing bare ATX heading marker (`#`..`######`, optional trailing
// whitespace, no heading text yet) on the text's last line only -- an
// already-complete earlier line is never touched.
function trimBareHeadingMarker(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1;
  return /^#{1,6}[ \t]*$/.test(text.slice(lineStart)) ? text.slice(0, lineStart) : text;
}

// Trailing bare ordered-list marker (`1.`/`1)`, optional trailing
// whitespace, no item text yet) on the text's last line only.
function trimBareListMarker(text: string): string {
  const lineStart = text.lastIndexOf('\n') + 1;
  return /^\d+[.)][ \t]*$/.test(text.slice(lineStart)) ? text.slice(0, lineStart) : text;
}

export interface ChatMessageProps {
  message: ChatMessageType;
  /**
   * Design Notes: "Only the just-arrived message animates" — `ChatThread`
   * passes `true` only for the message id it just received via the SSE
   * `result` event, never for history reads.
   */
  animate?: boolean;
}

/**
 * Review follow-up: a `'notice'` (jailbreak rejection / unsafe-output
 * fallback) or `'error'` (model-failure fallback) renders through the exact
 * same bubble as a normal `'message'` reply — same background, border,
 * radius, alignment, padding, and `CHAT_TEXT_CLASS` — no separate grey-pill
 * style. The distinction stays in the data model (`message.kind`) and in the
 * bubble's `role` (`'alert'` for an error, `'status'` for a notice, no role
 * for a normal message) — never a different visual treatment.
 */
export function ChatMessage({ message, animate = false }: ChatMessageProps) {
  const shouldAnimate = animate && message.kind === 'message';
  // Review loop 2 (edge-case-hunter): iterate by Unicode code point, not
  // UTF-16 code unit — `content.slice(n)` can split an astral-plane
  // character's (e.g. an emoji) surrogate pair across a reveal tick,
  // rendering a broken glyph for one tick. `Array.from` iterates by code
  // point, so slicing this array never splits one in half.
  const codePoints = React.useMemo(() => Array.from(message.content), [message.content]);
  const [revealedLength, setRevealedLength] = React.useState(shouldAnimate ? 0 : codePoints.length);

  // This effect only ever advances `revealedLength`; `hideIncompleteMarkdownTail`
  // (applied at render time below) is what keeps every intermediate prefix
  // safe to feed straight into `react-markdown`.
  React.useEffect(() => {
    if (!shouldAnimate) {
      setRevealedLength(codePoints.length);
      return undefined;
    }

    setRevealedLength(0);
    const charsPerTick = Math.max(1, Math.ceil(codePoints.length / TYPING_REVEAL_TOTAL_TICKS));
    const intervalId = setInterval(() => {
      setRevealedLength((previous) => {
        const next = previous + charsPerTick;
        if (next >= codePoints.length) {
          clearInterval(intervalId);
          return codePoints.length;
        }
        return next;
      });
    }, TYPING_REVEAL_TICK_MS);

    return () => clearInterval(intervalId);
  }, [message.id, codePoints, shouldAnimate]);

  const isUser = message.role === 'user';
  const isRevealing = shouldAnimate && revealedLength < codePoints.length;
  // Review follow-up: the semantic distinction stays non-visual — role only,
  // never a different bubble style.
  const role = message.kind === 'error' ? 'alert' : message.kind === 'notice' ? 'status' : undefined;

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        role={role}
        className={cn(
          'max-w-[80%] rounded-xl border border-border px-4 py-2',
          CHAT_TEXT_CLASS,
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground',
        )}
      >
        {isUser ? (
          // AC7's own Given clause scopes Markdown rendering to "an agent
          // response containing Markdown" — a user-typed message renders as
          // plain text, so literal `**`/`#` characters the user typed are
          // never reinterpreted as formatting in their own bubble. User
          // messages are never animated in practice (`ChatThread` only marks
          // the assistant's own SSE `result` id as `animate`), so the full
          // text always shows immediately here regardless.
          message.content
        ) : (
          <ReactMarkdown allowedElements={MARKDOWN_ALLOWED_ELEMENTS} unwrapDisallowed components={markdownComponents}>
            {isRevealing ? hideIncompleteMarkdownTail(codePoints.slice(0, revealedLength).join('')) : message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
