import { type ExternalChatDestination } from './external-chats.js';
import styles from './ChatsUi.module.css';

function BrandGlyph({
  brand,
}: {
  readonly brand: ExternalChatDestination['brand'];
}): React.JSX.Element {
  if (brand === 'TELEGRAM') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M21.3 4.3 2.9 11.4c-.9.3-.9 1.5 0 1.8l4.4 1.4 1.6 4.9c.3.8 1.3 1 1.9.4l2.4-2.4 4.4 3.2c.6.5 1.5.1 1.7-.6l3-13.9c.2-.9-.7-1.6-1.5-1.3ZM9.6 14.4l-.4 3.2-1-3.1 8.5-5.9-7.1 5.8Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3c4.9 0 9 3.4 9 7.6 0 4.2-4.1 7.6-9 7.6-.9 0-1.8-.1-2.6-.3L5 20.6c-.5.3-1.1-.1-1-.7l.6-3A7.1 7.1 0 0 1 3 10.6C3 6.4 7.1 3 12 3Zm-3.4 6.2c-.5 0-.9.4-.9.9 0 2.3 2 4.2 4.3 4.2.5 0 .9-.4.9-.9s-.4-.9-.9-.9c-1.4 0-2.5-1.1-2.5-2.4 0-.5-.4-.9-.9-.9Zm6.8 0c-.5 0-.9.4-.9.9 0 .5.4.9.9.9s.9-.4.9-.9-.4-.9-.9-.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * One outbound channel rendered exactly like a conversation row — same avatar slot, title, preview
 * and meta column — so the list keeps a single visual rhythm. The external destination is stated by
 * the title and the outbound glyph instead of a different row shape.
 */
export function ExternalChatListItem({
  destination,
}: {
  readonly destination: ExternalChatDestination;
}): React.JSX.Element {
  return (
    <li className={styles.listItem}>
      <a
        className={styles.listLink}
        href={destination.href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`${destination.title} — открыть во внешнем приложении`}
      >
        <span className={styles.externalAvatar} aria-hidden="true">
          <BrandGlyph brand={destination.brand} />
        </span>
        <span className={styles.listCopy}>
          <span className={styles.listTitle}>{destination.title}</span>
          <span className={styles.listPreview}>{destination.preview}</span>
        </span>
        <span className={styles.listMeta}>
          <span className={styles.externalGlyph} aria-hidden="true">
            ↗
          </span>
        </span>
      </a>
    </li>
  );
}
