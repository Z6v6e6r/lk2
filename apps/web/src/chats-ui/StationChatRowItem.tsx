import { StationAvatar } from './StationAvatar.js';
import { formatConversationTimestamp, formatMessageTime } from './chat-format.js';
import styles from './ChatsUi.module.css';

/**
 * The station list and the unfiltered "Все" tab both address the same dialog, so they share one row
 * shape. The only difference is the meta column: inside the station block every row belongs to the
 * same day-scale list, while in "Все" the row stands next to LK2 conversations and has to read the
 * same way they do ("Вчера", a weekday, a date).
 */
export interface StationChatRowView {
  readonly key: string;
  readonly title: string;
  readonly preview: string;
  readonly hasHistory: boolean;
  readonly updatedAt: string | null;
  readonly selected: boolean;
}

export function StationChatRowItem({
  row,
  relativeTime = false,
  onOpen,
}: {
  readonly row: StationChatRowView;
  /** True in "Все", where the timestamp follows the conversation-list convention. */
  readonly relativeTime?: boolean;
  readonly onOpen: () => void;
}): React.JSX.Element {
  return (
    <li className={styles.listItem}>
      <button
        type="button"
        className={`${styles.listLink} ${styles.stationListButton} ${
          row.selected ? styles.selectedListLink : ''
        }`}
        aria-current={row.selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <StationAvatar title={row.title} />
        <span className={styles.stationListItemBody}>
          <strong>{row.title}</strong>
          <small className={row.hasHistory ? undefined : styles.stationListEmptyPreview}>
            {row.preview}
          </small>
        </span>
        <span className={styles.stationListItemMeta}>
          {row.updatedAt ? (
            <time dateTime={row.updatedAt}>
              {relativeTime
                ? formatConversationTimestamp(row.updatedAt)
                : formatMessageTime(row.updatedAt)}
            </time>
          ) : null}
        </span>
      </button>
    </li>
  );
}
