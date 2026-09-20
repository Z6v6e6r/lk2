import { useState } from 'react';

import type {
  NotificationPreferencesUpdateRequest,
  NotificationPreferencesView,
} from '../auth-gateway.js';
import styles from './NotificationsUi.module.css';

const CATEGORY_LABELS: Record<string, string> = {
  BOOKING: 'Записи и напоминания',
  GAME: 'Игры',
  MESSAGING: 'Сообщения в чатах',
  FRIENDSHIP: 'Заявки в друзья',
  ADMIN_MESSAGE: 'Сообщения клуба',
};

const CHANNEL_LABELS: Record<string, string> = {
  IN_APP: 'В приложении',
  PUSH: 'Push на устройстве',
};

const QUIET_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const FALLBACK_TIMEZONE = 'Europe/Moscow';

type PreferenceChannel = 'IN_APP' | 'PUSH';

interface ChannelDraft {
  readonly channel: PreferenceChannel;
  readonly enabled: boolean;
  readonly available: boolean;
}

interface CategoryDraft {
  readonly category: string;
  readonly channels: readonly ChannelDraft[];
}

interface PreferenceDraft {
  readonly categories: readonly CategoryDraft[];
  readonly quietEnabled: boolean;
  readonly quietFrom: string;
  readonly quietUntil: string;
  readonly timezoneByKey: Readonly<Record<string, string>>;
}

function preferenceKey(category: string, channel: PreferenceChannel): string {
  return `${category}:${channel}`;
}

function draftFromView(view: NotificationPreferencesView): PreferenceDraft {
  const timezoneByKey: Record<string, string> = {};
  let quietEnabled = false;
  let quietFrom = '23:00';
  let quietUntil = '07:00';
  const categories = view.categories.map((category) => ({
    category: category.category,
    channels: category.channels.map((channel) => {
      const preferenceChannel = channel.channel;
      timezoneByKey[preferenceKey(category.category, preferenceChannel)] =
        channel.timezone || FALLBACK_TIMEZONE;
      if (preferenceChannel === 'PUSH' && channel.quietFrom && channel.quietUntil) {
        quietEnabled = true;
        quietFrom = channel.quietFrom;
        quietUntil = channel.quietUntil;
      }
      return {
        channel: preferenceChannel,
        enabled: channel.enabled,
        available: channel.available,
      };
    }),
  }));
  return { categories, quietEnabled, quietFrom, quietUntil, timezoneByKey };
}

function requestFromDraft(draft: PreferenceDraft): NotificationPreferencesUpdateRequest {
  return {
    categories: draft.categories.map((category) => ({
      category: category.category,
      channels: category.channels.map((channel) => {
        const timezone =
          draft.timezoneByKey[preferenceKey(category.category, channel.channel)] ??
          FALLBACK_TIMEZONE;
        // Quiet hours describe when a push must not interrupt; the inbox item is always durable.
        const quiet =
          channel.channel === 'PUSH' && draft.quietEnabled
            ? { quietFrom: draft.quietFrom, quietUntil: draft.quietUntil }
            : {};
        return { channel: channel.channel, enabled: channel.enabled, timezone, ...quiet };
      }),
    })),
  };
}

interface NotificationPreferenceSettingsProps {
  readonly preferences: NotificationPreferencesView | null;
  readonly busy: boolean;
  readonly error?: string | null | undefined;
  readonly onSave: (update: NotificationPreferencesUpdateRequest) => void;
}

export function NotificationPreferenceSettings({
  preferences,
  busy,
  error,
  onSave,
}: NotificationPreferenceSettingsProps): React.JSX.Element | null {
  // The parent remounts this panel whenever the server view changes, so the draft always starts
  // from the stored state without a state-syncing effect.
  const [draft, setDraft] = useState<PreferenceDraft | null>(() =>
    preferences ? draftFromView(preferences) : null,
  );

  if (!draft) {
    return (
      <section className={styles.preferencePanel} aria-labelledby="notification-preferences-title">
        <h2 id="notification-preferences-title">Настройки уведомлений</h2>
        <p className={styles.preferenceHint}>
          {error ?? 'Настройки уведомлений временно недоступны.'}
        </p>
      </section>
    );
  }

  const quietValid =
    !draft.quietEnabled ||
    (QUIET_TIME_PATTERN.test(draft.quietFrom) && QUIET_TIME_PATTERN.test(draft.quietUntil));

  function toggleChannel(category: string, channel: PreferenceChannel): void {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        categories: current.categories.map((entry) =>
          entry.category === category
            ? {
                ...entry,
                channels: entry.channels.map((item) =>
                  item.channel === channel ? { ...item, enabled: !item.enabled } : item,
                ),
              }
            : entry,
        ),
      };
    });
  }

  return (
    <section className={styles.preferencePanel} aria-labelledby="notification-preferences-title">
      <details>
        <summary id="notification-preferences-title">Настройки уведомлений</summary>
        <p className={styles.preferenceHint}>
          Отключённый канал перестаёт присылать эти события. Важные сервисные сообщения приходят
          всегда.
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <ul className={styles.preferenceList}>
          {draft.categories.map((category) => (
            <li key={category.category} className={styles.preferenceCategory}>
              <span className={styles.preferenceCategoryName}>
                {CATEGORY_LABELS[category.category] ?? category.category}
              </span>
              <div className={styles.preferenceChannels}>
                {category.channels.map((channel) => {
                  const inputId = `notification-preference-${category.category}-${channel.channel}`;
                  const disabled = busy || (channel.channel === 'PUSH' && !channel.available);
                  return (
                    <label
                      key={channel.channel}
                      htmlFor={inputId}
                      className={styles.preferenceToggle}
                    >
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={channel.enabled}
                        disabled={disabled}
                        onChange={() => toggleChannel(category.category, channel.channel)}
                      />
                      <span>{CHANNEL_LABELS[channel.channel] ?? channel.channel}</span>
                      {channel.channel === 'PUSH' && !channel.available ? (
                        <small>не включён для организации</small>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <div className={styles.quietHours}>
          <label className={styles.preferenceToggle} htmlFor="notification-quiet-enabled">
            <input
              id="notification-quiet-enabled"
              type="checkbox"
              checked={draft.quietEnabled}
              disabled={busy}
              onChange={() =>
                setDraft((current) =>
                  current ? { ...current, quietEnabled: !current.quietEnabled } : current,
                )
              }
            />
            <span>Тихие часы для push</span>
          </label>
          <p className={styles.preferenceHint}>
            В этом интервале push не приходит, а событие остаётся в ленте уведомлений.
          </p>
          <div className={styles.quietHoursInputs}>
            <label htmlFor="notification-quiet-from">
              С
              <input
                id="notification-quiet-from"
                type="time"
                value={draft.quietFrom}
                disabled={busy || !draft.quietEnabled}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, quietFrom: event.target.value } : current,
                  )
                }
              />
            </label>
            <label htmlFor="notification-quiet-until">
              До
              <input
                id="notification-quiet-until"
                type="time"
                value={draft.quietUntil}
                disabled={busy || !draft.quietEnabled}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, quietUntil: event.target.value } : current,
                  )
                }
              />
            </label>
          </div>
          {quietValid ? null : (
            <p className={styles.error} role="alert">
              Укажите время в формате ЧЧ:ММ.
            </p>
          )}
        </div>
        <button
          type="button"
          className={styles.preferenceSave}
          disabled={busy || !quietValid}
          onClick={() => onSave(requestFromDraft(draft))}
        >
          {busy ? 'Сохраняем…' : 'Сохранить настройки'}
        </button>
      </details>
    </section>
  );
}
