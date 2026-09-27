import { useState } from 'react';

import { initials } from './chat-format.js';
import styles from './ChatsUi.module.css';

/**
 * A community destination is a group, not a person, so it keeps the squared-off logo frame the
 * station rows use instead of the round participant avatar. A community without artwork keeps the
 * same frame and falls back to its initials; artwork that fails to load hides itself, because a
 * broken-image marker inside a 44px frame is worse than the initials it was covering.
 */
export function CommunityAvatar({
  title,
  logoUrl,
}: {
  readonly title: string;
  readonly logoUrl: string | null | undefined;
}): React.JSX.Element {
  // The failure belongs to one artwork, not to this component instance: the list and the thread
  // header reuse the avatar across communities, so a broken logo must not hide the next one.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArtwork = Boolean(logoUrl) && failedUrl !== logoUrl;
  return (
    <span className={styles.communityAvatar} aria-hidden="true">
      <span className={styles.communityAvatarInitials}>{initials(title)}</span>
      {showArtwork && logoUrl ? (
        <img
          className={styles.communityAvatarImage}
          src={logoUrl}
          alt=""
          loading="lazy"
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : null}
    </span>
  );
}
