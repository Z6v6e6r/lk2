import type { ConversationSummary, GameConversationSummary } from '../auth-gateway.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const dayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});
const longDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function conversationTitle(conversation: ConversationSummary): string {
  return conversation.kind === 'DIRECT' ? conversation.participant.displayName : conversation.title;
}

export function unreadLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

export function formatConversationTimestamp(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const dayDifference = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  if (dayDifference === 0) return timeFormatter.format(date);
  if (dayDifference === 1) return 'Вчера';
  if (dayDifference > 1 && dayDifference < 7) {
    return dayFormatter.format(date).replace('.', '');
  }
  return dateFormatter.format(date).replace('.', '');
}

export function formatMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : '';
}

export function messageDayKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatMessageDay(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const dayDifference = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  if (dayDifference === 0) return 'Сегодня';
  if (dayDifference === 1) return 'Вчера';
  return longDateFormatter.format(date);
}

export function safeGameHref(contextId: string | undefined): string | null {
  return contextId && UUID_PATTERN.test(contextId)
    ? `/games/${encodeURIComponent(contextId)}`
    : null;
}

/**
 * A game chat is identified by place and time, like the game card metadata. The game's own timezone
 * wins so a viewer in another zone still reads the canonical start time; an unusable timezone falls
 * back to the browser zone. Returns null when the summary has neither place nor schedule.
 */
export function formatGameSchedule(conversation: GameConversationSummary): string | null {
  const parts: string[] = [];
  if (conversation.stationName) parts.push(conversation.stationName);
  if (conversation.startsAt) {
    const start = new Date(conversation.startsAt);
    if (Number.isFinite(start.getTime())) {
      const { date, time } = gameScheduleFormatters(conversation.timezone);
      parts.push(`${date.format(start)}, ${time.format(start)}`);
    }
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

interface GameScheduleFormatters {
  readonly date: Intl.DateTimeFormat;
  readonly time: Intl.DateTimeFormat;
}

const gameScheduleFormattersByTimezone = new Map<string, GameScheduleFormatters>();

function gameScheduleFormatters(timezone: string | undefined): GameScheduleFormatters {
  const key = timezone ?? '';
  const cached = gameScheduleFormattersByTimezone.get(key);
  if (cached) return cached;
  const zone: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone } : {};
  let formatters: GameScheduleFormatters;
  try {
    formatters = {
      date: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', ...zone }),
      time: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', ...zone }),
    };
  } catch {
    formatters = {
      date: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }),
      time: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    };
  }
  gameScheduleFormattersByTimezone.set(key, formatters);
  return formatters;
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return 'PH';
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('ru-RU') ?? '')
    .join('');
}
