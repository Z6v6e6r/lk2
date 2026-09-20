import type { ConversationSummary, NotificationInboxPage } from '../auth-gateway.js';
import { conversationTitle } from '../chats-ui/chat-format.js';

export type NotificationItem = NotificationInboxPage['items'][number];
export type NotificationFilter = 'ALL' | 'GAME' | 'MESSAGING' | 'FRIENDSHIP' | 'SYSTEM';

export interface NotificationCategoryPresentation {
  readonly filter: Exclude<NotificationFilter, 'ALL'> | null;
  readonly filterLabel: string | null;
  readonly categoryLabel: string;
  readonly marker: string;
  readonly markerKind?: 'brand';
  readonly tone: 'accent' | 'warm' | 'neutral';
}

const CATEGORY_PRESENTATION: Readonly<Record<string, NotificationCategoryPresentation>> = {
  GAME: {
    filter: 'GAME',
    filterLabel: 'Игры',
    categoryLabel: 'Игра',
    marker: 'И',
    tone: 'accent',
  },
  BOOKING: {
    filter: 'GAME',
    filterLabel: 'Игры',
    categoryLabel: 'Запись',
    marker: 'З',
    tone: 'warm',
  },
  BOOKING_REMINDER: {
    filter: 'GAME',
    filterLabel: 'Игры',
    categoryLabel: 'Напоминание',
    marker: 'Н',
    tone: 'warm',
  },
  MESSAGING: {
    filter: 'MESSAGING',
    filterLabel: 'Чаты',
    categoryLabel: 'Чат',
    marker: 'Ч',
    tone: 'accent',
  },
  FRIENDSHIP: {
    filter: 'FRIENDSHIP',
    filterLabel: 'Друзья',
    categoryLabel: 'Друзья',
    marker: 'Д',
    tone: 'accent',
  },
  ADMIN_MESSAGE: {
    filter: 'SYSTEM',
    filterLabel: 'Системные',
    categoryLabel: 'Системное',
    marker: 'PH',
    markerKind: 'brand',
    tone: 'neutral',
  },
};

const relativeDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});

const NOTIFICATION_DEEP_LINK_ORIGIN = 'https://notifications.invalid';
const ENCODED_CONTROL_WHITESPACE_OR_BACKSLASH = /%(?:0[0-9a-f]|1f|20|5c|7f)/iu;
const CHAT_PATH_PATTERN =
  /^\/chats\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const GAME_PATH_PATTERN =
  /^\/games\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function hasRawControlOrWhitespace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

export function notificationCategory(category: string): NotificationCategoryPresentation {
  return (
    CATEGORY_PRESENTATION[category] ?? {
      filter: null,
      filterLabel: null,
      categoryLabel: 'Событие',
      marker: 'PH',
      tone: 'neutral',
    }
  );
}

export function notificationFilters(items: readonly NotificationItem[]): readonly {
  readonly value: NotificationFilter;
  readonly label: string;
}[] {
  const result: { value: NotificationFilter; label: string }[] = [{ value: 'ALL', label: 'Все' }];
  const added = new Set<NotificationFilter>();
  for (const item of items) {
    const presentation = notificationCategory(item.category);
    if (!presentation.filter || !presentation.filterLabel || added.has(presentation.filter)) {
      continue;
    }
    added.add(presentation.filter);
    result.push({ value: presentation.filter, label: presentation.filterLabel });
  }
  return result;
}

export function notificationMatchesFilter(
  item: NotificationItem,
  filter: NotificationFilter,
): boolean {
  return filter === 'ALL' || notificationCategory(item.category).filter === filter;
}

export function safeNotificationDeepLink(value: string | undefined): string {
  if (
    !value?.startsWith('/') ||
    value.includes('\\') ||
    hasRawControlOrWhitespace(value) ||
    ENCODED_CONTROL_WHITESPACE_OR_BACKSLASH.test(value)
  ) {
    return '/notifications';
  }

  try {
    const parsed = new URL(value, NOTIFICATION_DEEP_LINK_ORIGIN);
    if (parsed.origin !== NOTIFICATION_DEEP_LINK_ORIGIN) return '/notifications';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/notifications';
  }
}

export function formatNotificationTime(value: string, now = new Date()): string {
  const createdAt = new Date(value);
  if (!Number.isFinite(createdAt.getTime())) return '';
  const differenceMs = Math.max(0, now.getTime() - createdAt.getTime());
  const minutes = Math.floor(differenceMs / 60_000);
  if (minutes < 1) return 'Только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Вчера';
  if (days < 7) return `${days} дн. назад`;
  return relativeDateFormatter.format(createdAt).replace('.', '');
}

