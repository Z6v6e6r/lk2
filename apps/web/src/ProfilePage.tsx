import type {
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  CommunityMembershipPage,
  HomeDashboard,
  PlayerProfileView,
  ProfileActionCapability,
  ProfileFriendPage,
  ProfileFriendRequestSummary,
  ProfileFriendship,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
} from '@phub/api-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { MainBottomNavigation, NotificationBellLink } from './HomeDashboardPage.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';
import { ProfilePackIcon } from './ProfilePackIcon.js';
import { ProfileSportIcon } from './ProfileSportIcon.js';
import './ProfilePageV2.css';
import { formatBalance, UNKNOWN_VALUE_PLACEHOLDER } from './profile-field-format.js';
import { QR_QUIET_ZONE_MODULES, qrCodePath, tryCreateQrCode } from './qr-code.js';
import friendshipArtwork from './assets/subscriptions/friendship-badge.png';
import raArtwork from './assets/subscriptions/ra-badge.png';
import academyArtwork from './assets/subscriptions/academy-badge.png';
import energyArtwork from './assets/subscriptions/energy-badge.png';
import kidsPadelArtwork from './assets/subscriptions/kids-padel-badge.png';
import levelABackground from './assets/profile-levels/level-a.jpg';
import levelBBackground from './assets/profile-levels/level-b.jpg';
import levelBPlusBackground from './assets/profile-levels/level-b-plus.jpg';
import levelCBackground from './assets/profile-levels/level-c.jpg';
import levelCPlusBackground from './assets/profile-levels/level-c-plus.jpg';
import levelDBackground from './assets/profile-levels/level-d.jpg';
import levelDPlusBackground from './assets/profile-levels/level-d-plus.jpg';
import squashLevelABackground from './assets/profile-sports/squash/squash-level-a.webp';
import squashLevelBBackground from './assets/profile-sports/squash/squash-level-b.webp';
import squashLevelBPlusBackground from './assets/profile-sports/squash/squash-level-b-plus.webp';
import squashLevelCBackground from './assets/profile-sports/squash/squash-level-c.webp';
import squashLevelCPlusBackground from './assets/profile-sports/squash/squash-level-c-plus.webp';
import squashLevelDBackground from './assets/profile-sports/squash/squash-level-d.webp';
import squashLevelDPlusBackground from './assets/profile-sports/squash/squash-level-d-plus.webp';

interface ProfilePageProps {
  readonly navigation?: ReactNode;
  readonly publicProfileOrigin?: string;
  readonly notificationsAvailable?: boolean;
  readonly friendsAvailable?: boolean;
  readonly subscriptionRenewalAvailable?: boolean;
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
  readonly loadCommunityPage?: (cursor?: string) => Promise<CommunityMembershipPage>;
  readonly friends?: ProfileFriendPage | null;
  readonly friendship?: ProfileFriendship | null;
  readonly friendsBusy?: boolean;
  readonly friendsError?: string | null;
  readonly friendRequests?: readonly ProfileFriendRequestSummary[];
  readonly friendRequestsError?: string | null;
  readonly friendRequestBusyId?: string | null;
  readonly error?: string | null;
  readonly onSavePrivacy?: (input: ProfilePrivacyUpdateRequest) => void;
  readonly onSaveBookingPreferences?: (input: BookingPreferencesUpdateRequest) => void;
  readonly onAddFriend?: () => void;
  readonly onRemoveFriend?: () => void;
  readonly onAcceptFriendRequest?: (requestId: string) => void;
  readonly onDeclineFriendRequest?: (requestId: string) => void;
  readonly onLogout: () => void;
}

type ProfilePageStyle = CSSProperties & {
  readonly '--profile-level-background': string;
  readonly '--profile-level-accent': string;
  readonly '--profile-level-soft': string;
};

type ProfileSport = 'PADEL' | 'SQUASH' | 'TENNIS';

const profileSportLabels: Readonly<Record<ProfileSport, string>> = {
  PADEL: 'Падел',
  SQUASH: 'Сквош',
  TENNIS: 'Теннис',
};

const profileSportChoices = [
  { sport: 'PADEL', icon: 'padel', available: true, title: 'Падел' },
  { sport: 'SQUASH', icon: 'squash', available: true, title: 'Сквош' },
  { sport: 'TENNIS', icon: 'tennis', available: true, title: 'Теннис' },
  { sport: 'BOXING', icon: 'boxing', available: false, title: 'Бокс' },
  { sport: 'BASKETBALL', icon: 'basketball', available: false, title: 'Баскетбол' },
  { sport: 'RUNNING', icon: 'running', available: false, title: 'Бег' },
] as const;

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

const squashLevelBackgrounds: Readonly<Record<string, string>> = {
  A: squashLevelABackground,
  'B+': squashLevelBPlusBackground,
  B: squashLevelBBackground,
  'C+': squashLevelCPlusBackground,
  C: squashLevelCBackground,
  'D+': squashLevelDPlusBackground,
  D: squashLevelDBackground,
};

const weekdayLabels: Readonly<
  Record<BookingPreferences['preferredTimeWindows'][number]['weekday'], string>
> = {
  ANY: 'Любой день',
  MON: 'Понедельник',
  TUE: 'Вторник',
  WED: 'Среда',
  THU: 'Четверг',
  FRI: 'Пятница',
  SAT: 'Суббота',
  SUN: 'Воскресенье',
};

