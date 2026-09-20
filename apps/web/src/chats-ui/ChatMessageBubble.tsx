import type { ConversationMessage } from '../auth-gateway.js';
import { formatAttachmentSize } from './chat-attachments.js';
import { formatMessageTime, initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatMessageBubbleProps {
  readonly message: ConversationMessage;
  readonly own: boolean;
  readonly showSender: boolean;
  readonly continuesGroup?: boolean;
  readonly endsGroup?: boolean;
  /** Same-origin `/media/<mediaId>/content` URL; the API answers 302 to a signed URL. */
  readonly resolveMediaContentUrl: (conversationId: string, mediaId: string) => string;
}

export function ChatMessageBubble({
  message,
  own,
  showSender,
  continuesGroup = false,
  endsGroup = true,
  resolveMediaContentUrl,
}: ChatMessageBubbleProps): React.JSX.Element {
  const attachments = message.attachments ?? [];
  const images = attachments.filter((attachment) => attachment.mediaType === 'IMAGE');
  const files = attachments.filter((attachment) => attachment.mediaType !== 'IMAGE');

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
        className={`${styles.messageBubble} ${own ? styles.ownMessageBubble : ''} ${endsGroup ? styles.messageTail : ''} ${attachments.length > 0 ? styles.hasAttachmentsBubble : ''}`}
      >
        <span className="sr-only">Отправитель: {own ? 'Вы' : message.sender.displayName}</span>
        {showSender && !own && !continuesGroup ? (
          <strong aria-hidden="true">{message.sender.displayName}</strong>
        ) : null}
        {images.length > 0 ? (
          <ul
            className={`${styles.attachmentImages} ${images.length === 1 ? styles.singleAttachmentImage : ''}`}
            aria-label="Изображения в сообщении"
          >
            {images.map((attachment) => (
              <li key={attachment.mediaId}>
                <img
                  src={resolveMediaContentUrl(message.conversationId, attachment.mediaId)}
                  alt={attachment.fileName}
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
        ) : null}
        {files.length > 0 ? (
          <ul className={styles.attachmentFiles} aria-label="Файлы в сообщении">
            {files.map((attachment) => (
              <li key={attachment.mediaId}>
                <a
                  className={styles.attachmentFileCard}
                  href={resolveMediaContentUrl(message.conversationId, attachment.mediaId)}
                  download={attachment.fileName}
                >
                  <span className={styles.attachmentFileIcon} aria-hidden="true">
                    📄
                  </span>
                  <span className={styles.attachmentFileBody}>
                    <span className={styles.attachmentFileName} title={attachment.fileName}>
                      {attachment.fileName}
                    </span>
                    <span className={styles.attachmentFileMeta}>
                      {formatAttachmentSize(attachment.byteSize)}
                    </span>
                  </span>
                  <span className={styles.attachmentFileAction}>Скачать</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {message.body ? <p>{message.body}</p> : null}
        <footer className={endsGroup ? styles.messageMeta : 'sr-only'}>
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {own ? <span aria-label="Отправлено">✓</span> : null}
        </footer>
      </article>
    </li>
  );
}
