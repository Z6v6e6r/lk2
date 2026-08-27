import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';

export interface ParticipantAvatarStackItem {
  readonly key: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  readonly level?: string | null;
  readonly levelValue?: number | null;
  readonly href?: string;
}

export interface ParticipantAvatarStackProps {
  readonly participants: readonly ParticipantAvatarStackItem[];
  readonly capacity?: number;
  readonly ariaLabel?: string;
  readonly participantActionLabel?: string;
  readonly showLevelRing?: boolean;
  readonly onOpenSlotClick?: (slotIndex: number) => void;
  readonly onParticipantClick?: (
    participant: ParticipantAvatarStackItem,
    participantIndex: number,
  ) => void;
}

function participantAccent(level: string | null | undefined): string {
  if (level?.startsWith('D')) return '#f0705f';
  if (level?.startsWith('C')) return '#f0925f';
  if (level?.startsWith('B')) return '#697ee8';
  return '#8766eb';
}

function participantLevelProgress(levelValue: number | null | undefined): number {
  if (levelValue === null || levelValue === undefined) return 0;
  const fractionalProgress = levelValue - Math.floor(levelValue);
  return Math.round(fractionalProgress * 100);
}

function OpenSlotIcon(): React.JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="46.5"
        height="46.5"
        rx="23.25"
        fill="#F1F1F1"
        stroke="#FAFAFA"
        strokeWidth="1.5"
      />
      <path
        d="M22.6667 24.4444H18.6667C18.4212 24.4444 18.2222 24.2454 18.2222 23.9999C18.2222 23.7545 18.4212 23.5555 18.6667 23.5555H22.6667V24.4444Z"
        fill="#888889"
      />
      <path
        d="M29.3333 23.5555C29.5788 23.5555 29.7778 23.7545 29.7778 23.9999C29.7778 24.2454 29.5788 24.4444 29.3333 24.4444H23.5556V23.5555H29.3333Z"
        fill="#888889"
      />
      <path
        d="M24.4445 29.3333C24.4445 29.5788 24.2455 29.7778 24.0001 29.7778C23.7546 29.7778 23.5556 29.5788 23.5556 29.3333V23.5555H24.4445V29.3333Z"
        fill="#888889"
      />
      <path
        d="M24.0001 18.2222C24.2455 18.2222 24.4445 18.4212 24.4445 18.6667V22.4444H23.5556V18.6667C23.5556 18.4212 23.7546 18.2222 24.0001 18.2222Z"
        fill="#888889"
      />
    </svg>
  );
}

export function ParticipantAvatarStack({
  participants,
  capacity = 4,
  ariaLabel = 'Участники',
  participantActionLabel = 'Управлять',
  showLevelRing = true,
  onOpenSlotClick,
  onParticipantClick,
}: ParticipantAvatarStackProps): React.JSX.Element {
  const visibleCapacity = Math.max(0, Math.min(4, Math.floor(capacity)));
  const visibleParticipants = participants.slice(0, visibleCapacity);
  const openSlots = Math.max(0, visibleCapacity - visibleParticipants.length);

  return (
    <span className="participant-avatar-stack" aria-label={ariaLabel}>
      {visibleParticipants.map((participant, index) => {
        const accessibleName = `${participant.displayName}${participant.level ? ` · ${participant.level}` : ''}`;
        const avatar = (
          <PlayerLevelAvatar
            alt={participant.displayName}
            {...(participant.level ? {} : { accessibleLabel: participant.displayName })}
            accentColor={participantAccent(participant.level)}
            level={participant.level ?? ''}
            progress={participantLevelProgress(participant.levelValue)}
            size={48}
            src={participant.avatarUrl ?? null}
            fallbackSeed={participant.key}
            showLevelRing={showLevelRing}
            stackIndex={index}
            variant="participant"
          />
        );
        return onParticipantClick ? (
          <button
            className="participant-avatar-stack__item"
            type="button"
            key={participant.key}
            title={accessibleName}
            aria-label={`${participantActionLabel} ${participant.displayName}`}
            onClick={() => onParticipantClick(participant, index)}
          >
            {avatar}
          </button>
        ) : participant.href ? (
          <a
            className="participant-avatar-stack__item"
            href={participant.href}
            key={participant.key}
            title={accessibleName}
            aria-label={accessibleName}
          >
            {avatar}
          </a>
        ) : (
          <span
            className="participant-avatar-stack__item"
            key={participant.key}
            title={accessibleName}
          >
            {avatar}
          </span>
        );
      })}
      {Array.from({ length: openSlots }, (_, index) =>
        onOpenSlotClick ? (
          <button
            className="participant-avatar-stack__open-slot"
            key={`open-slot-${index}`}
            type="button"
            aria-label={`${ariaLabel}: свободное место ${index + 1}`}
            onClick={() => onOpenSlotClick(index)}
          >
            <OpenSlotIcon />
          </button>
        ) : (
          <span
            className="participant-avatar-stack__open-slot"
            key={`open-slot-${index}`}
            aria-label="Свободное место"
          >
            <OpenSlotIcon />
          </span>
        ),
      )}
    </span>
  );
}
