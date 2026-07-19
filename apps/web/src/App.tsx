import { normalizePhoneE164 } from '@phub/auth';
import { PrimaryButton } from '@phub/ui';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import padlHubLogoUrl from './assets/padlhub-logo.svg';
import vkIconUrl from './assets/vk-auth.svg';
import yandexIconUrl from './assets/yandex-auth.svg';
import { BookingsPage } from './BookingsPage.js';
import { CommunitiesPage } from './CommunitiesPage.js';
import {
  isIOSBrowser,
  preferredAuthEntryView,
  type AuthEntryView,
} from './browser-auth-context.js';
import { HomeDashboardPage } from './HomeDashboardPage.js';
import { GamesPage } from './GamesPage.js';
import { LocationDetailPage } from './LocationDetailPage.js';
import { LocationsPage } from './LocationsPage.js';
import { NotificationsPage } from './NotificationsPage.js';
import { ProfilePage } from './ProfilePage.js';
import type {
  AuthGateway,
  AuthenticatedSession,
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  HomeDashboard,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  PlayerProfileView,
  PhoneChallenge,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  UserUpcomingBookings,
  VivaOAuthProvider,
  WebPushConfiguration,
} from './auth-gateway.js';
import {
  disableWebPush,
  enableWebPush,
  getWebPushBrowserState,
  type WebPushBrowserState,
} from './web-push-client.js';

type View = 'restoring' | 'oauth' | 'phone' | 'otp' | 'home';
type BusyAction = 'start-viva' | 'request-code' | 'verify-code' | 'logout' | null;

type ProtectedRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'profile'; readonly userId?: string }
  | { readonly kind: 'bookings' }
  | { readonly kind: 'notifications' }
  | { readonly kind: 'communities' }
  | { readonly kind: 'locations' }
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'games' }
  | { readonly kind: 'game'; readonly gameId: string }
  | { readonly kind: 'section'; readonly title: string }
  | { readonly kind: 'not-found' };

const visibleWorkInProgressSections = [
  ['/tournaments', 'Турниры'],
  ['/trainings', 'Тренировки'],
  ['/subscriptions', 'Абонементы'],
] as const;

