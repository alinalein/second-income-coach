import { useTranslation } from 'react-i18next';
import { formatMicroMoney, type ChatMessage as ChatMessageType } from '@app/shared';
import { LOCALE_BY_LANGUAGE } from '../lib/utils';

/**
 * Story 5.2: the `ChatMessage` footer extension point's cost line (Story
 * 3.1's `ChatMessageFooterItem` shape — `{ message }` only). Renders
 * nothing for a message with no `cost` — every user message, and any
 * assistant reply from a direct-path flow that never went through `chat.
 * ts`/`plan-chat.ts` (Boundary).
 *
 * AD-21: "a model with no registered price shows token count only, never a
 * guessed or zero cost" — `cost.amount === null` renders just the token
 * counts, with no money figure (never a `$0`/`€0`) alongside them.
 */
export function MessageCost({ message }: { message: ChatMessageType }) {
  const { t, i18n } = useTranslation('chat');
  const cost = message.cost;
  if (!cost) return null;

  const locale = LOCALE_BY_LANGUAGE[i18n.language] ?? 'en-US';

  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{t('cost.tokens', { input: cost.inputTokens, output: cost.outputTokens })}</span>
      {cost.amount ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{formatMicroMoney(cost.amount, locale)}</span>
          {cost.isEstimate ? <span aria-label={t('cost.estimateBadgeFull')}>{t('cost.estimateBadge')}</span> : null}
        </>
      ) : null}
    </span>
  );
}
