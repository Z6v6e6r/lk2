import type {
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  CommunityMembershipPage,
  HomeDashboard,
  PlayerProfileView,
  ProfileActionCapability,
  ProfileFriendPage,
  ProfileFriendship,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
} from '@phub/api-sdk';
import { useState } from 'react';
import type { CSSProperties } from 'react';

import { MainBottomNavigation, NotificationBellLink } from './HomeDashboardPage.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';
import levelABackground from './assets/profile-levels/level-a.jpg';
import levelBBackground from './assets/profile-levels/level-b.jpg';
import levelBPlusBackground from './assets/profile-levels/level-b-plus.jpg';
import levelCBackground from './assets/profile-levels/level-c.jpg';
import levelCPlusBackground from './assets/profile-levels/level-c-plus.jpg';
import levelDBackground from './assets/profile-levels/level-d.jpg';
import levelDPlusBackground from './assets/profile-levels/level-d-plus.jpg';

interface ProfilePageProps {
  readonly profile: PlayerProfileView;
  readonly logoutBusy: boolean;
  readonly notificationUnreadCount?: number;
  readonly privacySettings?: ProfilePrivacySettings | null;
  readonly privacyBusy?: boolean;
  readonly privacyError?: string | null;
  readonly privacyNotice?: string | null;
  readonly bookingPreferences?: BookingPreferences | null;
  readonly bookingPreferencesBusy?: boolean;
  readonly bookingPreferencesError?: string | null;
  readonly bookingPreferencesNotice?: string | null;
  readonly stationChoices?: readonly { readonly id: string; readonly name: string }[];
  readonly subscriptions?: HomeDashboard['subscriptions'] | null;
  readonly subscriptionsError?: string | null;
  readonly communities?: CommunityMembershipPage | null;
  readonly communitiesError?: string | null;
  readonly friends?: ProfileFriendPage | null;
  readonly friendship?: ProfileFriendship | null;
  readonly friendsBusy?: boolean;
  readonly friendsError?: string | null;
  readonly error?: string | null;
  readonly onSavePrivacy?: (input: ProfilePrivacyUpdateRequest) => void;
  readonly onSaveBookingPreferences?: (input: BookingPreferencesUpdateRequest) => void;
  readonly onAddFriend?: () => void;
  readonly onLogout: () => void;
}

type ProfilePageStyle = CSSProperties & {
  readonly '--profile-level-background': string;
  readonly '--profile-level-accent': string;
  readonly '--profile-level-soft': string;
};

const levelBackgrounds: Readonly<Record<string, string>> = {
  A: levelABackground,
  'B+': levelBPlusBackground,
  B: levelBBackground,
  'C+': levelCPlusBackground,
  C: levelCBackground,
  'D+': levelDPlusBackground,
  D: levelDBackground,
};

const levelAccents: Readonly<Record<string, string>> = {
  A: '#7650f4',
  'B+': '#8c55ef',
  B: '#be27b4',
  'C+': '#df2485',
  C: '#ef3150',
  'D+': '#ff641c',
  D: '#ff8a12',
};

const levelSoftTones: Readonly<Record<string, string>> = {
  A: '#eeeaff',
  'B+': '#f2e9ff',
  B: '#f8e7f6',
  'C+': '#ffe8f1',
  C: '#ffe9ec',
  'D+': '#fff0e6',
  D: '#fff3df',
};

const levelScale = ['A', 'B+', 'B', 'C+', 'C', 'D+', 'D'] as const;

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

function levelProgress(value: number | undefined, assessmentRequired: boolean): number {
  if (assessmentRequired || value === undefined || !Number.isFinite(value)) return 0;
  return Math.round((value - Math.floor(value)) * 100);
}

function communityInitials(title: string): string {
  return initials(title);
}

