import type { NotificationInboxPage } from '../auth-gateway.js';

export type NotificationItem = NotificationInboxPage['items'][number];
export type NotificationFilter = 'ALL' | 'GAME' | 'SYSTEM';

export interface NotificationCategoryPresentation {
  readonly filter: Exclude<NotificationFilter, 'ALL'> | null;
  readonly filterLabel: string | null;
  readonly categoryLabel: string;
  readonly marker: string;
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
  ADMIN_MESSAGE: {
    filter: 'SYSTEM',
    filterLabel: 'Системные',
    categoryLabel: 'Системное',
    marker: 'PH',
    tone: 'neutral',
  },
};

const relativeDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});

const NOTIFICATION_DEEP_LINK_ORIGIN = 'https://notifications.invalid';
const ENCODED_CONTROL_WHITESPACE_OR_BACKSLASH = /%(?:0[0-9a-f]|1[0-9a-f]|20|5c|7f)/iu;

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
