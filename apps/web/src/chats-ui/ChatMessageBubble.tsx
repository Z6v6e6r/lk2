import type { ConversationMessage } from '../auth-gateway.js';
import { formatMessageTime } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatMessageBubbleProps {
  readonly message: ConversationMessage;
  readonly own: boolean;
  readonly showSender: boolean;
}

export function ChatMessageBubble({
  message,
  own,
  showSender,
}: ChatMessageBubbleProps): React.JSX.Element {
  return (
    <li className={`${styles.messageRow} ${own ? styles.ownMessageRow : ''}`}>
      <article className={`${styles.messageBubble} ${own ? styles.ownMessageBubble : ''}`}>
        <span className="sr-only">Отправитель: {own ? 'Вы' : message.sender.displayName}</span>
        {showSender && !own ? (
          <strong aria-hidden="true">{message.sender.displayName}</strong>
        ) : null}
        <p>{message.body}</p>
        <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
        {own ? <span>Отправлено</span> : null}
      </article>
    </li>
  );
}