export function pluralRu(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(Math.trunc(count)) % 100;
  const lastDigit = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * A notification row is one destination, not one event: every event that opens the same chat, the
 * same game card or the same bookings screen collapses into one entry, exactly like a messenger
 * thread. The newest event stays first because the inbox page itself is ordered newest first.
 */
export type NotificationGroupKind = 'conversation' | 'game' | 'bookings' | 'single';

export interface NotificationGroup {
  readonly key: string;
  readonly kind: NotificationGroupKind;
  readonly sourceId?: string;
  readonly items: readonly NotificationItem[];
}

type NotificationSource =
  | { readonly kind: 'conversation'; readonly id: string }
  | { readonly kind: 'game'; readonly id: string }
  | { readonly kind: 'bookings' };

function notificationSource(item: NotificationItem): NotificationSource | undefined {
  const link = safeNotificationDeepLink(item.deepLink);
  const pathname = link.split(/[?#]/u)[0] ?? link;
  const chat = CHAT_PATH_PATTERN.exec(pathname);
  if (chat?.[1]) return { kind: 'conversation', id: chat[1] };
  const game = GAME_PATH_PATTERN.exec(pathname);
  if (game?.[1]) return { kind: 'game', id: game[1] };
  if (pathname === '/bookings') return { kind: 'bookings' };
  return undefined;
}

export function groupNotifications(
  items: readonly NotificationItem[],
): readonly NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    const source = notificationSource(item);
    if (!source) {
      groups.push({ key: `single:${item.id}`, kind: 'single', items: [item] });
      continue;
    }
    const key = source.kind === 'bookings' ? 'bookings' : `${source.kind}:${source.id}`;
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({
        key,
        kind: source.kind,
        ...(source.kind === 'bookings' ? {} : { sourceId: source.id }),
        items: [item],
      });
      continue;
    }
    const group = groups[existing];
    if (!group) continue;
    groups[existing] = { ...group, items: [...group.items, item] };
  }
  return groups;
}

export function notificationGroupMatchesFilter(
  group: NotificationGroup,
  filter: NotificationFilter,
): boolean {
  return group.items.some((item) => notificationMatchesFilter(item, filter));
}

export function notificationGroupsForFilter(
  groups: readonly NotificationGroup[],
  filter: NotificationFilter,
): readonly NotificationGroup[] {
  return filter === 'ALL'
    ? groups
    : groups.filter((group) => notificationGroupMatchesFilter(group, filter));
}

export interface NotificationGroupPresentation {
  readonly kind: NotificationGroupKind;
  readonly title: string;
  readonly meta: string;
  readonly preview: string;
  readonly href: string;
  readonly createdAt: string;
  readonly marker: string;
  readonly markerKind?: 'brand';
  readonly tone: 'accent' | 'warm' | 'neutral';
  readonly unread: boolean;
  readonly badge?: string;
  readonly conversation?: ConversationSummary;
}

export function notificationGroupPresentation(
  group: NotificationGroup,
  conversation: ConversationSummary | undefined,
): NotificationGroupPresentation {
  const latest = group.items[0];
  if (!latest) throw new Error('NOTIFICATION_GROUP_EMPTY');
  const presentation = notificationCategory(latest.category);
  const href = safeNotificationDeepLink(latest.deepLink);
  const unread = group.items.some((item) => !item.readAt);
  const unreadItems = group.items.filter((item) => !item.readAt).length;

  if (group.kind === 'single') {
    return {
      kind: 'single',
      title: latest.title,
      meta: presentation.categoryLabel,
      preview: latest.body,
      href,
      createdAt: latest.createdAt,
      marker: presentation.marker,
      ...(presentation.markerKind ? { markerKind: presentation.markerKind } : {}),
      tone: presentation.tone,
      unread,
    };
  }

  if (group.kind === 'conversation') {
    const messageCount = Math.max(0, Math.trunc(conversation?.unreadCount ?? 0));
    const count = messageCount > 0 ? messageCount : unreadItems;
    return {
      kind: 'conversation',
      title: conversation ? conversationTitle(conversation) : presentation.categoryLabel,
      meta:
        count > 0
          ? `${count} ${pluralRu(count, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`
          : presentation.categoryLabel,
      preview: conversation?.lastMessage?.body ?? latest.body,
      href,
      createdAt: latest.createdAt,
      marker: presentation.marker,
      tone: presentation.tone,
      unread,
      ...(unread && count > 0 ? { badge: formatCount(count) } : {}),
      ...(conversation ? { conversation } : {}),
    };
  }

  if (group.kind === 'game') {
    return {
      kind: 'game',
      title: latest.title,
      meta:
        group.items.length > 1
          ? `${group.items.length} ${pluralRu(group.items.length, 'событие', 'события', 'событий')}`
          : presentation.categoryLabel,
      preview: latest.body,
      href,
      createdAt: latest.createdAt,
      marker: presentation.marker,
      tone: presentation.tone,
      unread,
      ...(unread && unreadItems > 1 ? { badge: formatCount(unreadItems) } : {}),
    };
  }

  return {
    kind: 'bookings',
    title: 'Записи',
    meta:
      group.items.length > 1
        ? `${group.items.length} ${pluralRu(group.items.length, 'событие', 'события', 'событий')}`
        : presentation.categoryLabel,
    preview: latest.body,
    href,
    createdAt: latest.createdAt,
    marker: 'З',
    tone: 'warm',
    unread,
    ...(unread && unreadItems > 1 ? { badge: formatCount(unreadItems) } : {}),
  };
}

export function notificationConversationIndex(
  conversations: readonly ConversationSummary[] | undefined,
): ReadonlyMap<string, ConversationSummary> {
  const index = new Map<string, ConversationSummary>();
  for (const conversation of conversations ?? []) index.set(conversation.id, conversation);
  return index;
}
