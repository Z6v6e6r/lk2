import padlHubLogoUrl from '../assets/padlhub-logo.svg';
import { ChatAvatar } from '../chats-ui/ChatAvatar.js';
import { initials } from '../chats-ui/chat-format.js';
import type { ConversationSummary } from '../auth-gateway.js';
import type { NotificationGroup, NotificationItem } from './notification-format.js';
import { formatNotificationTime, notificationGroupPresentation } from './notification-format.js';
import styles from './NotificationsUi.module.css';

interface NotificationListItemProps {
  readonly group: NotificationGroup;
  readonly conversation?: ConversationSummary | undefined;
  readonly onOpen: (item: NotificationItem, href: string, navigate: boolean) => void;
}

const TONE_CLASS: Readonly<Record<'accent' | 'warm' | 'neutral', string | undefined>> = {
  accent: styles.toneAccent,
  warm: styles.toneWarm,
  neutral: styles.toneNeutral,
};

export function NotificationListItem({
  group,
  conversation,
  onOpen,
}: NotificationListItemProps): React.JSX.Element | null {
  const latest = group.items[0];
  if (!latest) return null;
  const presentation = notificationGroupPresentation(group, conversation);
  const marker =
    presentation.kind === 'conversation' && !presentation.markerKind
      ? initials(presentation.title)
      : presentation.marker;
  const directConversation =
    presentation.kind === 'conversation' && conversation?.kind === 'DIRECT'
      ? conversation
      : undefined;

  return (
    <li className={styles.listItem}>
      <a
        className={presentation.unread ? styles.unreadItem : styles.readItem}
        href={presentation.href}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            onOpen(latest, presentation.href, false);
            return;
          }
          event.preventDefault();
          onOpen(latest, presentation.href, true);
        }}
      >
        <span
          className={`${styles.categoryMarker} ${TONE_CLASS[presentation.tone] ?? ''}`}
          aria-hidden="true"
        >
          {directConversation ? (
            <ChatAvatar
              isGame={false}
              title={presentation.title}
              photoUrl={directConversation.participant.avatarUrl}
              level={directConversation.participant.level}
              levelValue={directConversation.participant.levelValue}
              fallbackSeed={directConversation.participant.userId}
              size={48}
              className={styles.notificationAvatar}
            />
          ) : presentation.markerKind === 'brand' ? (
            <img className={styles.brandMarkerLogo} src={padlHubLogoUrl} alt="" />
          ) : (
            marker
          )}
        </span>
        <span className={styles.itemCopy}>
          <span className={styles.itemTitle}>{presentation.title}</span>
          <span className={styles.itemSubtitle}>{presentation.meta}</span>
          <span className={styles.itemBody}>{presentation.preview}</span>
          <time dateTime={presentation.createdAt}>
            {formatNotificationTime(presentation.createdAt)}
          </time>
        </span>
        <span className={styles.itemSide}>
          {presentation.badge ? (
            <span
              className={styles.itemBadge}
              aria-label={`Непрочитанных событий: ${presentation.badge}`}
            >
              {presentation.badge}
            </span>
          ) : presentation.unread ? (
            <i aria-label="Непрочитанное уведомление" />
          ) : null}
        </span>
      </a>
    </li>
  );
}
