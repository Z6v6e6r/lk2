import type {
  NotificationPreferencesUpdateRequest,
  NotificationPreferencesView,
  WebPushConfiguration,
} from '../auth-gateway.js';
import type { WebPushBrowserState } from '../web-push-client.js';
import type { NotificationIconName } from './NotificationIcon.js';

export type PreferenceChannel = 'IN_APP' | 'PUSH';

export interface PreferenceChannelDraft {
  readonly channel: PreferenceChannel;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly timezone: string;
}

export interface PreferenceCategoryDraft {
  readonly category: string;
  readonly channels: readonly PreferenceChannelDraft[];
}

export interface PreferenceDraft {
  readonly categories: readonly PreferenceCategoryDraft[];
  readonly quietEnabled: boolean;
  readonly quietFrom: string;
  readonly quietUntil: string;
}

export interface NotificationCategorySettings {
  readonly title: string;
  readonly description: string;
  readonly icon: NotificationIconName;
}

const CATEGORY_SETTINGS: Readonly<Record<string, NotificationCategorySettings>> = {
  MESSAGING: {
    title: 'Чаты',
    description: 'Личные диалоги и чаты игр',
    icon: 'chat',
  },
  GAME: {
    title: 'Игры',
    description: 'Участие, отмена игры, изменения состава',
    icon: 'game',
  },
  BOOKING: {
    title: 'Записи',
    description: 'Подтверждение и изменения записи',
    icon: 'calendar',
  },
  BOOKING_REMINDER: {
    title: 'Напоминания',
    description: 'Напоминание перед началом записи',
    icon: 'clock',
  },
  FRIENDSHIP: {
    title: 'Друзья',
    description: 'Заявки в друзья',
    icon: 'friends',
  },
  ADMIN_MESSAGE: {
    title: 'Сообщения клуба',
    description: 'Новости, анонсы и объявления',
    icon: 'megaphone',
  },
};

export const QUIET_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const FALLBACK_TIMEZONE = 'Europe/Moscow';

export function notificationPushStatus(
  configuration: WebPushConfiguration,
  browserState: WebPushBrowserState,
): string {
  if (!configuration.enabled) return 'Push пока не включён для этой организации.';
  if (browserState === 'unsupported') return 'Этот браузер не поддерживает Web Push.';
  if (browserState === 'needs_install')
    return 'На iPhone и iPad push работает только из приложения на экране «Домой».';
  if (browserState === 'denied') return 'Уведомления запрещены в настройках браузера.';
  if (browserState === 'subscribed') return 'Push-уведомления включены на этом устройстве.';
  return 'Включите push, чтобы получать события при закрытом кабинете.';
}

export function canToggleNotificationPush(
  configuration: WebPushConfiguration,
  browserState: WebPushBrowserState,
): boolean {
  return (
    configuration.enabled &&
    browserState !== 'unsupported' &&
    browserState !== 'needs_install' &&
    browserState !== 'denied' &&
    browserState !== 'subscribed'
  );
}

/** Unknown categories stay configurable: the tenant, not this map, decides what can be delivered. */
export function notificationCategorySettings(category: string): NotificationCategorySettings {
  return (
    CATEGORY_SETTINGS[category] ?? {
      title: category,
      description: 'Уведомления этой категории',
      icon: 'info',
    }
  );
}

export function draftFromView(view: NotificationPreferencesView): PreferenceDraft {
  let quietEnabled = false;
  let quietFrom = '23:00';
  let quietUntil = '07:00';
  const categories = view.categories.map((category) => ({
    category: category.category,
    channels: category.channels.map((channel) => {
      if (channel.channel === 'PUSH' && channel.quietFrom && channel.quietUntil) {
        quietEnabled = true;
        quietFrom = channel.quietFrom;
        quietUntil = channel.quietUntil;
      }
      return {
        channel: channel.channel,
        enabled: channel.enabled,
        available: channel.available,
        timezone: channel.timezone || FALLBACK_TIMEZONE,
      };
    }),
  }));
  return { categories, quietEnabled, quietFrom, quietUntil };
}

export function requestFromDraft(draft: PreferenceDraft): NotificationPreferencesUpdateRequest {
  return {
    categories: draft.categories.map((category) => ({
      category: category.category,
      channels: category.channels.map((channel) => {
        // Quiet hours describe when a push must not interrupt; the inbox item is always durable.
        const quiet =
          channel.channel === 'PUSH' && draft.quietEnabled
            ? { quietFrom: draft.quietFrom, quietUntil: draft.quietUntil }
            : {};
        return {
          channel: channel.channel,
          enabled: channel.enabled,
          timezone: channel.timezone || FALLBACK_TIMEZONE,
          ...quiet,
        };
      }),
    })),
  };
}

export function withCategoryChannel(
  draft: PreferenceDraft,
  category: string,
  channel: PreferenceChannel,
  enabled: boolean,
): PreferenceDraft {
  return {
    ...draft,
    categories: draft.categories.map((entry) =>
      entry.category === category
        ? {
            ...entry,
            channels: entry.channels.map((item) =>
              item.channel === channel ? { ...item, enabled } : item,
            ),
          }
        : entry,
    ),
  };
}

export function withChannelForAllCategories(
  draft: PreferenceDraft,
  channel: PreferenceChannel,
  enabled: boolean,
): PreferenceDraft {
  return {
    ...draft,
    categories: draft.categories.map((entry) => ({
      ...entry,
      channels: entry.channels.map((item) =>
        item.channel === channel && item.available ? { ...item, enabled } : item,
      ),
    })),
  };
}

export function withQuietWindow(
  draft: PreferenceDraft,
  patch: {
    readonly quietEnabled?: boolean;
    readonly quietFrom?: string;
    readonly quietUntil?: string;
  },
): PreferenceDraft {
  return { ...draft, ...patch };
}

export function quietWindowValid(draft: PreferenceDraft): boolean {
  if (!draft.quietEnabled) return true;
  return QUIET_TIME_PATTERN.test(draft.quietFrom) && QUIET_TIME_PATTERN.test(draft.quietUntil);
}

export function quietWindowSummary(draft: PreferenceDraft): string {
  if (!draft.quietEnabled) return 'Выключены';
  return `${draft.quietFrom} – ${draft.quietUntil}`;
}

export function categoryChannel(
  draft: PreferenceCategoryDraft,
  channel: PreferenceChannel,
): PreferenceChannelDraft | undefined {
  return draft.channels.find((item) => item.channel === channel);
}

export function pushChannelsEnabled(draft: PreferenceDraft): readonly PreferenceChannelDraft[] {
  return draft.categories
    .map((category) => categoryChannel(category, 'PUSH'))
    .filter((channel): channel is PreferenceChannelDraft => channel !== undefined);
}
