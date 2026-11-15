import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  chatHistoryResponseSchema,
  sendMessageResponseSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessage as ChatMessageType,
} from '@app/shared';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { ChatMessage } from './ChatMessage';

function makeLocalMessage(role: ChatMessageType['role'], kind: ChatMessageType['kind'], content: string): ChatMessageType {
  return {
    id: `local-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    role,
    kind,
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * AC: "the shared `ChatThread`/`ChatMessage` component ... not a one-off,
 * page-specific widget" — reads the signed-in user's history back from
 * `GET /api/chat/messages` (the checkpointer's own thread state) and sends
 * new messages via `POST /api/chat/messages`, standard request/response only
 * (AD-19: no streaming).
 */
export function ChatThread() {
  const { t } = useTranslation('chat');
  const [messages, setMessages] = React.useState<ChatMessageType[]>([]);
  const [historyLoaded, setHistoryLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/chat/messages', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body: unknown = await res.json();
        const result = chatHistoryResponseSchema.safeParse(body);
        if (result.success) setMessages(result.data.messages);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || sending) return;

      setMessages((prev) => [...prev, makeLocalMessage('user', 'message', content)]);
      setDraft('');
      setSending(true);

      fetch('/api/chat/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
        .then(async (res) => {
          const body: unknown = await res.json();
          const result = sendMessageResponseSchema.safeParse(body);
          setMessages((prev) => [
            ...prev,
            result.success
              ? result.data.message
              : makeLocalMessage('assistant', 'error', t('error.modelFailure')),
          ]);
        })
        .catch(() => {
          setMessages((prev) => [...prev, makeLocalMessage('assistant', 'error', t('error.modelFailure'))]);
        })
        .finally(() => setSending(false));
    },
    [draft, sending, t],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!historyLoaded ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          messages.map((message) => <ChatMessage key={message.id} message={message} />)
        )}
      </CardContent>
      <CardFooter>
        <form onSubmit={handleSubmit} className="flex w-full gap-2">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('placeholder')}
            maxLength={CHAT_MESSAGE_MAX_LENGTH}
            disabled={sending}
            aria-label={t('messageAriaLabel')}
            className="h-10 flex-1 rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <Button type="submit" disabled={sending || !draft.trim()}>
            {t('sendButton')}
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
}
