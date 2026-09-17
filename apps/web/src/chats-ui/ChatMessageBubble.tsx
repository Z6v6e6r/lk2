import type { ConversationMessage } from '../auth-gateway.js';
import { formatMessageTime, initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatMessageBubbleProps {
  readonly message: ConversationMessage;
  readonly own: boolean;
  readonly showSender: boolean;
  readonly continuesGroup?: boolean;
  readonly endsGroup?: boolean;
}

export function ChatMessageBubble({
  message,
  own,
  showSender,
  continuesGroup = false,
  endsGroup = true,
}: ChatMessageBubbleProps): React.JSX.Element {
  return (
    <li
      className={`${styles.messageRow} ${own ? styles.ownMessageRow : ''} ${continuesGroup ? styles.continuedMessageRow : ''}`}
    >
      {!own ? (
        <span
          className={`${styles.senderAvatar} ${!endsGroup ? styles.hiddenAvatar : ''}`}
          aria-hidden="true"
        >
          {initials(message.sender.displayName)}
        </span>
      ) : null}
      <article
        className={`${styles.messageBubble} ${own ? styles.ownMessageBubble : ''} ${endsGroup ? styles.messageTail : ''}`}
      >
        <span className="sr-only">Отправитель: {own ? 'Вы' : message.sender.displayName}</span>
        {showSender && !own && !continuesGroup ? (
          <strong aria-hidden="true">{message.sender.displayName}</strong>
        ) : null}
        <p>{message.body}</p>
        <footer className={endsGroup ? styles.messageMeta : 'sr-only'}>
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {own ? <span aria-label="Отправлено">✓</span> : null}
        </footer>
      </article>
    </li>
  );
}
