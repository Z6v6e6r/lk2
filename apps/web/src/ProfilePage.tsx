import type {
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  PlayerProfileView,
  ProfileActionCapability,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
} from '@phub/api-sdk';
import { useState } from 'react';

interface ProfilePageProps {
  readonly profile: PlayerProfileView;
  readonly tenantName: string;
  readonly logoutBusy: boolean;
  readonly privacySettings?: ProfilePrivacySettings | null;
  readonly privacyBusy?: boolean;
  readonly privacyError?: string | null;
  readonly privacyNotice?: string | null;
  readonly bookingPreferences?: BookingPreferences | null;
  readonly bookingPreferencesBusy?: boolean;
  readonly bookingPreferencesError?: string | null;
  readonly bookingPreferencesNotice?: string | null;
  readonly stationChoices?: readonly { readonly id: string; readonly name: string }[];
  readonly error?: string | null;
  readonly onSavePrivacy?: (input: ProfilePrivacyUpdateRequest) => void;
  readonly onSaveBookingPreferences?: (input: BookingPreferencesUpdateRequest) => void;
  readonly onLogout: () => void;
}

const weekdayLabels: Readonly<
  Record<BookingPreferences['preferredTimeWindows'][number]['weekday'], string>
> = {
  MON: 'Понедельник',
  TUE: 'Вторник',
  WED: 'Среда',
  THU: 'Четверг',
  FRI: 'Пятница',
  SAT: 'Суббота',
  SUN: 'Воскресенье',
};

function BookingPreferencesSettings({
  settings,
  stations,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings?: BookingPreferences | null;
  readonly stations: readonly { readonly id: string; readonly name: string }[];
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: BookingPreferencesUpdateRequest) => void;
}): React.JSX.Element {
  return (
    <section className="profile-booking-preferences" aria-labelledby="booking-preferences-title">
      <div className="profile-section-heading">
        <span>Рекомендации</span>
        <h2 id="booking-preferences-title">Когда и где мне удобно</h2>
      </div>
      {!settings ? (
        <p className="profile-privacy-loading" role={error ? 'alert' : 'status'}>
          {error ?? 'Загружаем предпочтения…'}
        </p>
      ) : (
        <BookingPreferencesForm
          key={settings.version}
          settings={settings}
          stations={stations}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          {...(notice !== undefined ? { notice } : {})}
          {...(onSave !== undefined ? { onSave } : {})}
        />
      )}
    </section>
  );
}

