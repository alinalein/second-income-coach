import type { ChatMessage as ChatMessageType } from '@app/shared';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';

/**
 * Code Map: "message list, text input, `'notice'`/`'error'` kinds styled
 * distinctly from `'message'` bubbles". A `'notice'` (jailbreak rejection /
 * unsafe-output fallback) or `'error'` (model-failure fallback) renders as a
 * neutral badge-style banner — the same pattern `App.tsx`'s sign-in error
 * already uses (`<Badge variant="muted" role="alert">`) — rather than a
 * normal chat bubble.
 */
export function ChatMessage({ message }: { message: ChatMessageType }) {
  if (message.kind !== 'message') {
    return (
      <Badge variant="muted" role={message.kind === 'error' ? 'alert' : 'status'} className="block w-fit font-normal">
        {message.content}
      </Badge>
    );
  }

  const isUser = message.role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-xl border border-border px-4 py-2 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
