import { brandLogoUrl } from './brand-logo.js';
import { type ExternalChatDestination } from './external-chats.js';
import styles from './ChatsUi.module.css';

/**
 * One outbound channel rendered exactly like a conversation row — same avatar slot, title, preview
 * and meta column — so the station block keeps a single visual rhythm. The external destination is
 * stated by the title, the owner's official logo and the outbound glyph instead of a different row
 * shape.
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
          <img
            className={styles.externalAvatarImage}
            src={brandLogoUrl(destination.brand)}
            alt=""
            loading="lazy"
          />
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
