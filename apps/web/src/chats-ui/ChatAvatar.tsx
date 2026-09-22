import { PlayerLevelAvatar } from '../PlayerLevelAvatar.js';
import { ChatCategoryIcon } from './ChatCategoryIcon.js';
import styles from './ChatsUi.module.css';

interface ChatAvatarProps {
  readonly isGame: boolean;
  readonly title: string;
  readonly photoUrl?: string | null | undefined;
  readonly level?: string | null | undefined;
  readonly levelValue?: number | null | undefined;
  readonly fallbackSeed?: string | null | undefined;
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

function levelProgress(levelValue: number | null | undefined): number {
  if (levelValue === null || levelValue === undefined || !Number.isFinite(levelValue)) return 0;
  return Math.round((levelValue - Math.floor(levelValue)) * 100);
}

function levelAccent(level: string | null | undefined): string {
  if (level?.startsWith('D')) return '#f0705f';
  if (level?.startsWith('C')) return '#f0925f';
  if (level?.startsWith('B')) return '#697ee8';
  return '#8766eb';
}

/**
 * One avatar for a chat list row, message sender, notification row, or chat thread header. Direct
 * participants use the shared circular level avatar; game and other group destinations keep their
 * category marker.
 */
export function ChatAvatar({
  isGame,
  title,
  photoUrl,
  level,
  levelValue,
  fallbackSeed,
  size = 44,
  className,
}: ChatAvatarProps): React.JSX.Element {
  const url = isGame ? undefined : photoUrl;
  const frameStyle = {
    width: `${size}px`,
    height: `${(size * 51) / 48}px`,
    flexBasis: `${size}px`,
  };

  return (
    <span
      className={`${styles.avatar} ${isGame ? styles.gameAvatar : styles.levelAvatarFrame} ${className ?? ''}`}
      style={isGame ? undefined : frameStyle}
      aria-hidden="true"
    >
      {isGame ? (
        <ChatCategoryIcon name="GAME" />
      ) : (
        <PlayerLevelAvatar
          alt={title}
          accessibleLabel={title}
          className={styles.levelAvatar ?? ''}
          level={level ?? ''}
          progress={levelProgress(levelValue)}
          size={size}
          src={url ?? null}
          fallbackSeed={fallbackSeed ?? title}
          accentColor={levelAccent(level)}
          showLevelRing
          variant="participant"
        />
      )}
    </span>
  );
}
