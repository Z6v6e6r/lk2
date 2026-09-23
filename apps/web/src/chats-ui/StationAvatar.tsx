import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import { stationLogoUrl } from './station-avatar.js';
import styles from './ChatsUi.module.css';

interface StationAvatarProps {
  readonly title: string;
}

/**
 * A station destination is not a person: it keeps the squared-off logo frame the chat list used
 * before the round participant avatar, with the station artwork filling it. A station without
 * artwork keeps the same frame and falls back to the category marker, so the row never borrows a
 * neighbour's logo or falls back to a level ring it does not have.
 */
export function StationAvatar({ title }: StationAvatarProps): React.JSX.Element {
  const logoUrl = stationLogoUrl(title);
  return (
    <span className={styles.stationAvatar} aria-hidden="true">
      {logoUrl ? (
        <img className={styles.stationAvatarImage} src={logoUrl} alt="" loading="lazy" />
      ) : (
        <ChatCategoryIcon name="STATION" />
      )}
    </span>
  );
}
