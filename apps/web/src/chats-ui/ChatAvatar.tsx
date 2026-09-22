import { useState } from 'react';

import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import { initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

interface ChatAvatarProps {
  readonly isGame: boolean;
  readonly title: string;
  readonly photoUrl?: string | null | undefined;
}

/**
 * One avatar for a chat list row and a chat thread header. A stored profile photo replaces the
 * generated initials, and a failed or expired delivery URL falls back to them again instead of
 * leaving a broken image in the conversation list. Tracking the failed URL (not a boolean) lets a
 * refreshed delivery URL retry without an effect.
 */
export function ChatAvatar({ isGame, title, photoUrl }: ChatAvatarProps): React.JSX.Element {
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);
  const url = isGame ? undefined : photoUrl;
  const showPhoto = Boolean(url) && url !== failedPhotoUrl;

  return (
    <span className={`${styles.avatar} ${isGame ? styles.gameAvatar : ''}`} aria-hidden="true">
      {isGame ? (
        <ChatCategoryIcon name="GAME" />
      ) : showPhoto ? (
        <img
          className={styles.avatarPhoto}
          src={url ?? undefined}
          alt=""
          loading="lazy"
          onError={() => setFailedPhotoUrl(url ?? null)}
        />
      ) : (
        initials(title)
      )}
    </span>
  );
}
