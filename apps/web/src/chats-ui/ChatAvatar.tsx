import { ParticipantAvatarStack } from '../ParticipantAvatarStack.js';
import { PlayerLevelAvatar } from '../PlayerLevelAvatar.js';
import type { GameConversationParticipant } from '../auth-gateway.js';
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
  /** Active game roster; the game avatar shows it instead of the category marker. */
  readonly participants?: readonly GameConversationParticipant[] | undefined;
  /**
   * Doubles the roster circles for the chat list, where the row gives the stack a wider column. The
   * thread header keeps the compact stack, so its 44px slot and the title stay where they are.
   */
  readonly wideStack?: boolean | undefined;
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
 * participants use the shared circular level avatar; a game shows its active roster as a compact
 * avatar stack, exactly like the game card, and falls back to the category marker while the roster
 * is unknown.
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
  participants,
  wideStack = false,
}: ChatAvatarProps): React.JSX.Element {
  const url = isGame ? undefined : photoUrl;
  const frameStyle = {
    width: `${size}px`,
    height: `${(size * 51) / 48}px`,
    flexBasis: `${size}px`,
  };
  const gameRoster = isGame ? (participants ?? []).slice(0, 4) : [];

  return (
    <span
      className={`${styles.avatar} ${
        isGame
          ? gameRoster.length > 0
            ? wideStack
              ? `${styles.gameRosterAvatar} ${styles.gameRosterAvatarWide}`
              : styles.gameRosterAvatar
            : styles.gameAvatar
          : styles.levelAvatarFrame
      } ${className ?? ''}`}
      style={isGame ? undefined : frameStyle}
      aria-hidden="true"
    >
      {isGame ? (
        gameRoster.length > 0 ? (
          <span className={wideStack ? 'chat-game-stack chat-game-stack-wide' : 'chat-game-stack'}>
            <ParticipantAvatarStack
              ariaLabel={`Участники игры ${title}`}
              capacity={gameRoster.length}
              participants={gameRoster.map((participant) => ({
                key: participant.userId,
                displayName: participant.displayName,
                ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
                ...(participant.level ? { level: participant.level } : {}),
                ...(typeof participant.levelValue === 'number'
                  ? { levelValue: participant.levelValue }
                  : {}),
              }))}
            />
          </span>
        ) : (
          <ChatCategoryIcon name="GAME" />
        )
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
