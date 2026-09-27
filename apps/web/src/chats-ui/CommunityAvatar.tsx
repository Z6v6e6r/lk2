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
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.communityAvatar} aria-hidden="true">
      <span className={styles.communityAvatarInitials}>{initials(title)}</span>
      {logoUrl && !failed ? (
        <img
          className={styles.communityAvatarImage}
          src={logoUrl}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
