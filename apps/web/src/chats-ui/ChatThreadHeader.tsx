import { ChatIcon } from '../HomeDashboardPage.js';
import type { ConversationSummary } from '../auth-gateway.js';
import { conversationTitle, initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatThreadHeaderProps {
  readonly conversation: ConversationSummary | undefined;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly connectionStatus?: string | null | undefined;
}

export function ChatThreadHeader({
  conversation,
  busy,
  onRefresh,
  connectionStatus,
}: ChatThreadHeaderProps): React.JSX.Element {
  const title = conversation ? conversationTitle(conversation) : 'Диалог';
  const isGame = conversation?.kind === 'GAME';

  return (
    <header className={styles.threadHeader}>
      <a className={styles.backLink} href="/chats" aria-label="Назад к чатам">
        <span aria-hidden="true">←</span>
      </a>
      <span className={`${styles.avatar} ${isGame ? styles.gameAvatar : ''}`} aria-hidden="true">
        {isGame ? <ChatIcon /> : initials(title)}
      </span>
      <span className={styles.threadHeading}>
        <strong>{title}</strong>
        <small>{isGame ? 'Чат игры' : 'Личный чат'}</small>
        {connectionStatus ? <span role="status">{connectionStatus}</span> : null}
      </span>
      <button type="button" className={styles.refreshButton} disabled={busy} onClick={onRefresh}>
        {busy ? 'Обновляем…' : 'Обновить'}
      </button>
    </header>
  );
}