function resolveProtectedRoute(pathname: string): ProtectedRoute {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalizedPath === '/') return { kind: 'home' };
  if (normalizedPath === '/profile') return { kind: 'profile' };
  const profileMatch = normalizedPath.match(
    /^\/profile\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (profileMatch?.[1]) return { kind: 'profile', userId: profileMatch[1] };
  if (normalizedPath === '/bookings') return { kind: 'bookings' };
  if (normalizedPath === '/notifications') return { kind: 'notifications' };
  if (normalizedPath === '/communities') return { kind: 'communities' };
  if (normalizedPath === '/locations') return { kind: 'locations' };
  const locationMatch = normalizedPath.match(
    /^\/locations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (locationMatch?.[1]) return { kind: 'location', locationId: locationMatch[1] };
  if (normalizedPath === '/games') return { kind: 'games' };
  if (normalizedPath === '/games/new') return { kind: 'section', title: 'Создание игры' };
  const gameMatch = normalizedPath.match(
    /^\/games\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (gameMatch?.[1]) return { kind: 'game', gameId: gameMatch[1] };
  const section = visibleWorkInProgressSections.find(
    ([prefix]) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
  );
  if (section) return { kind: 'section', title: section[1] };
  return { kind: 'not-found' };
}

interface AuthState {
  readonly view: View;
  readonly busy: BusyAction;
  readonly phoneInput: string;
  readonly phoneE164: string | null;
  readonly code: string;
  readonly challenge: PhoneChallenge | null;
  readonly session: AuthenticatedSession | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
}

type AuthAction =
  | {
      readonly type: 'restore-completed';
      readonly session: AuthenticatedSession | null;
      readonly entryView: AuthEntryView;
    }
  | { readonly type: 'restore-failed'; readonly message: string; readonly entryView: AuthEntryView }
  | { readonly type: 'oauth-view' }
  | { readonly type: 'phone-changed'; readonly value: string }
  | { readonly type: 'acceptance-toggled'; readonly acceptance: 'public-offer' | 'personal-data' }
  | { readonly type: 'code-changed'; readonly value: string }
  | { readonly type: 'oauth-started' }
  | { readonly type: 'request-started' }
  | {
      readonly type: 'request-completed';
      readonly phoneE164: string;
      readonly challenge: PhoneChallenge;
    }
  | { readonly type: 'operation-failed'; readonly message: string }
  | { readonly type: 'verify-started' }
  | { readonly type: 'verify-completed'; readonly session: AuthenticatedSession }
  | { readonly type: 'edit-phone' }
  | { readonly type: 'logout-started' }
  | { readonly type: 'logout-failed'; readonly message: string }
  | {
      readonly type: 'logout-completed';
      readonly entryView: AuthEntryView;
      readonly message?: string;
    };

const initialState: AuthState = {
  view: 'restoring',
  busy: null,
  phoneInput: '+7',
  phoneE164: null,
  code: '',
  challenge: null,
  session: null,
  error: null,
  notice: null,
  publicOfferAccepted: false,
  personalDataPolicyAccepted: false,
};

function reducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'restore-completed':
      return action.session
        ? { ...state, view: 'home', session: action.session, error: null }
        : { ...state, view: action.entryView, session: null, error: null };
    case 'restore-failed':
      return { ...state, view: action.entryView, error: action.message };
    case 'oauth-view':
      return { ...state, view: 'oauth', busy: null, error: null, notice: null };
    case 'phone-changed':
      return { ...state, phoneInput: action.value, error: null };
    case 'acceptance-toggled':
      return action.acceptance === 'public-offer'
        ? { ...state, publicOfferAccepted: !state.publicOfferAccepted, error: null }
        : { ...state, personalDataPolicyAccepted: !state.personalDataPolicyAccepted, error: null };
    case 'code-changed':
      return { ...state, code: action.value, error: null };
    case 'oauth-started':
      return { ...state, busy: 'start-viva', error: null, notice: null };
    case 'request-started':
      return { ...state, busy: 'request-code', error: null, notice: null };
    case 'request-completed':
      return {
        ...state,
        view: 'otp',
        busy: null,
        phoneE164: action.phoneE164,
        challenge: action.challenge,
        code: '',
        error: null,
        notice: `Код отправлен на номер ${action.challenge.maskedPhone}`,
      };
    case 'operation-failed':
      return {
        ...state,
        busy: null,
        code: state.view === 'otp' ? '' : state.code,
        error: action.message,
      };
    case 'verify-started':
      return { ...state, busy: 'verify-code', error: null, notice: null };
    case 'verify-completed':
      return {
        ...state,
        view: 'home',
        busy: null,
        code: '',
        challenge: null,
        session: action.session,
        error: null,
        notice: null,
      };
    case 'edit-phone':
      return {
        ...state,
        view: 'phone',
        busy: null,
        code: '',
        challenge: null,
        phoneE164: null,
        error: null,
        notice: null,
      };
    case 'logout-started':
      return { ...state, busy: 'logout', error: null, notice: null };
    case 'logout-failed':
      return { ...state, busy: null, error: action.message, notice: null };
    case 'logout-completed':
      return {
        ...initialState,
        view: action.entryView,
        phoneInput: state.phoneInput,
        error: action.message ?? null,
        notice: action.message ? null : 'Вы вышли из аккаунта',
      };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function userMessage(
  error: unknown,
  operation: 'restore' | 'request' | 'verify' | 'oauth' | 'logout',
): string {
  switch (errorCode(error)) {
    case 'PHONE_INVALID':
    case 'AUTH_PHONE_INVALID':
      return 'Проверьте номер телефона.';
    case 'OTP_INVALID':
    case 'AUTH_CODE_INVALID':
      return 'Код не подошёл. Попробуйте ещё раз.';
    case 'OTP_EXPIRED':
    case 'AUTH_CODE_EXPIRED':
      return 'Срок действия кода истёк. Получите новый код.';
    case 'OTP_ATTEMPTS_EXHAUSTED':
      return 'Слишком много попыток. Получите новый код.';
    case 'RATE_LIMIT_EXCEEDED':
    case 'AUTH_RATE_LIMITED':
      return 'Слишком много запросов. Подождите немного и попробуйте снова.';
    case 'AUTH_REQUIRED':
    case 'AUTH_TOKEN_INVALID':
      return 'Сессия завершилась. Войдите ещё раз.';
    case 'AUTH_PROVIDER_UNAVAILABLE':
      return 'Вход через Viva сейчас недоступен. Проверьте настройку OAuth или повторите позже.';
    case 'LEGAL_ACCEPTANCE_REQUIRED':
      return 'Подтвердите публичную оферту и обработку персональных данных.';
  }

  if (operation === 'restore') {
    return 'Не удалось проверить сессию. Войдите по номеру телефона.';
  }
  if (operation === 'logout') {
    return 'Не удалось выйти: сессия осталась активной. Проверьте связь и повторите.';
  }
  if (operation === 'oauth') {
    return 'Не удалось открыть вход через Viva. Попробуйте ещё раз.';
  }
  return operation === 'request'
    ? 'Не удалось отправить код. Проверьте связь и попробуйте снова.'
    : 'Не удалось войти. Проверьте связь и попробуйте снова.';
}

function Brand(): React.JSX.Element {
  return <img className="brand" src={padlHubLogoUrl} alt="ПадлХАБ" />;
}

function BusyStatus({ action }: { readonly action: BusyAction }): React.JSX.Element {
  const message =
    action === 'start-viva'
      ? 'Открываем вход через Viva…'
      : action === 'request-code'
        ? 'Отправляем код…'
        : action === 'verify-code'
          ? 'Проверяем код…'
          : action === 'logout'
            ? 'Завершаем сессию…'
            : '';
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {message}
    </p>
  );
}

function VivaProviderIcon({
  provider,
}: {
  readonly provider: VivaOAuthProvider;
}): React.JSX.Element {
  return provider === 'vkid' ? (
    <img className="viva-provider-icon" src={vkIconUrl} alt="" aria-hidden="true" />
  ) : (
    <img
      className="viva-provider-icon viva-provider-icon--yandex"
      src={yandexIconUrl}
      alt=""
      aria-hidden="true"
    />
  );
}

export interface AppProps {
  readonly gateway: AuthGateway;
  readonly tenantKey: string;
}

const HOME_REFRESH_INTERVAL_MS = 30_000;
const NOTIFICATIONS_REFRESH_INTERVAL_MS = 15_000;

export function App({ gateway, tenantKey }: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const browserNavigator = typeof navigator === 'undefined' ? undefined : navigator;
  const iosBrowser = isIOSBrowser(browserNavigator);
  const entryView = preferredAuthEntryView(browserNavigator);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [homeDashboard, setHomeDashboard] = useState<HomeDashboard | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [locations, setLocations] = useState<LocationList | null>(null);
  const [locationDetail, setLocationDetail] = useState<LocationDetail | null>(null);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<PlayerProfileView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profilePrivacy, setProfilePrivacy] = useState<ProfilePrivacySettings | null>(null);
  const [profilePrivacyBusy, setProfilePrivacyBusy] = useState(false);
  const [profilePrivacyError, setProfilePrivacyError] = useState<string | null>(null);
  const [profilePrivacyNotice, setProfilePrivacyNotice] = useState<string | null>(null);
  const [bookingPreferences, setBookingPreferences] = useState<BookingPreferences | null>(null);
  const [bookingPreferencesBusy, setBookingPreferencesBusy] = useState(false);
  const [bookingPreferencesError, setBookingPreferencesError] = useState<string | null>(null);
  const [bookingPreferencesNotice, setBookingPreferencesNotice] = useState<string | null>(null);
  const [bookingPreferenceStations, setBookingPreferenceStations] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [upcomingBookings, setUpcomingBookings] = useState<UserUpcomingBookings | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationInboxPage | null>(null);
  const [webPushConfiguration, setWebPushConfiguration] = useState<WebPushConfiguration | null>(
    null,
  );
  const [webPushBrowserState, setWebPushBrowserState] =
    useState<WebPushBrowserState>('unsupported');
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const protectedRoute = resolveProtectedRoute(
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );
  const requestedProfileUserId =
    protectedRoute.kind === 'profile' ? protectedRoute.userId : undefined;
  const requestedLocationId =
    protectedRoute.kind === 'location' ? protectedRoute.locationId : undefined;
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void gateway.restoreSession().then(
      (session) => {
        if (active) dispatch({ type: 'restore-completed', session, entryView });
      },
      (error: unknown) => {
        if (active) {
          dispatch({
            type: 'restore-failed',
            message: userMessage(error, 'restore'),
            entryView,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [entryView, gateway]);

  useEffect(() => {
    if (state.view !== 'home' || !state.session) return;
    let active = true;
    if (protectedRoute.kind === 'profile') {
      const targetUserId = requestedProfileUserId ?? state.session.context.user.id;
      const isSelfProfile = targetUserId === state.session.context.user.id;
      if (isSelfProfile) {
        void gateway.getProfilePrivacy().then(
          (settings) => {
            if (active) {
              setProfilePrivacy(settings);
              setProfilePrivacyError(null);
              setProfilePrivacyNotice(null);
            }
          },
          () => {
            if (active) {
              setProfilePrivacyError('Не удалось загрузить настройки приватности.');
              setProfilePrivacyNotice(null);
            }
          },
        );
        void gateway.getBookingPreferences().then(
          (settings) => {
            if (active) {
              setBookingPreferences(settings);
              setBookingPreferencesError(null);
              setBookingPreferencesNotice(null);
            }
          },
          () => {
            if (active) {
              setBookingPreferencesError('Не удалось загрузить предпочтения для рекомендаций.');
              setBookingPreferencesNotice(null);
            }
          },
        );
        void gateway.listPublicGames({ availability: 'INCLUDE_FULL', limit: 50 }).then(
          (page) => {
            if (!active) return;
            const stations = new Map<string, string>();
            page.items.forEach((game) => stations.set(game.station.id, game.station.name));
            setBookingPreferenceStations(
              [...stations]
                .map(([id, name]) => ({ id, name }))
                .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU')),
            );
          },
          () => {
            if (active) setBookingPreferenceStations([]);
          },
        );
      }
      void gateway.getPlayerProfile(targetUserId).then(
        (profile) => {
          if (active) {
            setUserProfile(profile);
            setProfileError(null);
            if (!isSelfProfile) {
              setProfilePrivacy(null);
              setProfilePrivacyError(null);
              setProfilePrivacyNotice(null);
              setBookingPreferences(null);
              setBookingPreferencesError(null);
              setBookingPreferencesNotice(null);
              setBookingPreferenceStations([]);
            }
          }
        },
        () => {
          if (active) setProfileError('Не удалось загрузить профиль. Проверьте связь и повторите.');
        },
      );
      return () => {
        active = false;
      };
    }
    if (protectedRoute.kind === 'bookings') {
      void gateway.getUpcomingBookings().then(
        (bookings) => {
          if (active) {
            setUpcomingBookings(bookings);
            setBookingsError(null);
          }
        },
        () => {
          if (active) setBookingsError('Не удалось загрузить записи. Проверьте связь и повторите.');
        },
      );
      return () => {
        active = false;
      };
    }
    if (protectedRoute.kind === 'notifications') {
      const serviceWorkerUrl =
        window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js';
      const refreshNotifications = (): void => {
        void gateway.listNotifications().then(
          (page) => {
            if (!active) return;
            setNotifications(page);
            setNotificationsError((current) => {
              const next = current?.replace('Лента оповещений временно недоступна.', '').trim();
              return next || null;
            });
          },
          () => undefined,
        );
      };
      const refreshVisibleNotifications = (): void => {
        if (document.visibilityState === 'visible') refreshNotifications();
      };
      void Promise.allSettled([
        gateway.listNotifications(),
        gateway.getWebPushConfiguration(),
        getWebPushBrowserState(serviceWorkerUrl),
      ]).then(([pageResult, pushConfigurationResult, browserStateResult]) => {
        if (!active) return;
        const errors: string[] = [];
        if (pageResult.status === 'fulfilled') {
          setNotifications(pageResult.value);
        } else {
          setNotifications({ items: [], unreadCount: 0 });
          errors.push('Лента оповещений временно недоступна.');
        }
        if (pushConfigurationResult.status === 'fulfilled') {
          setWebPushConfiguration(pushConfigurationResult.value);
        } else {
          setWebPushConfiguration({ enabled: false, reason: 'RUNTIME_UNAVAILABLE' });
          errors.push('Настройки Web Push временно недоступны.');
        }
        if (browserStateResult.status === 'fulfilled') {
          setWebPushBrowserState(browserStateResult.value);
        } else {
          setWebPushBrowserState('unsupported');
          errors.push('Не удалось проверить поддержку Web Push.');
        }
        setNotificationsError(errors.length > 0 ? errors.join(' ') : null);
      });
      const refreshInterval = window.setInterval(
        refreshNotifications,
        NOTIFICATIONS_REFRESH_INTERVAL_MS,
      );
      window.addEventListener('focus', refreshNotifications);
      document.addEventListener('visibilitychange', refreshVisibleNotifications);
      return () => {
        active = false;
        window.clearInterval(refreshInterval);
        window.removeEventListener('focus', refreshNotifications);
        document.removeEventListener('visibilitychange', refreshVisibleNotifications);
      };
    }
    if (protectedRoute.kind === 'locations') {
      void gateway.listLocations().then(
        (result) => {
          if (!active) return;
          setLocations(result);
          setLocationsError(null);
        },
        () => {
          if (active)
            setLocationsError('Не удалось загрузить локации. Проверьте связь и повторите.');
        },
      );
      return () => {
        active = false;
      };
    }
    if (protectedRoute.kind === 'location' && requestedLocationId) {
      void gateway.getLocation(requestedLocationId).then(
        (result) => {
          if (!active) return;
          setLocationDetail(result);
          setLocationsError(null);
        },
        () => {
          if (active) setLocationsError('Не удалось загрузить карточку локации.');
        },
      );
      return () => {
        active = false;
      };
    }
    if (protectedRoute.kind !== 'home') return;
    const refreshHome = (): void => {
      void gateway.getHomeDashboard().then(
        (dashboard) => {
          if (active) {
            setHomeDashboard(dashboard);
            setHomeError(null);
          }
        },
        () => {
          if (active) setHomeError('Не удалось загрузить Главную. Проверьте связь и повторите.');
        },
      );
    };
    const refreshNotificationBadge = (): void => {
      void gateway.listNotifications().then(
        (page) => {
          if (active) setNotifications(page);
        },
        () => undefined,
      );
    };
    const refreshHomeContent = (): void => {
      refreshHome();
      refreshNotificationBadge();
    };
    const refreshVisibleHome = (): void => {
      if (document.visibilityState === 'visible') refreshHomeContent();
    };
    refreshHomeContent();
    const homeRefreshInterval = window.setInterval(refreshHome, HOME_REFRESH_INTERVAL_MS);
    const notificationRefreshInterval = window.setInterval(
      refreshNotificationBadge,
      NOTIFICATIONS_REFRESH_INTERVAL_MS,
    );
    window.addEventListener('focus', refreshHomeContent);
    document.addEventListener('visibilitychange', refreshVisibleHome);
    return () => {
      active = false;
      window.clearInterval(homeRefreshInterval);
      window.clearInterval(notificationRefreshInterval);
      window.removeEventListener('focus', refreshHomeContent);
      document.removeEventListener('visibilitychange', refreshVisibleHome);
    };
  }, [
    gateway,
    protectedRoute.kind,
    requestedLocationId,
    requestedProfileUserId,
    state.session,
    state.view,
  ]);

  useEffect(() => {
    if (state.busy) return;
    if (state.view === 'phone') phoneInput.current?.focus();
    if (state.view === 'otp') codeInput.current?.focus();
  }, [state.busy, state.view]);

  useEffect(() => {
    if (state.view !== 'otp' || !state.challenge) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [state.challenge, state.view]);

  function requestCode(phoneE164: string): void {
    dispatch({ type: 'request-started' });
    void gateway.requestCode(phoneE164).then(
      (challenge) => dispatch({ type: 'request-completed', phoneE164, challenge }),
      (error: unknown) => {
        dispatch({ type: 'operation-failed', message: userMessage(error, 'request') });
      },
    );
  }

  function handlePhoneSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!state.publicOfferAccepted || !state.personalDataPolicyAccepted) {
      dispatch({
        type: 'operation-failed',
        message: 'Подтвердите публичную оферту и обработку персональных данных.',
      });
      return;
    }
    const phoneE164 = normalizePhoneE164(state.phoneInput);
    if (!phoneE164) {
      dispatch({ type: 'operation-failed', message: 'Введите российский номер в формате +7.' });
      return;
    }
    requestCode(phoneE164);
  }

  function handleCodeSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!state.challenge || state.code.length !== 4) {
      dispatch({ type: 'operation-failed', message: 'Введите код из четырёх цифр.' });
      return;
    }
    dispatch({ type: 'verify-started' });
    void gateway
      .verifyCode({
        challengeId: state.challenge.challengeId,
        code: state.code,
        acceptance: {
          publicOfferAccepted: state.publicOfferAccepted,
          personalDataPolicyAccepted: state.personalDataPolicyAccepted,
        },
      })
      .then(
        (session) => dispatch({ type: 'verify-completed', session }),
        (error: unknown) => {
          dispatch({ type: 'operation-failed', message: userMessage(error, 'verify') });
        },
      );
  }

  function handlePhoneChange(event: ChangeEvent<HTMLInputElement>): void {
    dispatch({ type: 'phone-changed', value: event.currentTarget.value });
  }

  function startVivaOAuth(provider: VivaOAuthProvider): void {
    if (!state.publicOfferAccepted || !state.personalDataPolicyAccepted) {
      dispatch({
        type: 'operation-failed',
        message: 'Подтвердите публичную оферту и согласие на обработку персональных данных.',
      });
      return;
    }
    dispatch({ type: 'oauth-started' });
    void gateway
      .startVivaOAuth({
        provider,
        acceptance: {
          publicOfferAccepted: state.publicOfferAccepted,
          personalDataPolicyAccepted: state.personalDataPolicyAccepted,
        },
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'operation-failed',
          message: userMessage(error, 'oauth'),
        });
      });
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>): void {
    const code = event.currentTarget.value.replace(/\D/g, '').slice(0, 4);
    dispatch({ type: 'code-changed', value: code });
  }

  function handleLogout(): void {
    dispatch({ type: 'logout-started' });
    const serviceWorkerUrl =
      window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js';
    void disableWebPush({ gateway, serviceWorkerUrl })
      .catch(() => undefined)
      .then(() => gateway.logout())
      .then(
        () => {
          setHomeDashboard(null);
          setHomeError(null);
          setLocations(null);
          setLocationDetail(null);
          setLocationsError(null);
          setUserProfile(null);
          setProfileError(null);
          setBookingPreferences(null);
          setBookingPreferencesError(null);
          setBookingPreferencesNotice(null);
          setBookingPreferenceStations([]);
          setUpcomingBookings(null);
          setBookingsError(null);
          setNotifications(null);
          setWebPushConfiguration(null);
          setNotificationsError(null);
          dispatch({ type: 'logout-completed', entryView });
        },
        (error: unknown) => {
          dispatch({ type: 'logout-failed', message: userMessage(error, 'logout') });
        },
      );
  }

  function handleEnableWebPush(): void {
    if (!webPushConfiguration?.enabled || !webPushConfiguration.publicKey) return;
    setNotificationsBusy(true);
    setNotificationsError(null);
    void enableWebPush({
      gateway,
      publicKey: webPushConfiguration.publicKey,
      serviceWorkerUrl: window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js',
    }).then(
      () => {
        setWebPushBrowserState('subscribed');
        setNotificationsBusy(false);
      },
      () => {
        const notificationPermission =
          typeof Notification === 'undefined' ? 'default' : Notification.permission;
        setNotificationsError(
          notificationPermission === 'denied'
            ? 'Браузер запретил уведомления. Разрешите их в настройках сайта.'
            : 'Не удалось включить Web Push.',
        );
        setNotificationsBusy(false);
      },
    );
  }

  function handleDisableWebPush(): void {
    setNotificationsBusy(true);
    setNotificationsError(null);
    void disableWebPush({
      gateway,
      serviceWorkerUrl: window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js',
    }).then(
      () => {
        setWebPushBrowserState('ready');
        setNotificationsBusy(false);
      },
      () => {
        setNotificationsError('Не удалось отключить Web Push.');
        setNotificationsBusy(false);
      },
    );
  }

  function handleMarkAllNotificationsRead(): void {
    const newest = notifications?.items[0];
    if (!newest) return;
    setNotificationsBusy(true);
    void gateway
      .markNotificationsRead(newest.id)
      .then(
        () => gateway.listNotifications(),
        () => {
          throw new Error('NOTIFICATION_READ_FAILED');
        },
      )
      .then(
        (page) => {
          setNotifications(page);
          setNotificationsBusy(false);
        },
        () => {
          setNotificationsError('Не удалось отметить оповещения прочитанными.');
          setNotificationsBusy(false);
        },
      );
  }

  function handleSaveProfilePrivacy(input: ProfilePrivacyUpdateRequest): void {
    setProfilePrivacyBusy(true);
    setProfilePrivacyError(null);
    setProfilePrivacyNotice(null);
    void gateway.updateProfilePrivacy(input).then(
      (settings) => {
        setProfilePrivacy(settings);
        setProfilePrivacyBusy(false);
        setProfilePrivacyNotice('Настройки сохранены');
      },
      () => {
        setProfilePrivacyBusy(false);
        setProfilePrivacyError('Не удалось сохранить. Обновите профиль и повторите.');
      },
    );
  }

  function handleSaveBookingPreferences(input: BookingPreferencesUpdateRequest): void {
    setBookingPreferencesBusy(true);
    setBookingPreferencesError(null);
    setBookingPreferencesNotice(null);
    void gateway.updateBookingPreferences(input).then(
      (settings) => {
        setBookingPreferences(settings);
        setBookingPreferencesBusy(false);
        setBookingPreferencesNotice('Предпочтения сохранены');
      },
      () => {
        setBookingPreferencesBusy(false);
        setBookingPreferencesError('Не удалось сохранить. Обновите профиль и повторите.');
      },
    );
  }

  if (state.view === 'restoring') {
    return (
      <main className="app-shell app-shell-loading" aria-labelledby="restore-title">
        <Brand />
        <section className="loading-card" aria-busy="true">
          <span className="loader" aria-hidden="true" />
          <h1 id="restore-title">Открываем личный кабинет</h1>
          <p role="status">Проверяем сессию…</p>
        </section>
      </main>
    );
  }

  if (state.view === 'home' && state.session) {
    const { context } = state.session;
    if (protectedRoute.kind === 'profile') {
      if (!userProfile) {
        return (
          <main className="app-shell app-shell-loading" aria-labelledby="profile-loading-title">
            <Brand />
            <section className="loading-card" aria-busy={!profileError}>
              {profileError ? null : <span className="loader" aria-hidden="true" />}
              <h1 id="profile-loading-title">
                {profileError ? 'Профиль недоступен' : 'Загружаем профиль'}
              </h1>
              {profileError ? (
                <p className="error-message" role="alert">
                  {profileError}
                </p>
              ) : (
                <p role="status">Проверяем серверную схему подключения…</p>
              )}
            </section>
          </main>
        );
      }
      return (
        <ProfilePage
          profile={userProfile}
          tenantName={context.tenant.name}
          logoutBusy={state.busy === 'logout'}
          privacySettings={profilePrivacy}
          privacyBusy={profilePrivacyBusy}
          privacyError={profilePrivacyError}
          privacyNotice={profilePrivacyNotice}
          bookingPreferences={bookingPreferences}
          bookingPreferencesBusy={bookingPreferencesBusy}
          bookingPreferencesError={bookingPreferencesError}
          bookingPreferencesNotice={bookingPreferencesNotice}
          stationChoices={bookingPreferenceStations}
          error={state.error}
          onSavePrivacy={handleSaveProfilePrivacy}
          onSaveBookingPreferences={handleSaveBookingPreferences}
          onLogout={handleLogout}
        />
      );
    }
    if (protectedRoute.kind === 'bookings') {
      if (!upcomingBookings) {
        return (
          <main className="app-shell app-shell-loading" aria-labelledby="bookings-loading-title">
            <Brand />
            <section className="loading-card" aria-busy={!bookingsError}>
              {bookingsError ? null : <span className="loader" aria-hidden="true" />}
              <h1 id="bookings-loading-title">
                {bookingsError ? 'Записи недоступны' : 'Загружаем записи'}
              </h1>
              {bookingsError ? (
                <p className="error-message" role="alert">
                  {bookingsError}
                </p>
              ) : (
                <p role="status">Получаем актуальные данные ПаделХАБ…</p>
              )}
            </section>
          </main>
        );
      }
      return (
        <BookingsPage
          bookings={upcomingBookings}
          tenantName={context.tenant.name}
          loadHistory={(cursor) =>
            gateway.listMyGames({
              scope: 'HISTORY',
              limit: 20,
              ...(cursor ? { cursor } : {}),
            })
          }
          loadRecommendations={() => gateway.listBookingRecommendations(20)}
        />
      );
    }
    if (protectedRoute.kind === 'notifications') {
      if (!notifications || !webPushConfiguration) {
        return (
          <main
            className="app-shell app-shell-loading"
            aria-labelledby="notifications-loading-title"
          >
            <Brand />
            <section className="loading-card" aria-busy={!notificationsError}>
              {notificationsError ? null : <span className="loader" aria-hidden="true" />}
              <h1 id="notifications-loading-title">
                {notificationsError ? 'Оповещения недоступны' : 'Загружаем оповещения'}
              </h1>
              {notificationsError ? (
                <p className="error-message" role="alert">
                  {notificationsError}
                </p>
              ) : (
                <p role="status">Проверяем ленту и Web Push…</p>
              )}
            </section>
          </main>
        );
      }
      return (
        <NotificationsPage
          page={notifications}
          webPush={webPushConfiguration}
          browserState={webPushBrowserState}
          busy={notificationsBusy}
          error={notificationsError}
          onEnableWebPush={handleEnableWebPush}
          onDisableWebPush={handleDisableWebPush}
          onMarkAllRead={handleMarkAllNotificationsRead}
        />
      );
    }
    if (protectedRoute.kind === 'communities') {
      return (
        <CommunitiesPage tenantName={context.tenant.name} loadPage={gateway.listMyCommunities} />
      );
    }
    if (protectedRoute.kind === 'locations') {
      if (!locations) {
        return (
          <main className="app-shell app-shell-loading" aria-labelledby="locations-loading-title">
            <Brand />
            <section className="loading-card" aria-busy={!locationsError}>
              {locationsError ? null : <span className="loader" aria-hidden="true" />}
              <h1 id="locations-loading-title">
                {locationsError ? 'Локации недоступны' : 'Загружаем локации'}
              </h1>
              <p className={locationsError ? 'error-message' : undefined}>
                {locationsError ?? 'Собираем опубликованные карточки…'}
              </p>
              {locationsError ? (
                <a className="secondary-button logout-button" href="/">
                  На Главную
                </a>
              ) : null}
            </section>
          </main>
        );
      }
      return <LocationsPage locations={locations} />;
    }
    if (protectedRoute.kind === 'location') {
      if (!locationDetail || locationDetail.id !== protectedRoute.locationId) {
        return (
          <main className="app-shell app-shell-loading" aria-labelledby="location-loading-title">
            <Brand />
            <section className="loading-card" aria-busy={!locationsError}>
              {locationsError ? null : <span className="loader" aria-hidden="true" />}
              <h1 id="location-loading-title">
                {locationsError ? 'Карточка недоступна' : 'Открываем локацию'}
              </h1>
              <p className={locationsError ? 'error-message' : undefined}>
                {locationsError ?? 'Загружаем фотографии, график и адрес…'}
              </p>
              {locationsError ? (
                <a className="secondary-button logout-button" href="/locations">
                  К локациям
                </a>
              ) : null}
            </section>
          </main>
        );
      }
      return <LocationDetailPage location={locationDetail} />;
    }
    if (protectedRoute.kind === 'games' || protectedRoute.kind === 'game') {
      return (
        <GamesPage
          gateway={gateway}
          {...(protectedRoute.kind === 'game' ? { gameId: protectedRoute.gameId } : {})}
        />
      );
    }
    if (protectedRoute.kind === 'section' || protectedRoute.kind === 'not-found') {
      const title =
        protectedRoute.kind === 'section' ? protectedRoute.title : 'Страница не найдена';
      return (
        <main className="app-shell app-shell-loading" aria-labelledby="route-title">
          <Brand />
          <section className="loading-card">
            <h1 id="route-title">{title}</h1>
            <p>
              {protectedRoute.kind === 'section'
                ? 'Раздел подключается к API ПаделХАБ.'
                : 'Проверьте адрес или вернитесь на Главную.'}
            </p>
            <a className="secondary-button logout-button" href="/">
              Вернуться на Главную
            </a>
          </section>
        </main>
      );
    }
    if (!homeDashboard) {
      return (
        <main className="app-shell app-shell-loading" aria-labelledby="home-loading-title">
          <Brand />
          <section className="loading-card" aria-busy={!homeError}>
            {homeError ? null : <span className="loader" aria-hidden="true" />}
            <h1 id="home-loading-title">{homeError ? 'Главная недоступна' : 'Собираем Главную'}</h1>
            {homeError ? (
              <p className="error-message" role="alert">
                {homeError}
              </p>
            ) : (
              <p role="status">Загружаем один актуальный снимок…</p>
            )}
            <button
              className="secondary-button logout-button"
              type="button"
              disabled={state.busy === 'logout'}
              onClick={handleLogout}
            >
              {state.busy === 'logout' ? 'Выходим…' : 'Выйти'}
            </button>
          </section>
        </main>
      );
    }
    return (
      <HomeDashboardPage
        dashboard={homeDashboard}
        tenantName={context.tenant.name}
        notificationUnreadCount={notifications?.unreadCount ?? 0}
        loadCommunityPage={gateway.listMyCommunities}
        loadBookingRecommendations={() => gateway.listBookingRecommendations(6)}
        logoutBusy={state.busy === 'logout'}
        error={state.error}
        onLogout={handleLogout}
      />
    );
  }

  const isRequesting = state.busy === 'request-code';
  const isVerifying = state.busy === 'verify-code';
  const isStartingViva = state.busy === 'start-viva';
  const resendSeconds = state.challenge
    ? Math.max(0, Math.ceil((Date.parse(state.challenge.resendAt) - currentTime) / 1000))
    : 0;
  const errorId = state.error ? 'auth-error' : undefined;

  return (
    <main className="auth-layout" aria-labelledby="auth-title" data-tenant-key={tenantKey}>
      <section className="auth-panel">
        <div className="auth-card">
          <Brand />
          {state.view === 'oauth' ? (
            <>
              <h1 id="auth-title" className="auth-badge">
                Войти в личный кабинет
              </h1>

              {iosBrowser ? (
                <div id="ios-oauth-guidance" className="ios-auth-guidance" role="note">
                  <strong>На iPhone откройте сайт в Safari</strong>
                  <span>
                    Во встроенном браузере Telegram вход через VK ID или Yandex может потерять
                    сессию. Нажмите ••• → «Открыть в Safari» и начните вход с исходной страницы.
                  </span>
                </div>
              ) : null}

              <div className="viva-login-options" aria-label="Способ входа через Viva">
                <button
                  className="viva-login-button"
                  type="button"
                  aria-describedby={iosBrowser ? 'ios-oauth-guidance' : undefined}
                  disabled={isStartingViva}
                  onClick={() => startVivaOAuth('vkid')}
                >
                  <VivaProviderIcon provider="vkid" />
                  <span>VK ID или Mail.ru</span>
                </button>
                <button
                  className="viva-login-button"
                  type="button"
                  aria-describedby={iosBrowser ? 'ios-oauth-guidance' : undefined}
                  disabled={isStartingViva}
                  onClick={() => startVivaOAuth('yandex')}
                >
                  <VivaProviderIcon provider="yandex" />
                  <span>Yandex</span>
                </button>
              </div>

              <div className="legal-acceptances">
                <label className="legal-acceptance">
                  <input
                    type="checkbox"
                    checked={state.publicOfferAccepted}
                    disabled={isStartingViva}
                    onChange={() =>
                      dispatch({ type: 'acceptance-toggled', acceptance: 'public-offer' })
                    }
                  />
                  <span>
                    Принимаю условия{' '}
                    <a href="/documents/public-offer" target="_blank" rel="noreferrer">
                      публичной оферты
                    </a>
                  </span>
                </label>
                <label className="legal-acceptance">
                  <input
                    type="checkbox"
                    checked={state.personalDataPolicyAccepted}
                    disabled={isStartingViva}
                    onChange={() =>
                      dispatch({ type: 'acceptance-toggled', acceptance: 'personal-data' })
                    }
                  />
                  <span>
                    Даю согласие на{' '}
                    <a href="/documents/personal-data-policy" target="_blank" rel="noreferrer">
                      обработку персональных данных
                    </a>
                  </span>
                </label>
              </div>

              {state.error ? (
                <p id="auth-error" className="error-message" role="alert">
                  {state.error}
                </p>
              ) : null}
              <button
                className="text-button auth-alternative"
                type="button"
                disabled={isStartingViva}
                onClick={() => dispatch({ type: 'edit-phone' })}
              >
                Войти по номеру телефона
              </button>
            </>
          ) : state.view === 'phone' ? (
            <>
              <span className="step-label">Шаг 1 из 2</span>
              <h1 id="auth-title">Вход по номеру</h1>
              <p className="form-lead">Мы отправим короткий код для подтверждения.</p>

              {iosBrowser ? (
                <div className="ios-auth-guidance ios-auth-guidance--phone" role="note">
                  <strong>Для iPhone выбран надёжный способ входа</strong>
                  <span>
                    Вход по номеру работает внутри Telegram. Для VK ID или Yandex откройте исходную
                    страницу в Safari.
                  </span>
                </div>
              ) : null}

              <form onSubmit={handlePhoneSubmit} noValidate aria-busy={isRequesting}>
                <label htmlFor="phone">Номер телефона</label>
                <input
                  ref={phoneInput}
                  id="phone"
                  name="phone"
                  className="text-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={state.phoneInput}
                  placeholder="+7 999 000-00-01"
                  aria-describedby={`phone-help${errorId ? ` ${errorId}` : ''}`}
                  aria-invalid={Boolean(state.error)}
                  disabled={isRequesting}
                  required
                  onChange={handlePhoneChange}
                />
                <p id="phone-help" className="field-help">
                  Укажите российский номер с кодом +7.
                </p>

                <div className="legal-acceptances">
                  <label className="legal-acceptance">
                    <input
                      type="checkbox"
                      checked={state.publicOfferAccepted}
                      disabled={isRequesting}
                      onChange={() =>
                        dispatch({ type: 'acceptance-toggled', acceptance: 'public-offer' })
                      }
                    />
                    <span>
                      Принимаю условия{' '}
                      <a href="/documents/public-offer" target="_blank" rel="noreferrer">
                        публичной оферты
                      </a>
                    </span>
                  </label>
                  <label className="legal-acceptance">
                    <input
                      type="checkbox"
                      checked={state.personalDataPolicyAccepted}
                      disabled={isRequesting}
                      onChange={() =>
                        dispatch({ type: 'acceptance-toggled', acceptance: 'personal-data' })
                      }
                    />
                    <span>
                      Даю согласие на{' '}
                      <a href="/documents/personal-data-policy" target="_blank" rel="noreferrer">
                        обработку персональных данных
                      </a>
                    </span>
                  </label>
                </div>

                {state.error ? (
                  <p id="auth-error" className="error-message" role="alert">
                    {state.error}
                  </p>
                ) : null}
                {state.notice ? (
                  <p className="notice-message" role="status" aria-live="polite">
                    {state.notice}
                  </p>
                ) : null}

                <PrimaryButton
                  className="primary-button"
                  type="submit"
                  disabled={isRequesting}
                  aria-busy={isRequesting}
                >
                  {isRequesting ? 'Отправляем…' : 'Получить код'}
                </PrimaryButton>
              </form>

              {import.meta.env.DEV ? (
                <p className="dev-hint">Тестовый вход: +79990000001 / 0000</p>
              ) : null}
              <button
                className="text-button auth-alternative"
                type="button"
                onClick={() => dispatch({ type: 'oauth-view' })}
              >
                ← Войти через Viva
              </button>
            </>
          ) : (
            <>
              <span className="step-label">Шаг 2 из 2</span>
              <h1 id="auth-title">Введите код</h1>
              <p className="form-lead">
                Код из четырёх цифр отправлен на {state.challenge?.maskedPhone}.
              </p>

              <form onSubmit={handleCodeSubmit} noValidate aria-busy={isVerifying || isRequesting}>
                <label htmlFor="otp">Код из СМС</label>
                <input
                  ref={codeInput}
                  id="otp"
                  name="otp"
                  className="text-input otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={state.code}
                  aria-describedby={`otp-help${errorId ? ` ${errorId}` : ''}`}
                  aria-invalid={Boolean(state.error)}
                  disabled={isVerifying || isRequesting}
                  required
                  onChange={handleCodeChange}
                />
                <p id="otp-help" className="field-help">
                  Можно вставить код целиком.
                </p>

                {state.error ? (
                  <p id="auth-error" className="error-message" role="alert">
                    {state.error}
                  </p>
                ) : null}
                {state.notice ? (
                  <p className="notice-message" role="status" aria-live="polite">
                    {state.notice}
                  </p>
                ) : null}

                <PrimaryButton
                  className="primary-button"
                  type="submit"
                  disabled={isVerifying || isRequesting}
                  aria-busy={isVerifying}
                >
                  {isVerifying ? 'Проверяем…' : 'Войти'}
                </PrimaryButton>
              </form>

              <div className="form-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={isVerifying || isRequesting}
                  onClick={() => dispatch({ type: 'edit-phone' })}
                >
                  Изменить номер
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={isVerifying || isRequesting || !state.phoneE164 || resendSeconds > 0}
                  onClick={() => {
                    if (state.phoneE164) requestCode(state.phoneE164);
                  }}
                >
                  {isRequesting
                    ? 'Отправляем…'
                    : resendSeconds > 0
                      ? `Новый код через ${resendSeconds} с`
                      : 'Получить новый код'}
                </button>
              </div>
            </>
          )}
          <BusyStatus action={state.busy} />
        </div>
      </section>
    </main>
  );
}