const defaultPreferredTimeWindows = [
  { weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' },
] satisfies BookingPreferences['preferredTimeWindows'];

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
  const [preferredTimeWindows, setPreferredTimeWindows] = useState(
    settings.preferredTimeWindows.length > 0
      ? settings.preferredTimeWindows
      : defaultPreferredTimeWindows,
  );
  const [useHistory, setUseHistory] = useState(settings.useHistory);
  const [recommendFriends, setRecommendFriends] = useState(settings.recommendFriends);
  const [recommendationDisplay, setRecommendationDisplay] = useState(
    settings.recommendationDisplay,
  );
  const initialTimeWindows =
    settings.preferredTimeWindows.length > 0
      ? settings.preferredTimeWindows
      : defaultPreferredTimeWindows;
  const serialized = JSON.stringify({
    favoriteStationIds,
    preferredTimeWindows,
    useHistory,
    recommendFriends,
    recommendationDisplay,
  });
  const initial = JSON.stringify({
    favoriteStationIds: settings.favoriteStationIds,
    preferredTimeWindows: initialTimeWindows,
    useHistory: settings.useHistory,
    recommendFriends: settings.recommendFriends,
    recommendationDisplay: settings.recommendationDisplay,
  });
  const selectedStations = favoriteStationIds.map((stationId) => {
    const station = stations.find((item) => item.id === stationId);
    return station ?? { id: stationId, name: 'Сохранённая станция' };
  });
  const availableStations = stations.filter((station) => !favoriteStationIds.includes(station.id));

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
          recommendFriends,
          recommendationDisplay,
        });
      }}
    >
      <fieldset disabled={busy || !onSave}>
        <legend>Отображение рекомендаций</legend>
        <div className="profile-recommendation-display">
          {(
            [
              ['CARDS', 'Карточками', 'Компактная сетка Home V3'] as const,
              ['ROWS', 'Строками', 'Как на обычной главной'] as const,
            ] satisfies readonly (readonly [
              BookingPreferences['recommendationDisplay'],
              string,
              string,
            ])[]
          ).map(([value, title, description]) => (
            <label key={value}>
              <input
                type="radio"
                name="recommendation-display"
                value={value}
                checked={recommendationDisplay === value}
                onChange={() => setRecommendationDisplay(value)}
              />
              <span className={`profile-recommendation-display__preview is-${value.toLowerCase()}`}>
                <i />
                <i />
                <i />
                <i />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={busy || !onSave}>
        <legend>Любимые станции</legend>
        {stations.length === 0 && selectedStations.length === 0 ? (
          <p>Станции появятся после загрузки доступных игр.</p>
        ) : (
          <>
            <div className="profile-station-options">
              {selectedStations.length === 0 ? (
                <span className="profile-station-options__empty">Пока не выбраны</span>
              ) : null}
              {selectedStations.map((station) => (
                <span className="profile-station-option" key={station.id}>
                  {station.name}
                  <button
                    type="button"
                    aria-label={`Удалить станцию ${station.name}`}
                    onClick={() =>
                      setFavoriteStationIds((current) =>
                        current.filter((stationId) => stationId !== station.id),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {stations.length === 0 ? (
              <p>Другие станции появятся после загрузки доступных игр.</p>
            ) : (
              <select
                className="profile-station-select"
                aria-label="Добавить любимую станцию"
                value=""
                disabled={
                  busy ||
                  !onSave ||
                  favoriteStationIds.length >= 3 ||
                  availableStations.length === 0
                }
                onChange={(event) => {
                  const stationId = event.currentTarget.value;
                  if (!stationId) return;
                  setFavoriteStationIds((current) => [...current, stationId]);
                }}
              >
                <option value="">
                  {favoriteStationIds.length >= 3
                    ? 'Можно выбрать до 3 станций'
                    : 'Добавить станцию'}
                </option>
                {availableStations.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </fieldset>

      <fieldset disabled={busy || !onSave}>
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
          disabled={busy || !onSave || preferredTimeWindows.length >= 14}
          onClick={() =>
            setPreferredTimeWindows((current) => [
              ...current,
              { weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' },
            ])
          }
        >
          Добавить интервал
        </button>
        <p className="profile-time-windows__hint">
          Базовый интервал — 09:00–22:00. История завершённых игр уточняет порядок рекомендаций.
        </p>
      </fieldset>

      <div className="profile-recommendation-toggles">
        <label className="profile-privacy-toggle">
          <span>
            <strong>Учитывать историю игр</strong>
            <small>Только завершённые игры за последние 180 дней</small>
          </span>
          <input
            type="checkbox"
            checked={useHistory}
            disabled={busy || !onSave}
            onChange={(event) => setUseHistory(event.currentTarget.checked)}
          />
        </label>

        <label className="profile-privacy-toggle">
          <span>
            <strong>Рекомендовать события с друзьями</strong>
            <small>Поднимать выше события, в которых участвуют мои друзья</small>
          </span>
          <input
            type="checkbox"
            checked={recommendFriends}
            disabled={busy || !onSave}
            onChange={(event) => setRecommendFriends(event.currentTarget.checked)}
          />
        </label>
      </div>

      <div className="profile-privacy-save-row">
        <p role={error ? 'alert' : notice ? 'status' : undefined}>
          {error ?? notice ?? (!onSave ? 'Настройки доступны для просмотра.' : null)}
        </p>
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
    | 'edit'
    | 'settings'
    | 'wallet'
    | 'logout'
    | 'calendar'
    | 'about'
    | 'trophy'
    | 'lock'
    | 'support'
    | 'back'
    | 'bell'
    | 'share'
    | 'community'
    | 'friends'
    | 'preference'
    | 'history'
    | 'eye'
    | 'city'
    | 'subscriptions'
    | 'qr';
}): React.JSX.Element {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
  } as const;

  switch (name) {
    case 'wallet':
      return (
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2" />
          <path d="M21 11h-5a3 3 0 0 0 0 6h5" />
          <circle cx="16" cy="14" r=".8" fill="currentColor" />
        </svg>
      );
    case 'logout':
      return (
        <svg
          {...common}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5m5-12 4 4-4 4M8 12h11" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d="m9.5 3-.6 2.1-1.6.9-2.1-.5-2.5 4.3 1.5 1.6v1.8l-1.5 1.6 2.5 4.3 2.1-.5 1.6.9.6 2.1h5l.6-2.1 1.6-.9 2.1.5 2.5-4.3-1.5-1.6v-1.8l1.5-1.6-2.5-4.3-2.1.5-1.6-.9-.6-2.1Z" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M8 3v4m8-4v4M4 10h16" />
        </svg>
      );
    case 'about':
      return (
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" />
          <circle cx="12" cy="7.5" r=".8" fill="currentColor" />
        </svg>
      );
    case 'trophy':
      return (
        <svg
          {...common}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 3h8v7a4 4 0 0 1-8 0ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 14v6m-4 1h8" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="5" y="10" width="14" height="11" rx="3" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...common}>
          <path
            d="m14 5 5 5M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'support':
      return (
        <svg {...common}>
          <path
            d="M4 13v-2a8 8 0 0 1 16 0v6a4 4 0 0 1-4 4h-3M4 12H3v6h4v-6H4ZM20 12h1v6h-4v-6h3Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M10 20h4v2h-4z" fill="currentColor" />
        </svg>
      );
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
        <svg
          {...common}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.59 13.51 6.83 3.98m-.01-10.98-6.82 3.98" />
        </svg>
      );
    case 'friends':
      return (
        <svg
          {...common}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="7" r="4" />
          <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
        </svg>
      );
    case 'community':
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
        <svg {...common} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" />
          <circle cx="9" cy="6" r="2" />
          <circle cx="15" cy="12" r="2" />
          <circle cx="9" cy="18" r="2" />
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
    case 'subscriptions':
      return (
        <svg {...common} viewBox="0 0 32 32" fill="#FF641C" focusable="false">
          <path d="M5.67 9 C5.95 7.73 6.90 6.99 8.10 6.78 L24.40 3.90 C26.13 3.60 27.44 4.76 27.73 6.42 L29.65 16.95 C29.97 18.72 28.85 19.94 27.05 20.34 V13.75 C27.05 11.13 24.94 9 22.32 9 Z" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M5 11 H22.333 A3 3 0 0 1 25.333 14 V25.167 A3 3 0 0 1 22.333 28.167 H5 A3 3 0 0 1 2 25.167 V14 A3 3 0 0 1 5 11 Z M14.84 14.96 H17.35 Q17.54 14.96 17.45 15.13 L15.68 18.54 H20 Q20.22 18.54 20.10 18.75 L19.17 20.55 Q19.08 20.71 18.90 20.71 H14.56 Q14.37 20.71 14.27 20.89 L12.40 24.60 Q12.30 24.83 12.04 24.83 H9.50 Q9.34 24.83 9.43 24.65 L11.36 20.84 Q11.43 20.71 11.27 20.71 H7.01 Q6.85 20.71 6.94 20.56 L8.03 18.75 Q8.16 18.54 8.36 18.54 H12.51 Q12.71 18.54 12.81 18.36 L14.58 15.15 Q14.68 14.96 14.84 14.96 Z"
          />
        </svg>
      );
    case 'qr':
      return (
        <svg {...common}>
          <path
            d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M14 14h2.4v2.4H14zM17.6 17.6h2.4V20h-2.4zM14 17.6h2.4V20H14zM17.6 14h2.4v2.4h-2.4z"
            fill="currentColor"
          />
        </svg>
      );
  }
}

/**
 * Renders the share link as a scannable QR symbol. The link itself is the same deep link the
 * "поделиться" action sends, so a scanned profile opens behind the normal login flow.
 */
function ProfileShareQrCode({ value }: { readonly value: string }): React.JSX.Element | null {
  const qr = useMemo(() => tryCreateQrCode(value), [value]);
  if (!qr) return null;
  const dimension = qr.size + QR_QUIET_ZONE_MODULES * 2;

  return (
    <svg
      className="profile-qr-code"
      viewBox={`0 0 ${dimension} ${dimension}`}
      role="img"
      aria-label={`QR-код ссылки на профиль: ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={dimension} height={dimension} fill="#ffffff" />
      <path d={qrCodePath(qr)} fill="#1f1e20" />
    </svg>
  );
}

const profileCities = ['Москва', 'Питер', 'Сочи', 'Завидово'] as const;
type ProfileCity = (typeof profileCities)[number];
type ProfileChoice = 'city' | 'sport' | null;
type ProfileChoiceState = {
  readonly userId: string;
  readonly isSelf: boolean;
  readonly city: ProfileCity;
  readonly open: ProfileChoice;
};

function readProfileCity(userId: string): ProfileCity {
  try {
    const value = window.localStorage.getItem(`lk2:profile:city:${userId}`);
    return profileCities.find((city) => city === value) ?? 'Москва';
  } catch {
    return 'Москва';
  }
}

function ProfileV2Actions({
  notificationsAvailable,
  unreadCount,
  onQr,
}: {
  readonly notificationsAvailable: boolean;
  readonly unreadCount: number;
  readonly onQr: () => void;
}): React.JSX.Element {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details
      className="profile-v2-actions"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (menu.current) {
            menu.current.open = false;
            menu.current.querySelector('summary')?.focus();
          }
        }
      }}
    >
      <summary aria-label="Настройки профиля" title="Настройки профиля">
        <ProfileIcon name="settings" />
      </summary>
      <div className="profile-v2-actions__menu">
        <a
          href="#profile-settings"
          onClick={() => {
            if (menu.current) menu.current.open = false;
          }}
        >
          <ProfileIcon name="settings" />
          Настройки
        </a>
        {notificationsAvailable ? (
          <a
            href="/notifications"
            className={
              unreadCount > 0 ? 'profile-v2-notifications is-unread' : 'profile-v2-notifications'
            }
            aria-label={
              unreadCount > 0
                ? `Уведомления, непрочитанных: ${unreadCount}`
                : 'Уведомления, непрочитанных нет'
            }
          >
            <ProfilePackIcon name="bell" />
            Уведомления
            {unreadCount > 0 ? (
              <span className="profile-v2-unread-count" aria-hidden="true">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
          </a>
        ) : null}
        <a href="/support" aria-label="Техническая поддержка">
          <ProfileIcon name="support" />
          Поддержка
        </a>
        <button
          type="button"
          aria-label="QR-код"
          onClick={() => {
            onQr();
            if (menu.current) menu.current.open = false;
          }}
        >
          <ProfileIcon name="qr" />
          QR-код
        </button>
      </div>
    </details>
  );
}

function ProfileDirectorySheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const sheet = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div
      className="profile-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="profile-settings-sheet profile-v2-directory"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheet}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const controls = sheet.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href]',
          );
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="profile-settings-sheet__toolbar">
          <button ref={close} type="button" aria-label={`Закрыть: ${title}`} onClick={onClose}>
            ‹
          </button>
          <h2>{title}</h2>
          <span aria-hidden="true" />
        </header>
        {children}
      </section>
    </div>
  );
}

function ProfileV2Overview({
  friends,
  communities,
  friendsAvailable,
  onFriends,
  onCommunities,
}: {
  readonly friends?: ProfileFriendPage | null;
  readonly communities?: CommunityMembershipPage | null;
  readonly friendsAvailable: boolean;
  readonly onFriends: () => void;
  readonly onCommunities: () => void;
}): React.JSX.Element {
  const loadedFriends = friends?.items.length;
  const loadedCommunities = communities?.items.length;
  // Neither contract contains a total. A plus only reports a known lower bound.
  const friendCount =
    loadedFriends === undefined || !friendsAvailable
      ? '—'
      : loadedFriends === 0
        ? '0'
        : `${loadedFriends}+`;
  const communityCount =
    loadedCommunities === undefined
      ? '—'
      : `${loadedCommunities}${communities?.nextCursor ? '+' : ''}`;
  return (
    <section className="profile-v2-metrics" aria-label="Показатели игрока">
      <a href="/bookings" aria-label="Мои игры: общее число пока недоступно">
        <ProfileIcon name="calendar" />
        <strong>—</strong>
        <span>мои игры</span>
      </a>
      <a
        href="/bookings?scope=history&amp;kind=TOURNAMENT"
        aria-label="Турниры: общее число пока недоступно"
      >
        <ProfileIcon name="trophy" />
        <strong>—</strong>
        <span>турниры</span>
      </a>
      <button
        type="button"
        disabled={!friendsAvailable}
        onClick={onFriends}
        aria-label={
          loadedFriends === undefined || !friendsAvailable
            ? 'Открыть друзей: число неизвестно'
            : `Открыть друзей: загружено ${loadedFriends}, общее число неизвестно`
        }
      >
        <ProfilePackIcon name="friends" />
        <strong>{friendCount}</strong>
        <span>друзей</span>
      </button>
      <button
        type="button"
        onClick={onCommunities}
        aria-label={`Открыть мои сообщества: ${communityCount === '—' ? 'число неизвестно' : communityCount}`}
      >
        <ProfilePackIcon name="community" />
        <strong>{communityCount}</strong>
        <span>сообщества</span>
      </button>
    </section>
  );
}

function ProfileBalanceCard({ balance }: { readonly balance: string | null }): React.JSX.Element {
  const [informationOpen, setInformationOpen] = useState(false);

  return (
    <section className="profile-balance-card" aria-labelledby="profile-balance-title">
      <div className="profile-balance-card__amount" aria-label="Данные профиля">
        <span className="profile-balance-card__symbol">
          <ProfilePackIcon name="wallet" />
        </span>
        <h2 id="profile-balance-title">Баланс</h2>
        <strong>{balance ?? UNKNOWN_VALUE_PLACEHOLDER}</strong>
      </div>
      <button
        className="profile-balance-card__topup"
        type="button"
        disabled
        aria-label="Пополнить баланс — пока недоступно"
        title="Пополнение пока недоступно"
      >
        Пополнить
      </button>
      <button
        className="profile-balance-card__info"
        type="button"
        aria-label="Информация о балансе"
        aria-expanded={informationOpen}
        aria-controls="profile-balance-information"
        title="Информация о балансе"
        onClick={() => setInformationOpen((open) => !open)}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
          <path d="M12 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="12" cy="7.5" r="1" fill="currentColor" />
        </svg>
      </button>
      <p id="profile-balance-information" hidden={!informationOpen}>
        Текущий баланс вашего счёта в ПадлхАБ.
      </p>
    </section>
  );
}

function ProfileFacts({
  city,
  sport,
  openChoice,
  onChooseCity,
  onChooseSport,
}: {
  readonly city: ProfileCity;
  readonly sport: ProfileSport;
  readonly openChoice: ProfileChoice;
  readonly onChooseCity: () => void;
  readonly onChooseSport?: () => void;
}): React.JSX.Element {
  const sportLabel = profileSportLabels[sport];

  return (
    <section className="profile-facts" aria-label="Город и вид спорта">
      <button
        className="profile-fact-action"
        type="button"
        aria-label={`Город: ${city}`}
        aria-haspopup="dialog"
        aria-expanded={openChoice === 'city'}
        aria-controls={openChoice === 'city' ? 'profile-city-sheet' : undefined}
        onClick={onChooseCity}
      >
        <span className="profile-inline-icon">
          <ProfilePackIcon name="city" />
        </span>
        <span>
          <small>город</small>
          <strong>{city}</strong>
        </span>
        <i aria-hidden="true">›</i>
      </button>
      <button
        className="profile-fact-action"
        aria-haspopup={onChooseSport ? 'dialog' : undefined}
        aria-expanded={onChooseSport ? openChoice === 'sport' : undefined}
        aria-controls={openChoice === 'sport' ? 'profile-sport-sheet' : undefined}
        aria-label={onChooseSport ? `Вид спорта: ${sportLabel}` : undefined}
        type="button"
        onClick={onChooseSport}
      >
        <span className="profile-inline-icon">
          <ProfileSportIcon sport={sport.toLowerCase() as Lowercase<ProfileSport>} />
        </span>
        <span>
          <small>вид спорта</small>
          <strong>{sportLabel}</strong>
        </span>
        <i aria-hidden="true">›</i>
      </button>
    </section>
  );
}

function ProfileChoiceSheet({
  id,
  title,
  closeLabel,
  onClose,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <div
      className="profile-sport-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={sheetRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const buttons =
            sheetRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          const first = buttons?.[0];
          const last = buttons?.[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        id={id}
        className="profile-sport-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <header>
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
          </div>
          <button ref={closeRef} type="button" aria-label={closeLabel} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function CityPicker({
  city,
  onClose,
  onSelect,
}: {
  readonly city: ProfileCity;
  readonly onClose: () => void;
  readonly onSelect: (city: ProfileCity) => void;
}): React.JSX.Element {
  return (
    <ProfileChoiceSheet
      id="profile-city-sheet"
      title="Выберите город"
      closeLabel="Закрыть выбор города"
      onClose={onClose}
    >
      {profileCities.map((item) => (
        <button
          key={item}
          type="button"
          aria-label={item}
          aria-pressed={item === city}
          className={item === city ? 'is-active' : undefined}
          onClick={() => onSelect(item)}
        >
          <span className="profile-sport-option__mark" aria-hidden="true">
            <ProfilePackIcon name="city" />
          </span>
          <span>
            <strong>{item}</strong>
          </span>
          {item === city ? <em aria-hidden="true">выбран</em> : <i aria-hidden="true">›</i>}
        </button>
      ))}
    </ProfileChoiceSheet>
  );
}

function SportPicker({
  activeSport,
  onClose,
  onSelect,
}: {
  readonly activeSport: ProfileSport;
  readonly onClose: () => void;
  readonly onSelect: (sport: ProfileSport) => void;
}): React.JSX.Element {
  return (
    <ProfileChoiceSheet
      id="profile-sport-sheet"
      title="Выберите вид спорта"
      closeLabel="Закрыть выбор спорта"
      onClose={onClose}
    >
      {profileSportChoices.map((option) => (
        <button
          aria-label={option.available ? option.title : `${option.title} — пока недоступен`}
          className={option.sport === activeSport ? 'is-active' : undefined}
          key={option.sport}
          type="button"
          disabled={!option.available}
          onClick={() => {
            if (option.available) onSelect(option.sport);
          }}
        >
          <span className="profile-sport-option__mark" aria-hidden="true">
            <ProfileSportIcon sport={option.icon} />
          </span>
          <span>
            <strong>{option.title}</strong>
            <small>
              {!option.available
                ? 'Пока недоступен'
                : option.sport === 'PADEL'
                  ? 'Текущий кабинет ПадлхАБ'
                  : 'Отдельный спортивный профиль'}
            </small>
          </span>
          {option.sport === activeSport ? (
            <em>выбран</em>
          ) : option.available ? (
            <i aria-hidden="true">›</i>
          ) : null}
        </button>
      ))}
    </ProfileChoiceSheet>
  );
}

function IndependentSportProfileContent({
  sport,
}: {
  readonly sport: Exclude<ProfileSport, 'PADEL'>;
}): React.JSX.Element {
  const sportLabel = profileSportLabels[sport];
  const sportInPrepositional = sport === 'SQUASH' ? 'сквошу' : 'теннису';

  return (
    <>
      <section className="profile-sport-intro" aria-labelledby="independent-sport-profile-title">
        <span className="profile-sport-intro__eyebrow">{sportLabel}</span>
        <h2 id="independent-sport-profile-title">Отдельный спортивный профиль</h2>
        <p>
          Уровень, сообщества, история матчей и рекомендации по {sportInPrepositional} не
          смешиваются с падел-кабинетом.
        </p>
      </section>
      <section className="profile-sport-empty" aria-labelledby="independent-sport-data-title">
        <span className="profile-inline-icon">
          <ProfileIcon name="community" />
        </span>
        <div>
          <h2 id="independent-sport-data-title">Данные появятся здесь</h2>
          <p>
            После подключения профиля здесь будут доступны только уровни и сообщества по виду
            спорта.
          </p>
        </div>
      </section>
    </>
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

// User-supplied plan badges. Exact display titles select artwork only, never entitlements.
// Viewports exclude transparent canvas padding; the original PNG pixel streams are unchanged.
type SubscriptionBadge = {
  readonly src: string;
  readonly viewport: readonly [x: number, y: number, width: number, height: number];
};

const subscriptionPlanArtwork = new Map<string, SubscriptionBadge>([
  ['дружба', { src: friendshipArtwork, viewport: [124, 164, 1924, 385] }],
  ['ра', { src: raArtwork, viewport: [532, 189, 1106, 344] }],
  ['академия', { src: academyArtwork, viewport: [124, 195, 1924, 325] }],
  ['энергия', { src: energyArtwork, viewport: [118, 191, 1937, 322] }],
  ['дети падел', { src: kidsPadelArtwork, viewport: [167, 222, 1838, 297] }],
]);

function subscriptionBadgeStyle([
  x,
  y,
  width,
  height,
]: SubscriptionBadge['viewport']): CSSProperties {
  // All five supplied PNG canvases are 2172 × 724; only their display viewport differs.
  return {
    '--profile-badge-ratio': width / height,
    '--profile-badge-image-width': `${(2172 / width) * 100}%`,
    '--profile-badge-image-left': `${(-x / width) * 100}%`,
    '--profile-badge-image-top': `${(-y / height) * 100}%`,
  } as CSSProperties;
}

function ProfileSubscriptions({
  subscriptions,
  error,
  renewalAvailable = true,
}: {
  readonly subscriptions?: HomeDashboard['subscriptions'] | null;
  readonly error?: string | null;
  readonly renewalAvailable?: boolean;
}): React.JSX.Element {
  const current =
    subscriptions
      ?.filter((subscription) => ['active', 'scheduled', 'paused'].includes(subscription.status))
      .slice(0, 2) ?? [];

  return (
    <section className="profile-subscriptions" aria-labelledby="profile-subscriptions-title">
      <header>
        <span className="profile-inline-icon">
          <ProfileIcon name="subscriptions" />
        </span>
        <h2 id="profile-subscriptions-title">Подписки и абонементы</h2>
      </header>

      <p className="profile-subscriptions-note">Неполная подборка с Главной: до 6 абонементов.</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !subscriptions ? (
        <p role="status">Загружаем действующие подписки…</p>
      ) : current.length === 0 ? (
        <p>В текущей подборке нет действующих абонементов.</p>
      ) : (
        <div className="profile-subscription-list">
          {current.map((subscription) => {
            const validUntil = subscriptionDate(subscription.validUntil);
            const artwork = subscriptionPlanArtwork.get(
              subscription.title.trim().toLocaleLowerCase('ru-RU'),
            );
            return (
              <article
                className={artwork ? 'has-plan-artwork' : undefined}
                data-plan={
                  artwork ? subscription.title.trim().toLocaleLowerCase('ru-RU') : 'generic'
                }
                key={subscription.id}
              >
                <span className="profile-subscription-copy">
                  <span>
                    <strong
                      className={artwork ? 'profile-subscription-badge' : undefined}
                      style={artwork ? subscriptionBadgeStyle(artwork.viewport) : undefined}
                    >
                      {artwork ? (
                        <img
                          className="profile-subscription-badge__image"
                          src={artwork.src}
                          alt={subscription.title}
                        />
                      ) : (
                        subscription.title
                      )}
                    </strong>
                    {subscription.status === 'active' ? <em>активна</em> : null}
                  </span>
                  <small>
                    {subscription.remainingUnits > 0
                      ? `Остаток: ${subscription.remainingUnits} · единица не указана`
                      : 'Остаток не подтверждён'}
                    {validUntil ? ` · до ${validUntil}` : ' · срок не указан'}
                  </small>
                </span>
                <a
                  className="profile-subscription-open"
                  href={`/subscriptions/${subscription.id}`}
                  aria-label={`${renewalAvailable ? 'Открыть подписку' : 'Подробнее о подписке'}: ${subscription.title}`}
                >
                  <span aria-hidden="true">›</span>
                </a>
              </article>
            );
          })}
        </div>
      )}

      <a className="profile-subscriptions-all" href="/subscriptions">
        Мои абонементы
      </a>
    </section>
  );
}

function ProfileCommunities({
  page,
  error,
  loadPage,
}: {
  readonly page?: CommunityMembershipPage | null;
  readonly error?: string | null;
  readonly loadPage?: (cursor?: string) => Promise<CommunityMembershipPage>;
}): React.JSX.Element {
  const communities = page?.items ?? [];

  return (
    <section className="profile-communities" aria-labelledby="profile-communities-title">
      <header>
        <span className="profile-inline-icon">
          <ProfilePackIcon name="community" />
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
        <ProfileCommunityRail initialPage={page} {...(loadPage ? { loadPage } : {})} />
      )}
    </section>
  );
}

function ProfileCommunityRail({
  initialPage,
  loadPage,
}: {
  readonly initialPage: CommunityMembershipPage;
  readonly loadPage?: (cursor?: string) => Promise<CommunityMembershipPage>;
}): React.JSX.Element {
  const [page, setPage] = useState(initialPage);
  const [source, setSource] = useState(() => ({ initialPage, loadPage }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef<symbol | null>(null);
  const communities = page.items;

  useEffect(() => {
    generation.current = Symbol();
    inFlight.current = false;
    return () => {
      generation.current = null;
    };
  }, [initialPage, loadPage]);

  if (source.initialPage !== initialPage || source.loadPage !== loadPage) {
    setSource({ initialPage, loadPage });
    setPage(initialPage);
    setBusy(false);
    setError(null);
  }

  function loadMore(): void {
    if (!loadPage || !page.nextCursor || inFlight.current) return;
    const requestGeneration = generation.current;
    const cursor = page.nextCursor;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void loadPage(cursor).then(
      (next) => {
        if (generation.current !== requestGeneration) return;
        setPage((current) => {
          const byId = new Map(current.items.map((item) => [item.id, item]));
          next.items.forEach((item) => byId.set(item.id, item));
          return {
            items: [...byId.values()],
            ...(next.nextCursor && next.nextCursor !== cursor
              ? { nextCursor: next.nextCursor }
              : {}),
          };
        });
        inFlight.current = false;
        setBusy(false);
      },
      () => {
        if (generation.current !== requestGeneration) return;
        inFlight.current = false;
        setBusy(false);
        setError('Не удалось догрузить сообщества.');
      },
    );
  }

  return (
    <>
      <div
        className="profile-community-list"
        role="region"
        aria-label="Мои сообщества"
        tabIndex={0}
        aria-busy={busy}
        onScroll={(event) => {
          const rail = event.currentTarget;
          if (!error && rail.scrollWidth - rail.scrollLeft - rail.clientWidth <= 116) loadMore();
        }}
      >
        {communities.map((community) => {
          // The ranking source is queried for one community at a time, never for the whole
          // preview, so an absent place means "not published", not "outside the rating".
          const rankLabel = community.memberRank ? `${community.memberRank} место` : null;
          return (
            <a
              href={community.route}
              key={community.id}
              aria-label={rankLabel ? `${community.title}, ${rankLabel}` : community.title}
            >
              <span>
                {community.logoUrl ? (
                  <img src={community.logoUrl} alt="" loading="lazy" />
                ) : (
                  communityInitials(community.title)
                )}
              </span>
              <small>{community.title}</small>
              {rankLabel ? <em>{rankLabel}</em> : null}
              {community.unreadChatCount > 0 ? <b>{community.unreadChatCount}</b> : null}
            </a>
          );
        })}
        {loadPage && page.nextCursor ? (
          <button
            className="profile-community-more"
            type="button"
            disabled={busy}
            onClick={loadMore}
          >
            {busy ? 'Загружаем…' : error ? 'Повторить' : 'Показать ещё'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="profile-community-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function ProfileFriends({
  page,
  error,
  requests,
  requestsError,
  friendRequestBusyId = null,
  onAcceptRequest,
  onDeclineRequest,
}: {
  readonly page?: ProfileFriendPage | null;
  readonly error?: string | null;
  readonly requests?: readonly ProfileFriendRequestSummary[];
  readonly requestsError?: string | null;
  readonly friendRequestBusyId?: string | null;
  readonly onAcceptRequest?: (requestId: string) => void;
  readonly onDeclineRequest?: (requestId: string) => void;
}): React.JSX.Element {
  // The row scrolls horizontally, so every friend is reachable by swiping instead of being cut off
  // after the first four.
  const friends = page?.items ?? [];
  const incoming = requests ?? [];
  return (
    <section className="profile-friends" aria-labelledby="profile-friends-title">
      <header>
        <span className="profile-inline-icon">
          <ProfilePackIcon name="friends" />
        </span>
        <h2 id="profile-friends-title">Друзья</h2>
        {page ? <span>{page.items.length}</span> : null}
      </header>
      {requestsError ? <p role="alert">{requestsError}</p> : null}
      {incoming.length > 0 ? (
        <section
          className="profile-friend-requests"
          aria-labelledby="profile-friend-requests-title"
        >
          <div className="profile-friend-requests-heading">
            <h3 id="profile-friend-requests-title">Заявки в друзья</h3>
            <span aria-label={`Новых заявок: ${incoming.length}`}>{incoming.length}</span>
          </div>
          <ul className="profile-friend-request-list">
            {incoming.map((request) => (
              <li key={request.requestId}>
                <a href={request.route}>
                  <ParticipantAvatarStack
                    ariaLabel={request.displayName}
                    capacity={1}
                    participants={[
                      {
                        key: request.userId,
                        displayName: request.displayName,
                        avatarUrl: request.avatarUrl,
                        level: request.levelLabel,
                      },
                    ]}
                  />
                  <span className="profile-friend-request-person">
                    <strong>{request.displayName}</strong>
                    <small>хочет добавить вас в друзья</small>
                  </span>
                </a>
                <div className="profile-friend-request-actions">
                  <button
                    type="button"
                    disabled={friendRequestBusyId !== null}
                    onClick={() => onAcceptRequest?.(request.requestId)}
                  >
                    {friendRequestBusyId === request.requestId ? 'Добавляем…' : 'Добавить'}
                  </button>
                  <button
                    type="button"
                    className="profile-friend-request-decline"
                    disabled={friendRequestBusyId !== null}
                    onClick={() => onDeclineRequest?.(request.requestId)}
                  >
                    Отказаться
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
  reachable = true,
  onAdd,
  onAccept,
  onRemove,
}: {
  readonly friendship?: ProfileFriendship | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly reachable?: boolean;
  readonly onAdd?: () => void;
  readonly onRemove?: () => void;
  readonly onAccept?: (requestId: string) => void;
}): React.JSX.Element {
  const status = friendship?.status ?? 'NONE';
  const isFriend = status === 'FRIEND';
  const isOutgoing = status === 'PENDING_OUTGOING';
  const isIncoming = status === 'PENDING_INCOMING';
  const isDeferred = status === 'PENDING_DEFERRED';
  const title = isFriend
    ? 'Уже в друзьях'
    : isOutgoing
      ? 'Заявка отправлена'
      : isDeferred
        ? 'Заявка сохранена'
        : isIncoming
          ? 'Заявка в друзья'
          : 'Добавить в друзья';
  const unreachable = !reachable && !isFriend && !isIncoming && !isDeferred;
  const description = isDeferred
    ? 'Отправим заявку, когда игрок войдёт в приложение'
    : unreachable
      ? 'Игрок ещё не входил в приложение: заявку сохраним и отправим, когда он войдёт'
      : isFriend
        ? 'Игрок отображается в вашем блоке друзей'
        : isOutgoing
          ? 'Игрок увидит заявку в уведомлениях'
          : isIncoming
            ? 'Этот игрок хочет добавить вас в друзья'
            : 'Игрок получит заявку в уведомлениях';
  const acceptRequestId = isIncoming ? friendship?.requestId : null;
  const disabledByState = isOutgoing || isDeferred;
  const handleClick = isFriend
    ? onRemove
    : isIncoming
      ? acceptRequestId
        ? () => onAccept?.(acceptRequestId)
        : undefined
      : onAdd;

  return (
    <section className="profile-friendship-action" aria-labelledby="profile-friendship-title">
      <span className="profile-inline-icon">
        <ProfileIcon name="friends" />
      </span>
      <span>
        <strong id="profile-friendship-title">{title}</strong>
        <small>{description}</small>
      </span>
      <button
        type="button"
        disabled={busy || disabledByState || !friendship || !handleClick}
        onClick={handleClick}
        aria-label={isFriend ? 'Удалить из друзей' : undefined}
      >
        {busy
          ? isFriend
            ? 'Удаляем…'
            : isIncoming
              ? 'Принимаем…'
              : 'Отправляем…'
          : isFriend
            ? 'Удалить'
            : isDeferred
              ? 'Ожидает входа игрока'
              : isOutgoing
                ? 'Ожидает ответа'
                : isIncoming
                  ? 'Принять заявку'
                  : 'Добавить'}
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
    case 'FEATURE_UNAVAILABLE':
      return 'Действие скоро появится.';
    case 'TARGET_UNREACHABLE':
      return 'Игрок ещё не входил в приложение — заявка и сообщения не дойдут.';
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
          disabled={busy || !onSave}
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
          disabled={busy || !onSave}
          onChange={(event) => setChatAllowed(event.currentTarget.checked)}
        />
      </label>
      <div className="profile-privacy-save-row">
        <p role={error ? 'alert' : notice ? 'status' : undefined}>
          {error ?? notice ?? (!onSave ? 'Настройки доступны для просмотра.' : null)}
        </p>
        <button type="submit" disabled={busy || !changed || !onSave}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}

/**
 * Absolute deep link a recipient can open — and log in through — to reach this profile. Sharing
 * the address bar instead would leak the sharer's current hash or query state.
 */
function profileShareUrl(userId: string, origin = window.location.origin): string {
  const path = `/profile/${encodeURIComponent(userId)}`;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

export function ProfilePage({
  navigation,
  publicProfileOrigin,
  notificationsAvailable = true,
  friendsAvailable = true,
  subscriptionRenewalAvailable = true,
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
  loadCommunityPage,
  friends,
  friendship,
  friendsBusy = false,
  friendsError,
  friendRequests,
  friendRequestsError,
  friendRequestBusyId = null,
  error,
  onSavePrivacy,
  onSaveBookingPreferences,
  onAddFriend,
  onRemoveFriend,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onLogout,
}: ProfilePageProps): React.JSX.Element {
  const { profile, privateAccount, access } = view;
  const isSelf = access.audience === 'SELF';
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrNotice, setQrNotice] = useState<string | null>(null);
  const [activeSettings, setActiveSettings] = useState<'preferences' | 'visibility' | null>(null);
  const [activeSport, setActiveSport] = useState<ProfileSport>('PADEL');
  const [choices, setChoices] = useState<ProfileChoiceState>(() => ({
    userId: profile.userId,
    isSelf,
    city: isSelf ? readProfileCity(profile.userId) : 'Москва',
    open: null,
  }));
  const [activeDirectory, setActiveDirectory] = useState<'friends' | 'communities' | null>(null);
  // Reset before committing a different profile, as the formerly keyed facts did.
  if (choices.userId !== profile.userId || choices.isSelf !== isSelf) {
    setChoices({
      userId: profile.userId,
      isSelf,
      city: isSelf ? readProfileCity(profile.userId) : 'Москва',
      open: null,
    });
  }
  const openChoice =
    isSelf && choices.userId === profile.userId && choices.isSelf ? choices.open : null;
  const city = !isSelf
    ? 'Москва'
    : choices.userId === profile.userId && choices.isSelf
      ? choices.city
      : readProfileCity(profile.userId);
  const profileLink = profileShareUrl(profile.userId, publicProfileOrigin);
  const independentSport: Exclude<ProfileSport, 'PADEL'> | null =
    activeSport === 'PADEL' ? null : activeSport;
  const isIndependentSport = independentSport !== null;
  const balance = privateAccount
    ? formatBalance(privateAccount.balanceMinor, privateAccount.currency, 'currency')
    : null;
  // A locally served profile may omit the level until a stored assessment
  // exists; render an explicit placeholder instead of claiming level D.
  const hasLevel = !isIndependentSport && profile.level !== undefined;
  const rating = hasLevel ? profile.level?.value : undefined;
  const levelKey = !hasLevel
    ? 'A'
    : profile.level && levelBackgrounds[profile.level.label]
      ? profile.level.label
      : 'A';
  const displayLevel = isIndependentSport
    ? '?'
    : profile.level
      ? profile.level.assessmentRequired
        ? '?'
        : profile.level.label
      : UNKNOWN_VALUE_PLACEHOLDER;
  const background =
    activeSport === 'TENNIS'
      ? 'linear-gradient(145deg, #daefb6, #f7fbe8)'
      : `url("${
          activeSport === 'SQUASH'
            ? (squashLevelBackgrounds[levelKey] ?? squashLevelABackground)
            : (levelBackgrounds[levelKey] ?? levelABackground)
        }")`;
  const pageStyle: ProfilePageStyle = {
    '--profile-level-background': background,
    '--profile-level-accent':
      activeSport === 'SQUASH'
        ? '#7150ef'
        : activeSport === 'TENNIS'
          ? '#4f772f'
          : (levelAccents[levelKey] ?? levelAccents.A ?? '#7650f4'),
    '--profile-level-soft': isIndependentSport
      ? activeSport === 'TENNIS'
        ? '#f2f7e7'
        : '#eeeaff'
      : (levelSoftTones[levelKey] ?? levelSoftTones.A ?? '#eeeaff'),
  };

  useEffect(() => {
    if (!isSelf || isIndependentSport) return;
    const openDeepLinkedSettings = (): void => {
      if (window.location.hash === '#booking-preferences-title') {
        setActiveSettings('preferences');
      }
    };
    openDeepLinkedSettings();
    window.addEventListener('hashchange', openDeepLinkedSettings);
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings);
  }, [isIndependentSport, isSelf]);

  useEffect(() => {
    if (!qrOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setQrOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [qrOpen]);

  async function shareProfile(): Promise<void> {
    try {
      if (navigator.share) {
        await navigator.share({ title: profile.displayName, url: profileLink });
        setShareNotice('Профиль отправлен');
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(profileLink);
        setShareNotice('Ссылка на профиль скопирована');
      } else {
        setShareNotice(`Скопируйте ссылку: ${profileLink}`);
      }
    } catch (shareError: unknown) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
      setShareNotice('Не удалось поделиться профилем');
    }
  }

  async function copyProfileLink(): Promise<void> {
    if (!navigator.clipboard) {
      setQrNotice(`Скопируйте ссылку: ${profileLink}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(profileLink);
      setQrNotice('Ссылка на профиль скопирована');
    } catch {
      setQrNotice(`Скопируйте ссылку: ${profileLink}`);
    }
  }

  return (
    <div className={`profile-shell${isSelf ? ' profile-shell--v2' : ''}`}>
      <main
        className={`profile-page${isSelf ? ' profile-page--v2' : ''}`}
        style={pageStyle}
        data-profile-level-theme={
          isSelf
            ? Object.hasOwn(levelAccents, displayLevel)
              ? displayLevel
              : 'unrated'
            : undefined
        }
      >
        <header className="profile-toolbar">
          <button
            className="profile-toolbar__back"
            type="button"
            aria-label="Назад"
            onClick={() => window.history.back()}
          >
            <ProfileIcon name="back" />
          </button>
          {isSelf ? (
            <div className="profile-v2-toolbar-actions">
              <button
                type="button"
                className="profile-v2-share"
                aria-label="поделиться"
                title="Поделиться профилем"
                onClick={() => void shareProfile()}
              >
                <ProfileIcon name="share" />
              </button>
              <ProfileV2Actions
                notificationsAvailable={notificationsAvailable}
                unreadCount={notificationUnreadCount}
                onQr={() => {
                  setQrNotice(null);
                  setQrOpen(true);
                }}
              />
            </div>
          ) : (
            <div className="profile-toolbar__actions">
              {notificationsAvailable ? (
                <NotificationBellLink
                  className="profile-toolbar__bell"
                  unreadCount={notificationUnreadCount}
                />
              ) : null}
            </div>
          )}
        </header>

        <section className="profile-identity" aria-labelledby="profile-name">
          <div className="profile-avatar-stage">
            <PlayerLevelAvatar
              className="profile-level-avatar"
              alt={profile.displayName}
              fallbackSeed={profile.userId}
              level={displayLevel}
              progress={levelProgress(rating, profile.level?.assessmentRequired ?? true)}
              size={isSelf ? 144 : 112}
              src={profile.avatarUrl ?? null}
            />
            {isSelf ? (
              <a
                className="profile-edit-link"
                href="#profile-settings"
                aria-label="редактировать профиль"
                title="Редактировать профиль"
              >
                <ProfileIcon name="edit" />
              </a>
            ) : null}
          </div>

          <div className="profile-name-row">
            <h1 id="profile-name">{profile.displayName}</h1>
          </div>

          {isSelf ? (
            <ProfileFacts
              key={`facts:${profile.userId}`}
              city={city}
              sport={activeSport}
              openChoice={openChoice}
              onChooseCity={() => setChoices((current) => ({ ...current, open: 'city' }))}
              onChooseSport={() => setChoices((current) => ({ ...current, open: 'sport' }))}
            />
          ) : null}

          {!isSelf ? (
            <div className="profile-stats" aria-label="Данные профиля">
              <div>
                <span>{isIndependentSport ? 'профиль' : privateAccount ? 'баланс' : 'доступ'}</span>
                <strong>
                  {isIndependentSport
                    ? 'отдельный'
                    : privateAccount
                      ? (balance ?? UNKNOWN_VALUE_PLACEHOLDER)
                      : accessTierLabel(access.tier)}
                </strong>
              </div>
            </div>
          ) : null}

          {!isSelf && !isIndependentSport ? (
            <>
              <div className="profile-share-row">
                <button
                  className="profile-share profile-share--link"
                  type="button"
                  aria-label="поделиться"
                  title="Поделиться профилем"
                  onClick={() => void shareProfile()}
                >
                  <ProfileIcon name="share" />
                </button>
                <button
                  aria-haspopup="dialog"
                  aria-label="QR-код"
                  title="QR-код профиля"
                  className="profile-share"
                  type="button"
                  onClick={() => {
                    setQrNotice(null);
                    setQrOpen(true);
                  }}
                >
                  <ProfileIcon name="qr" />
                </button>
              </div>
              {shareNotice ? (
                <p className="profile-share-notice" role="status">
                  {shareNotice}
                </p>
              ) : null}
            </>
          ) : null}
          {isSelf && shareNotice ? (
            <p className="profile-share-notice" role="status">
              {shareNotice}
            </p>
          ) : null}
        </section>

        {qrOpen ? (
          <div
            className="profile-qr-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setQrOpen(false);
            }}
          >
            <section
              className="profile-qr-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="profile-qr-sheet-title"
            >
              <header>
                <div>
                  <span>Поделиться профилем</span>
                  <h2 id="profile-qr-sheet-title">QR-код профиля</h2>
                </div>
                <button type="button" aria-label="Закрыть QR-код" onClick={() => setQrOpen(false)}>
                  ×
                </button>
              </header>
              <p>
                Наведите камеру телефона — откроется профиль {profile.displayName}. После входа там
                можно добавить игрока в друзья и написать ему.
              </p>
              <ProfileShareQrCode value={profileLink} />
              <p className="profile-qr-link">{profileLink}</p>
              <button
                className="profile-qr-copy"
                type="button"
                onClick={() => void copyProfileLink()}
              >
                скопировать ссылку
              </button>
              {qrNotice ? (
                <p className="profile-qr-notice" role="status">
                  {qrNotice}
                </p>
              ) : null}
            </section>
          </div>
        ) : null}

        <div className="profile-content">
          {isSelf && !isIndependentSport ? (
            <ProfileV2Overview
              friendsAvailable={friendsAvailable}
              {...(friends !== undefined ? { friends } : {})}
              {...(communities !== undefined ? { communities } : {})}
              onFriends={() => setActiveDirectory('friends')}
              onCommunities={() => setActiveDirectory('communities')}
            />
          ) : null}
          {isSelf && !isIndependentSport ? (
            <>
              <a className="profile-level-history-link" href="/profile/level-history">
                <span className="profile-inline-icon">
                  <ProfilePackIcon name="history" />
                </span>
                <span>История изменения уровня</span>
                <span className="profile-level-history-link__chevron" aria-hidden="true">
                  ›
                </span>
              </a>
              <ProfileBalanceCard balance={balance} />
            </>
          ) : null}

          {access.audience === 'OTHER' ? (
            <>
              <FriendshipAction
                busy={friendsBusy}
                reachable={view.reachable}
                {...(friendship !== undefined ? { friendship } : {})}
                {...(friendsError !== undefined ? { error: friendsError } : {})}
                {...(onAddFriend ? { onAdd: onAddFriend } : {})}
                {...(onRemoveFriend ? { onRemove: onRemoveFriend } : {})}
                {...(onAcceptFriendRequest ? { onAccept: onAcceptFriendRequest } : {})}
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
                    description="Перейти в личный чат ПадлхАБ"
                    capability={access.chat}
                  />
                </div>
              </section>
            </>
          ) : null}

          {isSelf && independentSport ? (
            <IndependentSportProfileContent sport={independentSport} />
          ) : null}

          {isSelf && !isIndependentSport ? (
            <>
              <ProfileSubscriptions
                renewalAvailable={subscriptionRenewalAvailable}
                {...(subscriptions !== undefined ? { subscriptions } : {})}
                {...(subscriptionsError !== undefined ? { error: subscriptionsError } : {})}
              />
            </>
          ) : null}

          {isSelf && !isIndependentSport && friendsAvailable && activeDirectory === 'friends' ? (
            <ProfileDirectorySheet title="Друзья" onClose={() => setActiveDirectory(null)}>
              <ProfileFriends
                {...(friends !== undefined ? { page: friends } : {})}
                {...(friendsError !== undefined ? { error: friendsError } : {})}
                {...(friendRequests !== undefined ? { requests: friendRequests } : {})}
                {...(friendRequestsError !== undefined
                  ? { requestsError: friendRequestsError }
                  : {})}
                friendRequestBusyId={friendRequestBusyId}
                {...(onAcceptFriendRequest ? { onAcceptRequest: onAcceptFriendRequest } : {})}
                {...(onDeclineFriendRequest ? { onDeclineRequest: onDeclineFriendRequest } : {})}
              />
            </ProfileDirectorySheet>
          ) : null}

          {isSelf && !isIndependentSport && activeDirectory === 'communities' ? (
            <ProfileDirectorySheet title="Сообщества" onClose={() => setActiveDirectory(null)}>
              <ProfileCommunities
                key={`communities:${profile.userId}`}
                {...(loadCommunityPage ? { loadPage: loadCommunityPage } : {})}
                {...(communities !== undefined ? { page: communities } : {})}
                {...(communitiesError !== undefined ? { error: communitiesError } : {})}
              />
            </ProfileDirectorySheet>
          ) : null}

          {isSelf && !isIndependentSport ? (
            <section
              className="profile-settings-overview"
              id="profile-settings"
              aria-label="Настройки"
            >
              <button
                className="profile-v2-unavailable"
                type="button"
                disabled
                aria-label="О себе — пока недоступно"
              >
                <span className="profile-inline-icon">
                  <ProfilePackIcon name="friends" />
                </span>
                <span>
                  <strong>О себе</strong>
                  <small>Информация пока не добавлена</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              <button
                className="profile-v2-unavailable"
                type="button"
                disabled
                aria-label="Достижения — пока недоступно"
              >
                <span className="profile-inline-icon">
                  <ProfileIcon name="trophy" />
                </span>
                <span>
                  <strong>Достижения</strong>
                  <small>Пока нет данных</small>
                </span>
                <b className="profile-v2-achievement-count">—</b>
              </button>
              <button type="button" onClick={() => setActiveSettings('preferences')}>
                <span className="profile-inline-icon">
                  <ProfilePackIcon name="preference" />
                </span>
                <span>
                  <strong>Предпочтения</strong>
                  <small>Станции, время, рекомендации</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              <button type="button" onClick={() => setActiveSettings('visibility')}>
                <span className="profile-inline-icon">
                  <ProfilePackIcon name="eye" />
                </span>
                <span>
                  <strong>Видимость профиля</strong>
                  <small>Кто может видеть профиль</small>
                </span>
                <i aria-hidden="true">›</i>
              </button>
              {notificationsAvailable ? (
                <a href="/notifications">
                  <span className="profile-inline-icon">
                    <ProfilePackIcon name="bell" />
                  </span>
                  <span>
                    <strong>Уведомления</strong>
                    <small>push и лента оповещений</small>
                  </span>
                  <i aria-hidden="true">›</i>
                </a>
              ) : null}
            </section>
          ) : null}

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
              <ProfileIcon name="logout" />
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

        {openChoice === 'city' ? (
          <CityPicker
            city={city}
            onClose={() => setChoices((current) => ({ ...current, open: null }))}
            onSelect={(next) => {
              setChoices((current) => ({ ...current, city: next, open: null }));
              try {
                window.localStorage.setItem(`lk2:profile:city:${profile.userId}`, next);
              } catch {
                // The current selection still works when browser storage is unavailable.
              }
            }}
          />
        ) : openChoice === 'sport' ? (
          <SportPicker
            activeSport={activeSport}
            onClose={() => setChoices((current) => ({ ...current, open: null }))}
            onSelect={(sport) => {
              setActiveSport(sport);
              setShareNotice(null);
              setChoices((current) => ({ ...current, open: null }));
            }}
          />
        ) : null}

        {navigation ?? <MainBottomNavigation active="profile" gamesDestination="games" />}
      </main>
    </div>
  );
}
