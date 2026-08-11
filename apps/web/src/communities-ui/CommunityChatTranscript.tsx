import styles from './CommunitiesReadOnly.module.css';
import { Avatar } from './CommunityFeedList.js';
import type { CommunityReadOnlyMessage } from './types.js';

export function CommunityChatTranscript({
  messages,
}: {
  readonly messages: readonly CommunityReadOnlyMessage[];
}): React.JSX.Element {
  return (
    <section className={styles.transcript} aria-label="Чат сообщества">
      <div className={styles.chatScroll}>
        <p className={styles.loadPrevious}>Последние сообщения</p>
        {!messages.length ? <p className={styles.empty}>В чате пока нет сообщений.</p> : null}
        {messages.map((message, index) => (
          <article
            key={`${message.sentLabel}:${index}`}
            className={`${styles.message}${message.isCurrentUser ? ` ${styles.messageMine}` : ''}`}
          >
            {!message.isCurrentUser ? (
              <Avatar name={message.author.displayName} src={message.author.avatarUrl} />
            ) : null}
            <div className={styles.bubble}>
              <div className={styles.messageAuthor}>
                {message.isCurrentUser ? 'Вы' : message.author.displayName}
              </div>
              <div className={styles.messageBody}>{message.body}</div>
              <time className={styles.messageTime}>{message.sentLabel}</time>
            </div>
          </article>
        ))}
      </div>
      <form className={styles.composer} aria-label="Сообщение в чат">
        <button type="button" disabled aria-label="Прикрепить файл">
          +
        </button>
        <input disabled aria-label="Сообщение" placeholder="Сообщение" />
        <button type="submit" disabled aria-label="Отправить сообщение">
          ↑
        </button>
      </form>
      <p className={styles.transcriptNote}>Чат доступен только для чтения.</p>
    </section>
  );
}
