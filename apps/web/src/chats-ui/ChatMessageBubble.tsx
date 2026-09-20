import { useEffect, useState } from 'react';

import type { ConversationMessage, ConversationMessageAttachment } from '../auth-gateway.js';
import { formatAttachmentSize } from './chat-attachments.js';
import { formatMessageTime, initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

/** Loads one attachment exactly once and hands the component a revocable object URL. */
function useAttachmentObjectUrl(
  conversationId: string,
  mediaId: string,
  loadMedia: (conversationId: string, mediaId: string) => Promise<Blob>,
): { readonly url?: string; readonly failed: boolean } {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void loadMedia(conversationId, mediaId).then(
      (blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, mediaId, loadMedia]);

  return { ...(url ? { url } : {}), failed };
}

function AttachmentImage({
  conversationId,
  attachment,
  loadMedia,
}: {
  readonly conversationId: string;
  readonly attachment: ConversationMessageAttachment;
  readonly loadMedia: (conversationId: string, mediaId: string) => Promise<Blob>;
}): React.JSX.Element {
  const { url, failed } = useAttachmentObjectUrl(conversationId, attachment.mediaId, loadMedia);

  if (failed) return <span className={styles.attachmentUnavailable}>Изображение недоступно</span>;
  if (!url) {
    return (
      <span className={styles.attachmentPending} aria-live="polite">
        Загружаем изображение…
      </span>
    );
  }
  return <img src={url} alt={attachment.fileName} loading="lazy" />;
}

function AttachmentFile({
  conversationId,
  attachment,
  loadMedia,
}: {
  readonly conversationId: string;
  readonly attachment: ConversationMessageAttachment;
  readonly loadMedia: (conversationId: string, mediaId: string) => Promise<Blob>;
}): React.JSX.Element {
  const { url, failed } = useAttachmentObjectUrl(conversationId, attachment.mediaId, loadMedia);
  const body = (
    <>
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
      <span className={styles.attachmentFileAction}>
        {failed ? 'Недоступно' : url ? 'Скачать' : 'Готовим…'}
      </span>
    </>
  );

  if (!url) return <span className={styles.attachmentFileCard}>{body}</span>;
  return (
    <a
      className={styles.attachmentFileCard}
      href={url}
      download={attachment.fileName}
      aria-label={`Скачать файл ${attachment.fileName}`}
    >
      {body}
    </a>
  );
}

interface ChatMessageBubbleProps {
  readonly message: ConversationMessage;
  readonly own: boolean;
  readonly showSender: boolean;
  readonly continuesGroup?: boolean;
  readonly endsGroup?: boolean;
  /**
   * Authorized attachment loader. The route needs the bearer token and answers 302 to a short-lived
   * signed URL, so a browser cannot use it directly as an `<img src>`.
   */
  readonly loadMedia: (conversationId: string, mediaId: string) => Promise<Blob>;
}

export function ChatMessageBubble({
  message,
  own,
  showSender,
  continuesGroup = false,
  endsGroup = true,
  loadMedia,
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
                <AttachmentImage
                  conversationId={message.conversationId}
                  attachment={attachment}
                  loadMedia={loadMedia}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {files.length > 0 ? (
          <ul className={styles.attachmentFiles} aria-label="Файлы в сообщении">
            {files.map((attachment) => (
              <li key={attachment.mediaId}>
                <AttachmentFile
                  conversationId={message.conversationId}
                  attachment={attachment}
                  loadMedia={loadMedia}
                />
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