function BookingPreferencesForm({
  settings,
  stations,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings: BookingPreferences;
  readonly stations: readonly { readonly id: string; readonly name: string }[];
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: BookingPreferencesUpdateRequest) => void;
}): React.JSX.Element {
  const [favoriteStationIds, setFavoriteStationIds] = useState<readonly string[]>(
    settings.favoriteStationIds,
  );
  const [preferredTimeWindows, setPreferredTimeWindows] = useState(settings.preferredTimeWindows);
  const [useHistory, setUseHistory] = useState(settings.useHistory);
  const serialized = JSON.stringify({ favoriteStationIds, preferredTimeWindows, useHistory });
  const initial = JSON.stringify({
    favoriteStationIds: settings.favoriteStationIds,
    preferredTimeWindows: settings.preferredTimeWindows,
    useHistory: settings.useHistory,
  });

  return (
    <form
      className="profile-booking-preferences-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.({
          expectedVersion: settings.version,
          favoriteStationIds: [...favoriteStationIds],
          preferredTimeWindows: [...preferredTimeWindows],
          useHistory,
        });
      }}
    >
      <fieldset disabled={busy}>
        <legend>Любимые станции</legend>
        {stations.length === 0 ? (
          <p>Станции появятся после загрузки доступных игр.</p>
        ) : (
          <div className="profile-station-options">
            {stations.map((station) => {
              const checked = favoriteStationIds.includes(station.id);
              return (
                <label key={station.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && favoriteStationIds.length >= 3}
                    onChange={(event) =>
                      setFavoriteStationIds((current) =>
                        event.currentTarget.checked
                          ? [...current, station.id]
                          : current.filter((id) => id !== station.id),
                      )
                    }
                  />
                  <span>{station.name}</span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Удобное время</legend>
        <div className="profile-time-windows">
          {preferredTimeWindows.map((window, index) => (
            <div key={`${window.weekday}-${window.startsAt}-${window.endsAt}-${index}`}>
              <select
                aria-label={`День для интервала ${index + 1}`}
                value={window.weekday}
                onChange={(event) =>
                  setPreferredTimeWindows((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            weekday: event.currentTarget.value as typeof item.weekday,
                          }
                        : item,
                    ),
                  )
                }
              >
                {Object.entries(weekdayLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="time"
                aria-label={`Начало интервала ${index + 1}`}
                value={window.startsAt}
                onChange={(event) =>
                  setPreferredTimeWindows((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, startsAt: event.currentTarget.value } : item,
                    ),
                  )
                }
              />
              <span>—</span>
              <input
                type="time"
                aria-label={`Конец интервала ${index + 1}`}
                value={window.endsAt}
                onChange={(event) =>
                  setPreferredTimeWindows((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, endsAt: event.currentTarget.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label={`Удалить интервал ${index + 1}`}
                onClick={() =>
                  setPreferredTimeWindows((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          className="profile-add-time-window"
          type="button"
          disabled={busy || preferredTimeWindows.length >= 14}
          onClick={() =>
            setPreferredTimeWindows((current) => [
              ...current,
              { weekday: 'MON', startsAt: '18:00', endsAt: '21:00' },
            ])
          }
        >
          Добавить интервал
        </button>
      </fieldset>

      <label className="profile-privacy-toggle">
        <span>
          <strong>Учитывать историю игр</strong>
          <small>Только завершённые игры за последние 180 дней</small>
        </span>
        <input
          type="checkbox"
          checked={useHistory}
          disabled={busy}
          onChange={(event) => setUseHistory(event.currentTarget.checked)}
        />
      </label>

      <div className="profile-privacy-save-row">
        <p role={error ? 'alert' : notice ? 'status' : undefined}>{error ?? notice}</p>
        <button type="submit" disabled={busy || serialized === initial || !onSave}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}

function initials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function accessTierLabel(tier: PlayerProfileView['access']['tier']): string {
  switch (tier) {
    case 'SELF':
      return 'Личный';
    case 'INTERACTION':
      return 'С доступом';
    case 'EXTENDED':
      return 'Расширенный';
    case 'BASIC':
      return 'Базовый';
  }
}

function lockedActionMessage(capability: ProfileActionCapability): string {
  switch (capability.reason) {
    case 'PROFILE_RESTRICTED':
      return 'Игрок ограничил это действие в настройках профиля.';
    case 'ACCESS_REQUIRED':
      return 'Для этого действия пока нет доступа.';
    default:
      return 'Действие сейчас недоступно.';
  }
}

function ProfileAction({
  title,
  description,
  capability,
}: {
  readonly title: string;
  readonly description: string;
  readonly capability: ProfileActionCapability;
}): React.JSX.Element | null {
  if (capability.status === 'HIDDEN') return null;
  const content = (
    <>
      <span aria-hidden="true">{title === 'Открыть чат' ? '↗' : '✦'}</span>
      <strong>{title}</strong>
      <small>
        {capability.status === 'AVAILABLE' ? description : lockedActionMessage(capability)}
      </small>
    </>
  );

  return capability.status === 'AVAILABLE' && capability.route ? (
    <a className="profile-action" href={capability.route}>
      {content}
    </a>
  ) : (
    <button className="profile-action is-locked" type="button" disabled>
      {content}
    </button>
  );
}

function PrivacySettings({
  settings,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings?: ProfilePrivacySettings | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: ProfilePrivacyUpdateRequest) => void;
}): React.JSX.Element {
  return (
    <section className="profile-privacy-settings" aria-labelledby="privacy-settings-title">
      <div className="profile-section-heading">
        <span>Настройки профиля</span>
        <h2 id="privacy-settings-title">Кто может связаться</h2>
      </div>
      {!settings ? (
        <p className="profile-privacy-loading" role={error ? 'alert' : 'status'}>
          {error ?? 'Загружаем настройки приватности…'}
        </p>
      ) : (
        <PrivacySettingsForm
          key={`${settings.version}:${settings.contactPolicy}:${settings.chatPolicy}`}
          settings={settings}
          busy={busy}
          {...(error !== undefined ? { error } : {})}
          {...(notice !== undefined ? { notice } : {})}
          {...(onSave !== undefined ? { onSave } : {})}
        />
      )}
    </section>
  );
}

function PrivacySettingsForm({
  settings,
  busy,
  error,
  notice,
  onSave,
}: {
  readonly settings: ProfilePrivacySettings;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly notice?: string | null;
  readonly onSave?: (input: ProfilePrivacyUpdateRequest) => void;
}): React.JSX.Element {
  const [contactAllowed, setContactAllowed] = useState(settings.contactPolicy === 'AUTHORIZED');
  const [chatAllowed, setChatAllowed] = useState(settings.chatPolicy === 'AUTHORIZED');
  const changed =
    contactAllowed !== (settings.contactPolicy === 'AUTHORIZED') ||
    chatAllowed !== (settings.chatPolicy === 'AUTHORIZED');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave?.({
          expectedVersion: settings.version,
          contactPolicy: contactAllowed ? 'AUTHORIZED' : 'NOBODY',
          chatPolicy: chatAllowed ? 'AUTHORIZED' : 'NOBODY',
        });
      }}
    >
      <label className="profile-privacy-toggle">
        <span>
          <strong>Запрос на связь</strong>
          <small>Разрешить после серверной проверки доступа</small>
        </span>
        <input
          type="checkbox"
          checked={contactAllowed}
          disabled={busy}
          onChange={(event) => setContactAllowed(event.currentTarget.checked)}
        />
      </label>
      <label className="profile-privacy-toggle">
        <span>
          <strong>Личный чат</strong>
          <small>Разрешить создание прямого чата после серверной проверки</small>
        </span>
        <input
          type="checkbox"
          checked={chatAllowed}
          disabled={busy}
          onChange={(event) => setChatAllowed(event.currentTarget.checked)}
        />
      </label>
      <div className="profile-privacy-save-row">
        <p role={error ? 'alert' : notice ? 'status' : undefined}>{error ?? notice}</p>
        <button type="submit" disabled={busy || !changed || !onSave}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}

export function ProfilePage({
  profile: view,
  tenantName,
  logoutBusy,
  privacySettings,
  privacyBusy = false,
  privacyError,
  privacyNotice,
  bookingPreferences,
  bookingPreferencesBusy = false,
  bookingPreferencesError,
  bookingPreferencesNotice,
  stationChoices = [],
  error,
  onSavePrivacy,
  onSaveBookingPreferences,
  onLogout,
}: ProfilePageProps): React.JSX.Element {
  const { profile, privateAccount, access } = view;
  const isSelf = access.audience === 'SELF';
  const balance = privateAccount
    ? new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: privateAccount.currency,
        maximumFractionDigits: 0,
      }).format(privateAccount.balanceMinor / 100)
    : null;
  const rating = profile.level.value;

  return (
    <main className="profile-page">
      <section className="profile-hero">
        <header className="profile-toolbar">
          <a href="/" aria-label="Вернуться на Главную">
            ‹
          </a>
          <span>{tenantName}</span>
          <i aria-hidden="true" />
        </header>
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" />
            ) : (
              initials(profile.displayName)
            )}
          </span>
          <p>{isSelf ? 'Мой профиль' : 'Профиль игрока'}</p>
          <h1>{profile.displayName}</h1>
          {privateAccount?.phoneLast4 ? <small>•••• {privateAccount.phoneLast4}</small> : null}
        </div>
      </section>

      <section className="profile-card" aria-label="Доступные данные профиля">
        {privateAccount ? (
          <div>
            <span>Баланс</span>
            <strong>{balance}</strong>
            <small>Виден только вам</small>
          </div>
        ) : (
          <div>
            <span>Доступ к профилю</span>
            <strong>{accessTierLabel(access.tier)}</strong>
            <small>Определён сервером</small>
          </div>
        )}
        <div>
          <span>Уровень</span>
          <strong>{profile.level.label}</strong>
          <small>
            {profile.level.assessmentRequired
              ? 'Нужна оценка уровня'
              : rating === undefined
                ? 'Рейтинг доступен на следующем уровне'
                : `Рейтинг ${rating.toLocaleString('ru-RU')}`}
          </small>
        </div>
      </section>

      {access.audience === 'OTHER' ? (
        <section className="profile-access-section" aria-labelledby="profile-actions-title">
          <div className="profile-section-heading">
            <span>Возможности</span>
            <h2 id="profile-actions-title">Связаться с игроком</h2>
          </div>
          <div className="profile-actions">
            <ProfileAction
              title="Связаться"
              description="Выбрать доступный способ связи"
              capability={access.contact}
            />
            <ProfileAction
              title="Открыть чат"
              description="Перейти в личный чат ПадлХАБ"
              capability={access.chat}
            />
          </div>
        </section>
      ) : null}

      {isSelf ? (
        <BookingPreferencesSettings
          key={bookingPreferences?.version ?? 'loading'}
          {...(bookingPreferences !== undefined ? { settings: bookingPreferences } : {})}
          stations={stationChoices}
          busy={bookingPreferencesBusy}
          {...(bookingPreferencesError !== undefined ? { error: bookingPreferencesError } : {})}
          {...(bookingPreferencesNotice !== undefined ? { notice: bookingPreferencesNotice } : {})}
          {...(onSaveBookingPreferences ? { onSave: onSaveBookingPreferences } : {})}
        />
      ) : null}

      {isSelf ? (
        <PrivacySettings
          key={privacySettings?.version ?? 'loading'}
          {...(privacySettings !== undefined ? { settings: privacySettings } : {})}
          busy={privacyBusy}
          {...(privacyError !== undefined ? { error: privacyError } : {})}
          {...(privacyNotice !== undefined ? { notice: privacyNotice } : {})}
          {...(onSavePrivacy ? { onSave: onSavePrivacy } : {})}
        />
      ) : null}

      <section className="profile-privacy-note" aria-labelledby="profile-privacy-title">
        <span aria-hidden="true">◎</span>
        <div>
          <h2 id="profile-privacy-title">Приватность и доступ</h2>
          <p>
            {isSelf
              ? 'Другие игроки видят только разрешённые поля. Связь и личный чат открываются после серверной проверки доступа.'
              : 'Это уже отфильтрованный профиль: телефон, баланс и закрытые поля не передаются в браузер.'}
          </p>
        </div>
      </section>

      {error ? (
        <p className="profile-error" role="alert">
          {error}
        </p>
      ) : null}

      {isSelf ? (
        <button className="profile-logout" type="button" disabled={logoutBusy} onClick={onLogout}>
          {logoutBusy ? 'Выходим…' : 'Выйти из аккаунта'}
        </button>
      ) : null}
    </main>
  );
}
