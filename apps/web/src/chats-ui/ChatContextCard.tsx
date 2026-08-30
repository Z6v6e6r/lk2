import type { GameConversationSummary } from '../auth-gateway.js';
import { safeGameHref } from './chat-format.js';
import styles from './ChatsUi.module.css';

export function ChatContextCard({
  conversation,
}: {
  readonly conversation: GameConversationSummary;
}): React.JSX.Element {
  const href = safeGameHref(conversation.contextId);

  return (
    <aside className={styles.contextCard} aria-label="Контекст игры">
      <span className={styles.contextLabel}>Игра</span>
      <strong>{conversation.title}</strong>
      {href ? <a href={href}>Открыть игру</a> : null}
    </aside>
  );
}