function ProfileIcon({
  name,
}: {
  readonly name:
    | 'back'
    | 'bell'
    | 'share'
    | 'community'
    | 'friends'
    | 'preference'
    | 'history'
    | 'eye'
    | 'city'
    | 'sport'
    | 'crown';
}): React.JSX.Element {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
  } as const;

  switch (name) {
    case 'back':
      return (
        <svg {...common}>
          <path
            d="m15 18-6-6 6-6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path
            d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'share':
      return (
        <svg {...common}>
          <path
            d="M8 12h8M13 8l4 4-4 4M5 5h6M5 19h6M5 5v14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'community':
    case 'friends':
      return (
        <svg {...common}>
          <path
            d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.87M16 2.13a4 4 0 0 1 0 7.75"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'preference':
      return (
        <svg {...common}>
          <path
            d="m12 2 3.1 6.3L22 9.3l-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1L12 2Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <path
            d="M4 19V5M4 19h16M7 15l4-4 3 2 5-6"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="15" r="1" fill="currentColor" />
          <circle cx="11" cy="11" r="1" fill="currentColor" />
          <circle cx="14" cy="13" r="1" fill="currentColor" />
          <circle cx="19" cy="7" r="1" fill="currentColor" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...common}>
          <path
            d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      );
    case 'city':
      return (
        <svg {...common}>
          <path
            d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      );
    case 'sport':
      return (
        <svg {...common}>
          <path
            d="m8 16 8-8M6.2 13.8l4 4M13.8 6.2l4 4M4.5 15.5l4 4M15.5 4.5l4 4M3 18l3 3 15-15-3-3L3 18Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'crown':
      return (
        <svg {...common}>
          <path
            d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 11H5L3 7Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function ProfileFacts(): React.JSX.Element {
  return (
    <section className="profile-facts" aria-label="Город и вид спорта">
      <div>
        <span className="profile-inline-icon">
          <ProfileIcon name="city" />
        </span>
        <span>
          <small>город</small>
          <strong>Москва</strong>
        </span>
        <i aria-hidden="true">›</i>
      </div>
      <div>
        <span className="profile-inline-icon">
          <ProfileIcon name="sport" />
        </span>
        <span>
          <small>вид спорта</small>
          <strong>Падел</strong>
        </span>
        <i aria-hidden="true">›</i>
      </div>
    </section>
  );
}

function subscriptionDate(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function remainingVisitsLabel(value: number): string {
  const lastTwoDigits = value % 100;
  const lastDigit = value % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${value} посещений`;
  if (lastDigit === 1) return `${value} посещение`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${value} посещения`;
  return `${value} посещений`;
}

function ProfileSubscriptions({
  subscriptions,
  error,
}: {
  readonly subscriptions?: HomeDashboard['subscriptions'] | null;
  readonly error?: string | null;
}): React.JSX.Element {
  const current =
    subscriptions
      ?.filter((subscription) => ['active', 'scheduled', 'paused'].includes(subscription.status))
      .slice(0, 2) ?? [];

  return (
    <section className="profile-subscriptions" aria-labelledby="profile-subscriptions-title">
      <header>
        <span className="profile-inline-icon">
          <ProfileIcon name="crown" />
        </span>
        <h2 id="profile-subscriptions-title">Подписки и абонементы</h2>
      </header>

      {error ? (
        <p role="alert">{error}</p>
      ) : !subscriptions ? (
        <p role="status">Загружаем действующие подписки…</p>
      ) : current.length === 0 ? (
        <p>Действующих подписок пока нет.</p>
      ) : (
        <div className="profile-subscription-list">
          {current.map((subscription) => {
            const validUntil = subscriptionDate(subscription.validUntil);
            return (
              <article key={subscription.id}>
                <span className="profile-subscription-art" aria-hidden="true">
                  <b>{subscription.remainingUnits}</b>
                  <small>игр</small>
                </span>
                <span className="profile-subscription-copy">
                  <span>
                    <strong>{subscription.title}</strong>
                    {subscription.status === 'active' ? <em>активна</em> : null}
                  </span>
                  <small>
                    {subscription.remainingUnits > 0
                      ? `осталось ${remainingVisitsLabel(subscription.remainingUnits)}`
                      : 'посещения закончились'}
                    {validUntil ? ` · до ${validUntil}` : ''}
                  </small>
                </span>
                <a href={subscription.route}>продлить</a>
              </article>
            );
          })}
        </div>
      )}

      <a className="profile-subscriptions-all" href="/subscriptions">
        все подписки <span aria-hidden="true">›</span>
      </a>
    </section>
  );
}

function ProfileCommunities({
  page,
  error,
}: {
  readonly page?: CommunityMembershipPage | null;
  readonly error?: string | null;
}): React.JSX.Element {
  const communities = page?.items.slice(0, 4) ?? [];

  return (
    <section className="profile-communities" aria-labelledby="profile-communities-title">
      <header>
        <span className="profile-inline-icon">
          <ProfileIcon name="community" />
        </span>
        <h2 id="profile-communities-title">Сообщества</h2>
        <a href="/communities">Все</a>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p role="status">Загружаем сообщества…</p>
      ) : communities.length === 0 ? (
        <p>Вы пока не вступили ни в одно сообщество.</p>
      ) : (
        <div className="profile-community-list">
          {communities.map((community) => (
            <a
              href={community.route}
              key={community.id}
              aria-label={`${community.title}, ${
                community.memberRank ? `${community.memberRank} место` : 'вне рейтинга'
              }`}
            >
              <span>
                {community.logoUrl ? (
                  <img src={community.logoUrl} alt="" />
                ) : (
                  communityInitials(community.title)
                )}
              </span>
              <small>{community.title}</small>
              <em>{community.memberRank ? `${community.memberRank} место` : 'вне рейтинга'}</em>
              {community.unreadChatCount > 0 ? <b>{community.unreadChatCount}</b> : null}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfileFriends({
  page,
  error,
}: {
  readonly page?: ProfileFriendPage | null;
  readonly error?: string | null;
}): React.JSX.Element {
  const friends = page?.items.slice(0, 4) ?? [];
  return (
    <section className="profile-friends" aria-labelledby="profile-friends-title">
      <header>
        <span className="profile-inline-icon">
          <ProfileIcon name="friends" />
        </span>
        <h2 id="profile-friends-title">Друзья</h2>
        {page ? <span>{page.items.length}</span> : null}
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p role="status">Загружаем друзей…</p>
      ) : friends.length === 0 ? (
        <p>Добавляйте игроков из их профилей — они появятся здесь.</p>
      ) : (
        <div className="profile-friend-list">
          {friends.map((friend) => {
            const [firstName = friend.displayName, ...familyNameParts] = friend.displayName
              .trim()
              .split(/\s+/);
            const familyName = familyNameParts.join(' ');

            return (
              <a
                href={friend.route}
                key={friend.userId}
                aria-label={`${friend.displayName} · ${friend.levelLabel}`}
              >
                <ParticipantAvatarStack
                  ariaLabel={friend.displayName}
                  capacity={1}
                  participants={[
                    {
                      key: friend.userId,
                      displayName: friend.displayName,
                      avatarUrl: friend.avatarUrl,
                      level: friend.levelLabel,
                    },
                  ]}
                />
                <small>
                  <span>{firstName}</span>
                  {familyName ? <span>{familyName}</span> : null}
                </small>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FriendshipAction({
  friendship,
  busy,
  error,
  onAdd,
}: {
  readonly friendship?: ProfileFriendship | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onAdd?: () => void;
}): React.JSX.Element {
  const isFriend = friendship?.status === 'FRIEND';
  return (
    <section className="profile-friendship-action" aria-labelledby="profile-friendship-title">
      <span className="profile-inline-icon">
        <ProfileIcon name="friends" />
      </span>
      <span>
        <strong id="profile-friendship-title">
          {isFriend ? 'Уже в друзьях' : 'Добавить в друзья'}
        </strong>
        <small>
          {isFriend ? 'Игрок отображается в вашем блоке друзей' : 'Игрок появится в вашем профиле'}
        </small>
      </span>
      <button type="button" disabled={busy || isFriend || !friendship || !onAdd} onClick={onAdd}>
        {busy ? 'Добавляем…' : isFriend ? 'Добавлен' : 'Добавить'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
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
  logoutBusy,
  notificationUnreadCount = 0,
  privacySettings,
  privacyBusy = false,
  privacyError,
  privacyNotice,
  bookingPreferences,
  bookingPreferencesBusy = false,
  bookingPreferencesError,
  bookingPreferencesNotice,
  stationChoices = [],
  subscriptions,
  subscriptionsError,
  communities,
  communitiesError,
  friends,
  friendship,
  friendsBusy = false,
  friendsError,
  error,
  onSavePrivacy,
  onSaveBookingPreferences,
  onAddFriend,
  onLogout,
}: ProfilePageProps): React.JSX.Element {
  const { profile, privateAccount, access } = view;
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [activeSettings, setActiveSettings] = useState<'preferences' | 'visibility' | null>(null);
  const isSelf = access.audience === 'SELF';
  const balance = privateAccount
    ? new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: privateAccount.currency,
        maximumFractionDigits: 0,
      }).format(privateAccount.balanceMinor / 100)
    : null;
  const rating = profile.level.value;
  const levelKey = levelBackgrounds[profile.level.label] ? profile.level.label : 'A';
  const displayLevel = profile.level.assessmentRequired ? '?' : profile.level.label;
  const pageStyle: ProfilePageStyle = {
    '--profile-level-background': `url("${levelBackgrounds[levelKey] ?? levelABackground}")`,
    '--profile-level-accent': levelAccents[levelKey] ?? levelAccents.A ?? '#7650f4',
    '--profile-level-soft': levelSoftTones[levelKey] ?? levelSoftTones.A ?? '#eeeaff',
  };

  async function shareProfile(): Promise<void> {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: profile.displayName, url });
        setShareNotice('Профиль отправлен');
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setShareNotice('Ссылка скопирована');
      } else {
        setShareNotice('Скопируйте адрес страницы из браузера');
      }
    } catch (shareError: unknown) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
      setShareNotice('Не удалось поделиться профилем');
    }
  }

  return (
    <div className="profile-shell">
      <main className="profile-page" style={pageStyle}>
        <header className="profile-toolbar">
          <button
            className="profile-toolbar__back"
            type="button"
            aria-label="Назад"
            onClick={() => window.history.back()}
          >
            <ProfileIcon name="back" />
          </button>
          <span>PadelHub Player</span>
          <NotificationBellLink
            className="profile-toolbar__bell"
            unreadCount={notificationUnreadCount}
          />
        </header>

        <section className="profile-identity" aria-labelledby="profile-name">
          <h1 id="profile-name">{profile.displayName}</h1>
          {isSelf ? (
            <a className="profile-edit-link" href="#profile-settings">
              <span aria-hidden="true">✎</span>
              редактировать профиль
            </a>
          ) : null}

          <div className="profile-avatar-stage">
            <PlayerLevelAvatar
              className="profile-level-avatar"
              alt={profile.displayName}
              fallbackSeed={profile.userId}
              level={displayLevel}
              progress={levelProgress(rating, profile.level.assessmentRequired)}
              size={150}
              src={profile.avatarUrl ?? null}
            />
          </div>

          <div className="profile-stats" aria-label="Данные профиля">
            <div>
              <span>уровень</span>
              <strong>{displayLevel}</strong>
            </div>
            <div>
              <span>{privateAccount ? 'баланс' : 'доступ'}</span>
              <strong>{privateAccount ? balance : accessTierLabel(access.tier)}</strong>
            </div>
          </div>

          <button className="profile-share" type="button" onClick={() => void shareProfile()}>
            <ProfileIcon name="share" />
            QR / поделиться профилем
          </button>
          {shareNotice ? (
            <p className="profile-share-notice" role="status">
              {shareNotice}
            </p>
          ) : null}
        </section>

        <div className="profile-content">
          {access.audience === 'OTHER' ? (
            <>
              <FriendshipAction
                busy={friendsBusy}
                {...(friendship !== undefined ? { friendship } : {})}
                {...(friendsError !== undefined ? { error: friendsError } : {})}
                {...(onAddFriend ? { onAdd: onAddFriend } : {})}
              />
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
            </>
          ) : null}

          {isSelf ? (
            <>
              <ProfileFacts />
              <ProfileSubscriptions
                {...(subscriptions !== undefined ? { subscriptions } : {})}
                {...(subscriptionsError !== undefined ? { error: subscriptionsError } : {})}
              />
            </>
          ) : null}

          {isSelf ? (
            <ProfileFriends
              {...(friends !== undefined ? { page: friends } : {})}
              {...(friendsError !== undefined ? { error: friendsError } : {})}
            />
          ) : null}

          {isSelf ? (
            <ProfileCommunities
              {...(communities !== undefined ? { page: communities } : {})}
              {...(communitiesError !== undefined ? { error: communitiesError } : {})}
            />
          ) : null}

          {isSelf ? (
            <section
              className="profile-settings-overview"
              id="profile-settings"
              aria-label="Настройки"
            >
              <button type="button" onClick={() => setActiveSettings('preferences')}>
                <span className="profile-inline-icon">
                  <ProfileIcon name="preference" />
                </span>
                <span>
                  <strong>Предпочтения</strong>
                  <small>любимые станции · удобное время · история игр</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              <button type="button" onClick={() => setActiveSettings('visibility')}>
                <span className="profile-inline-icon">
                  <ProfileIcon name="eye" />
                </span>
                <span>
                  <strong>Видимость профиля</strong>
                  <small>связь и личный чат</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              <a href="/notifications">
                <span className="profile-inline-icon">
                  <ProfileIcon name="bell" />
                </span>
                <span>
                  <strong>Уведомления</strong>
                  <small>push и лента оповещений</small>
                </span>
                <i aria-hidden="true">›</i>
              </a>
            </section>
          ) : null}

          {isSelf ? (
            <section className="profile-level-scale" aria-labelledby="profile-level-scale-title">
              <span id="profile-level-scale-title">уровень игрока</span>
              <div>
                {levelScale.map((level) => (
                  <b className={level === levelKey ? 'is-active' : undefined} key={level}>
                    {level}
                  </b>
                ))}
              </div>
            </section>
          ) : null}

          {isSelf ? (
            <a className="profile-level-history-link" href="/profile/level-history">
              <span className="profile-inline-icon">
                <ProfileIcon name="history" />
              </span>
              <span>
                <strong>История изменения уровня</strong>
                <small>график по датам и уровням</small>
              </span>
              <i aria-hidden="true">›</i>
            </a>
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
            <button
              className="profile-logout"
              type="button"
              disabled={logoutBusy}
              onClick={onLogout}
            >
              {logoutBusy ? 'Выходим…' : 'Выйти из аккаунта'}
            </button>
          ) : null}
        </div>

        {isSelf && activeSettings ? (
          <div
            className="profile-settings-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setActiveSettings(null);
            }}
          >
            <section
              className="profile-settings-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="profile-settings-sheet-title"
            >
              <header className="profile-settings-sheet__toolbar">
                <button
                  type="button"
                  aria-label="Закрыть настройки"
                  onClick={() => setActiveSettings(null)}
                >
                  ‹
                </button>
                <h2 id="profile-settings-sheet-title">
                  {activeSettings === 'preferences' ? 'Предпочтения' : 'Видимость профиля'}
                </h2>
                <span aria-hidden="true" />
              </header>

              {activeSettings === 'preferences' ? (
                <BookingPreferencesSettings
                  key={bookingPreferences?.version ?? 'loading'}
                  {...(bookingPreferences !== undefined ? { settings: bookingPreferences } : {})}
                  stations={stationChoices}
                  busy={bookingPreferencesBusy}
                  {...(bookingPreferencesError !== undefined
                    ? { error: bookingPreferencesError }
                    : {})}
                  {...(bookingPreferencesNotice !== undefined
                    ? { notice: bookingPreferencesNotice }
                    : {})}
                  {...(onSaveBookingPreferences ? { onSave: onSaveBookingPreferences } : {})}
                />
              ) : (
                <PrivacySettings
                  key={privacySettings?.version ?? 'loading'}
                  {...(privacySettings !== undefined ? { settings: privacySettings } : {})}
                  busy={privacyBusy}
                  {...(privacyError !== undefined ? { error: privacyError } : {})}
                  {...(privacyNotice !== undefined ? { notice: privacyNotice } : {})}
                  {...(onSavePrivacy ? { onSave: onSavePrivacy } : {})}
                />
              )}
            </section>
          </div>
        ) : null}

        <MainBottomNavigation active="profile" gamesDestination="games" />
      </main>
    </div>
  );
}
