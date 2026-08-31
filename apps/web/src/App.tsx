import { normalizePhoneE164 } from '@phub/auth';
import { PrimaryButton } from '@phub/ui';
import { lazy, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import padlHubLogoUrl from './assets/padlhub-logo.svg';
import vkIconUrl from './assets/vk-auth.svg';
import yandexIconUrl from './assets/yandex-auth.svg';
import { connectChatRealtime } from './chat-realtime-client.js';
import type { ChatRealtimeConnectionState } from './chat-realtime-client.js';
import type { ChatRealtimeUiState, ChatUiError, PendingChatMessage } from './ChatsPage.js';
import { consumeCommunityInviteToken } from './community-invite-token.js';
import {
  clearGameChatNavigation,
  consumeGameChatNavigation,
  type GameChatNavigationHint,
} from './game-chat-navigation.js';
import {
  createCommunityRealtimeTransport,
  type CommunityRealtimeSocket,
} from './community-realtime-transport.js';
import {
  isIOSBrowser,
  preferredAuthEntryView,
  type AuthEntryView,
} from './browser-auth-context.js';
import type { HomeSectionEnvelope } from './HomeDashboardPage.js';
import type {
  AuthGateway,
  AuthenticatedSession,
  BookingPreferences,
  BookingPreferencesUpdateRequest,
  CommunityMembershipPage,
  ConversationMessage,
  ConversationPage,
  HomeBase,
  HomeDashboard,
  LocationDetail,
  LocationList,
  NotificationInboxPage,
  PlayerProfileView,
  PhoneChallenge,
  ProfileLevelHistory,
  ProfilePrivacySettings,
  ProfilePrivacyUpdateRequest,
  ProfileFriendPage,
  ProfileFriendship,
  UserProfile,
  UserUpcomingBookings,
  VivaOAuthProvider,
  WebPushConfiguration,
} from './auth-gateway.js';
import { createMessagingCommandId } from './auth-gateway.js';
import {
  disableWebPush,
  enableWebPush,
  getWebPushBrowserState,
  type WebPushBrowserState,
} from './web-push-client.js';

const BookingsPage = lazy(() =>
  import('./BookingsPage.js').then((module) => ({ default: module.BookingsPage })),
);
const ChatsPage = lazy(() =>
  import('./ChatsPage.js').then((module) => ({ default: module.ChatsPage })),
);
const CommunitiesPage = lazy(() =>
  import('./CommunitiesPage.js').then((module) => ({ default: module.CommunitiesPage })),
);
const CommunityReadOnlyPage = lazy(() =>
  import('./CommunityReadOnlyPage.js').then((module) => ({
    default: module.CommunityReadOnlyPage,
  })),
);
const CommunityDetailPage = lazy(() =>
  import('./CommunityDetailPage.js').then((module) => ({ default: module.CommunityDetailPage })),
);
const CommunityInvitePage = lazy(() =>
  import('./CommunityInvitePage.js').then((module) => ({ default: module.CommunityInvitePage })),
);
const GamesPage = lazy(() =>
  import('./GamesPage.js').then((module) => ({ default: module.GamesPage })),
);
const CreateGamePage = lazy(() =>
  import('./CreateGamePage.js').then((module) => ({ default: module.CreateGamePage })),
);
const GiftCertificatesPage = lazy(() =>
  import('./GiftCertificatesPage.js').then((module) => ({ default: module.GiftCertificatesPage })),
);
const HomeDashboardPage = lazy(() =>
  import('./HomeDashboardPage.js').then((module) => ({ default: module.HomeDashboardPage })),
);
const LocationDetailPage = lazy(() =>
  import('./LocationDetailPage.js').then((module) => ({ default: module.LocationDetailPage })),
);
const LocationsPage = lazy(() =>
  import('./LocationsPage.js').then((module) => ({ default: module.LocationsPage })),
);
const NotificationsPage = lazy(() =>
  import('./NotificationsPage.js').then((module) => ({ default: module.NotificationsPage })),
);
const ProfilePage = lazy(() =>
  import('./ProfilePage.js').then((module) => ({ default: module.ProfilePage })),
);
const ProfileLevelHistoryPage = lazy(() =>
  import('./ProfileLevelHistoryPage.js').then((module) => ({
    default: module.ProfileLevelHistoryPage,
  })),
);
const TrainingsPage = lazy(() =>
  import('./TrainingsPage.js').then((module) => ({ default: module.TrainingsPage })),
);
const TournamentDetailPage = lazy(() =>
  import('./TournamentDetailPage.js').then((module) => ({ default: module.TournamentDetailPage })),
);

type View = 'restoring' | 'oauth' | 'phone' | 'otp' | 'home';
type BusyAction = 'start-viva' | 'request-code' | 'verify-code' | 'logout' | null;

type ProtectedRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'home-v2' }
  | { readonly kind: 'home-v3' }
  | { readonly kind: 'profile'; readonly userId?: string }
  | { readonly kind: 'profile-level-history' }
  | { readonly kind: 'bookings' }
  | {
      readonly kind: 'chats';
      readonly mode: 'list' | 'new' | 'thread';
      readonly conversationId?: string;
    }
  | { readonly kind: 'notifications' }
  | { readonly kind: 'communities' }
  | { readonly kind: 'community'; readonly communityId: string }
  | { readonly kind: 'community-invite' }
  | { readonly kind: 'locations' }
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'games' }
  | { readonly kind: 'game-create' }
  | { readonly kind: 'game'; readonly gameId: string }
  | { readonly kind: 'trainings' }
  | { readonly kind: 'tournaments' }
  | { readonly kind: 'gift-certificates' }
  | { readonly kind: 'section'; readonly title: string }
  | { readonly kind: 'not-found' };

const visibleWorkInProgressSections = [
  ['/coaches', 'Индивидуальные тренировки'],
  ['/subscriptions', 'Абонементы'],
  ['/promotions', 'Акции'],
  ['/offers', 'Предложения'],
] as const;

function resolveProtectedRoute(pathname: string): ProtectedRoute {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalizedPath === '/') return { kind: 'home' };
  if (normalizedPath === '/home-v2') return { kind: 'home-v2' };
  if (normalizedPath === '/home-v3') return { kind: 'home-v3' };
  if (normalizedPath === '/profile') return { kind: 'profile' };
  if (normalizedPath === '/profile/level-history') return { kind: 'profile-level-history' };
  const profileMatch = normalizedPath.match(
    /^\/profile\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (profileMatch?.[1]) return { kind: 'profile', userId: profileMatch[1] };
  if (normalizedPath === '/bookings') return { kind: 'bookings' };
  if (normalizedPath === '/chats') return { kind: 'chats', mode: 'list' };
  if (normalizedPath === '/chats/new') return { kind: 'chats', mode: 'new' };
  const chatMatch = normalizedPath.match(
    /^\/chats\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (chatMatch?.[1]) {
    return { kind: 'chats', mode: 'thread', conversationId: chatMatch[1] };
  }
  if (normalizedPath === '/notifications') return { kind: 'notifications' };
  if (normalizedPath === '/communities') return { kind: 'communities' };
  if (normalizedPath === '/community-invite') return { kind: 'community-invite' };
  const communityMatch = normalizedPath.match(
    /^\/communities\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (communityMatch?.[1]) return { kind: 'community', communityId: communityMatch[1] };
  if (normalizedPath === '/locations') return { kind: 'locations' };
  const locationMatch = normalizedPath.match(
    /^\/locations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (locationMatch?.[1]) return { kind: 'location', locationId: locationMatch[1] };
  if (normalizedPath === '/games') return { kind: 'games' };
  if (normalizedPath === '/games/new') return { kind: 'game-create' };
  if (normalizedPath === '/trainings') return { kind: 'trainings' };
  if (normalizedPath === '/tournaments') return { kind: 'tournaments' };
  if (normalizedPath === '/gift-certificates') return { kind: 'gift-certificates' };
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

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

type ChatOperation = 'list' | 'create' | 'history' | 'send' | 'read';

function chatUiError(error: unknown, operation: ChatOperation): ChatUiError {
  const code = errorCode(error);
  const status = errorStatus(error);
  if (status === 401 || code === 'AUTH_REQUIRED' || code === 'AUTH_TOKEN_INVALID') {
    return {
      kind: 'AUTH',
      message: 'Сессия завершилась. После входа безопасно откройте ссылку на чат ещё раз.',
    };
  }
  if (status === 403 || code === 'CONVERSATION_ACCESS_DENIED' || code === 'TENANT_ACCESS_DENIED') {
    return {
      kind: 'FORBIDDEN',
      message: 'Текущая учётная запись не является активным участником этого диалога.',
    };
  }
  if (
    code === 'FEATURE_UNAVAILABLE' ||
    code === 'MESSAGING_DISABLED' ||
    code === 'MESSAGING_HTTP_DISABLED' ||
    (status === 404 && operation === 'list') ||
    status === 503
  ) {
    return {
      kind: 'FEATURE_UNAVAILABLE',
      message: 'Контур чатов ещё не включён для этой организации. Остальные разделы работают.',
    };
  }
  if (status === 404 || code === 'CONVERSATION_NOT_FOUND' || code === 'USER_NOT_FOUND') {
    return {
      kind: 'NOT_FOUND',
      message:
        operation === 'create'
          ? 'Получатель недоступен для личного чата.'
          : 'Диалог не существует или больше не доступен текущему участнику.',
    };
  }
  return {
    kind: 'RETRYABLE',
    message:
      operation === 'send'
        ? 'Сервер не подтвердил отправку. Повтор использует тот же идентификатор сообщения.'
        : operation === 'read'
          ? 'Не удалось подтвердить прочтение. История сообщений сохранена.'
          : 'Проверьте соединение и повторите запрос.',
  };
}

const PADLHUB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mergeConversationMessages(
  current: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
): readonly ConversationMessage[] {
  const bySequence = new Map(current.map((message) => [message.sequence, message]));
  for (const message of incoming) bySequence.set(message.sequence, message);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
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

function CommunityRuntimeUnavailablePage(): React.JSX.Element {
  return (
    <main className="community-runtime-unavailable">
      <header className="community-runtime-unavailable__header">
        <a href="/" aria-label="Вернуться на главную">
          ←
        </a>
        <h1>Сообщества временно недоступны</h1>
      </header>
      <section className="community-runtime-unavailable__content">
        <p role="status">
          Сервис сообществ ещё не подключён для этой организации. Попробуйте позднее.
        </p>
      </section>
    </main>
  );
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
  readonly realtimeBaseUrl?: string;
  readonly realtimeUrl?: string;
}

const HOME_REFRESH_INTERVAL_MS = 30_000;
const NOTIFICATIONS_REFRESH_INTERVAL_MS = 15_000;
const CHATS_REFRESH_INTERVAL_MS = 5_000;
const CHAT_GAP_PAGE_LIMIT = 20;
const CHAT_HISTORY_PAGE_SIZE = 100;
const HOME_INITIAL_RETRY_DELAYS_MS = [
  400, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
] as const;

export function App({
  gateway,
  tenantKey,
  realtimeBaseUrl,
  realtimeUrl,
}: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const communityRealtimeTransport = useMemo(() => {
    if (!realtimeUrl || typeof WebSocket === 'undefined') return undefined;
    return createCommunityRealtimeTransport({
      url: realtimeUrl,
      issueTicket: gateway.issueRealtimeTicket,
      createSocket: (url) => new WebSocket(url) as unknown as CommunityRealtimeSocket,
    });
  }, [gateway, realtimeUrl]);
  const [communityInviteToken] = useState(() =>
    typeof window === 'undefined'
      ? null
      : consumeCommunityInviteToken(window.location, window.history),
  );
  const browserNavigator = typeof navigator === 'undefined' ? undefined : navigator;
  const iosBrowser = isIOSBrowser(browserNavigator);
  const entryView = preferredAuthEntryView(browserNavigator);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [homeBase, setHomeBase] = useState<HomeBase | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeReloadToken, setHomeReloadToken] = useState(0);
  const [homeViewer, setHomeViewer] = useState<HomeSectionEnvelope<UserProfile> | null>(null);
  const [homeViewerReloadToken, setHomeViewerReloadToken] = useState(0);
  const [homeUpcoming, setHomeUpcoming] =
    useState<HomeSectionEnvelope<UserUpcomingBookings> | null>(null);
  const [homeUpcomingRequested, setHomeUpcomingRequested] = useState(false);
  const [homeUpcomingReloadToken, setHomeUpcomingReloadToken] = useState(0);
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
  const [homeBookingPreferencesResolved, setHomeBookingPreferencesResolved] = useState(false);
  const [bookingPreferencesBusy, setBookingPreferencesBusy] = useState(false);
  const [bookingPreferencesError, setBookingPreferencesError] = useState<string | null>(null);
  const [bookingPreferencesNotice, setBookingPreferencesNotice] = useState<string | null>(null);
  const [bookingPreferenceStations, setBookingPreferenceStations] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);
  const [profileCommunities, setProfileCommunities] = useState<CommunityMembershipPage | null>(
    null,
  );
  const [profileCommunitiesError, setProfileCommunitiesError] = useState<string | null>(null);
  const [profileSubscriptions, setProfileSubscriptions] = useState<
    HomeDashboard['subscriptions'] | null
  >(null);
  const [profileSubscriptionsError, setProfileSubscriptionsError] = useState<string | null>(null);
  const [profileFriends, setProfileFriends] = useState<ProfileFriendPage | null>(null);
  const [profileFriendship, setProfileFriendship] = useState<ProfileFriendship | null>(null);
  const [profileFriendsBusy, setProfileFriendsBusy] = useState(false);
  const [profileFriendsError, setProfileFriendsError] = useState<string | null>(null);
  const [profileLevelHistory, setProfileLevelHistory] = useState<ProfileLevelHistory | null>(null);
  const [profileLevelHistoryError, setProfileLevelHistoryError] = useState<string | null>(null);
  const [upcomingBookings, setUpcomingBookings] = useState<UserUpcomingBookings | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationPage | null>(null);
  const [conversationMessages, setConversationMessages] = useState<readonly ConversationMessage[]>(
    [],
  );
  const [chatsError, setChatsError] = useState<ChatUiError | null>(null);
  const [chatsBusy, setChatsBusy] = useState<'create' | 'send' | 'refresh' | 'load-earlier' | null>(
    null,
  );
  const [chatsReloadToken, setChatsReloadToken] = useState(0);
  const [loadedRealtimeConversationId, setLoadedRealtimeConversationId] = useState<string | null>(
    null,
  );
  const [pendingChatMessage, setPendingChatMessage] = useState<
    (PendingChatMessage & { readonly conversationId: string }) | null
  >(null);
  const [chatRealtimeState, setChatRealtimeState] = useState<ChatRealtimeUiState | null>(null);
  const [hasEarlierChatMessages, setHasEarlierChatMessages] = useState(false);
  const [notifications, setNotifications] = useState<NotificationInboxPage | null>(null);
  const [webPushConfiguration, setWebPushConfiguration] = useState<WebPushConfiguration | null>(
    null,
  );
  const [webPushBrowserState, setWebPushBrowserState] =
    useState<WebPushBrowserState>('unsupported');
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [notificationsInboxUnavailable, setNotificationsInboxUnavailable] = useState(false);
  const [, refreshLocation] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    const handlePopState = (): void => refreshLocation();
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  const protectedRoute = resolveProtectedRoute(
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );
  const publicGiftRoute =
    typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/giftcard';
  const requestedProfileUserId =
    protectedRoute.kind === 'profile' ? protectedRoute.userId : undefined;
  const requestedLocationId =
    protectedRoute.kind === 'location' ? protectedRoute.locationId : undefined;
  const requestedConversationId =
    protectedRoute.kind === 'chats' ? protectedRoute.conversationId : undefined;
  const requestedChatRecipientId =
    protectedRoute.kind === 'chats' &&
    protectedRoute.mode === 'new' &&
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('recipientUserId')?.trim()
      : undefined;
  const validChatRecipientId =
    requestedChatRecipientId && PADLHUB_UUID_PATTERN.test(requestedChatRecipientId)
      ? requestedChatRecipientId
      : undefined;
  const isHomeRoute =
    protectedRoute.kind === 'home' ||
    protectedRoute.kind === 'home-v2' ||
    protectedRoute.kind === 'home-v3';
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const chatLastSequenceRef = useRef(0);
  const chatReadThroughRef = useRef(0);
  const chatRefreshInFlightRef = useRef(false);
  const chatRefreshPendingRef = useRef(false);
  const chatRefreshRef = useRef<() => void>(() => undefined);
  const chatEarlierAfterSequenceRef = useRef(0);
  const chatGameNavigationRef = useRef<{
    readonly tenantKey: string;
    readonly userId: string;
    readonly hint: GameChatNavigationHint;
  } | null>(null);
  const chatPendingMessageRef = useRef<
    (PendingChatMessage & { readonly conversationId: string }) | null
  >(null);
  const chatCreateCommandRef = useRef<{
    readonly recipientUserId: string;
    readonly idempotencyKey: string;
  } | null>(null);

  const realtimeSessionActive =
    state.view === 'home' &&
    state.session !== null &&
    state.session.context.runtimeCapabilities?.communityRealtime === true &&
    state.busy !== 'logout';
  useEffect(() => {
    if (!communityRealtimeTransport || !realtimeSessionActive) {
      communityRealtimeTransport?.stop();
      return;
    }
    communityRealtimeTransport.start();
    return () => communityRealtimeTransport.stop();
  }, [communityRealtimeTransport, realtimeSessionActive]);

  useEffect(() => () => communityRealtimeTransport?.clear(), [communityRealtimeTransport]);

  useEffect(() => {
    if (publicGiftRoute) return;
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
  }, [entryView, gateway, publicGiftRoute]);

  useEffect(() => {
    if (state.view !== 'home' || !state.session || !isHomeRoute) return;
    let active = true;
    void gateway.getSelfProfile().then(
      (profile) => {
        if (active) setHomeViewer({ state: 'READY', value: profile });
      },
      () => {
        if (active) {
          setHomeViewer({
            state: 'UNAVAILABLE',
            message: 'Не удалось обновить данные игрока.',
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, homeViewerReloadToken, isHomeRoute, state.session, state.view]);

  useEffect(() => {
    if (state.view !== 'home' || !state.session || !isHomeRoute) return;
    let active = true;
    void gateway.getBookingPreferences().then(
      (settings) => {
        if (active) {
          setBookingPreferences(settings);
          setHomeBookingPreferencesResolved(true);
        }
      },
      () => {
        if (active) {
          setBookingPreferences(null);
          setHomeBookingPreferencesResolved(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, isHomeRoute, state.session, state.view]);

  useEffect(() => {
    if (state.view !== 'home' || !state.session || !isHomeRoute || !homeUpcomingRequested) {
      return;
    }
    let active = true;
    void gateway.getUpcomingBookings().then(
      (bookings) => {
        if (!active) return;
        setHomeUpcoming({
          state: Date.parse(bookings.staleAt) <= Date.now() ? 'STALE' : 'READY',
          value: bookings,
        });
      },
      () => {
        if (active) {
          setHomeUpcoming({
            state: 'UNAVAILABLE',
            message:
              'Не удалось получить актуальные записи. Остальные разделы продолжают работать.',
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [
    gateway,
    homeUpcomingReloadToken,
    homeUpcomingRequested,
    isHomeRoute,
    state.session,
    state.view,
  ]);

  useEffect(() => {
    if (state.view !== 'home' || !state.session) return;
    let active = true;
    if (protectedRoute.kind === 'profile-level-history') {
      void gateway.getProfileLevelHistory().then(
        (history) => {
          if (!active) return;
          setProfileLevelHistory(history);
          setProfileLevelHistoryError(null);
        },
        () => {
          if (!active) return;
          setProfileLevelHistory(null);
          setProfileLevelHistoryError('Не удалось загрузить историю уровня.');
        },
      );
      return () => {
        active = false;
      };
    }
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
        void gateway.listMyCommunities().then(
          (page) => {
            if (!active) return;
            setProfileCommunities(page);
            setProfileCommunitiesError(null);
          },
          () => {
            if (!active) return;
            setProfileCommunities({ items: [] });
            setProfileCommunitiesError('Не удалось загрузить сообщества.');
          },
        );
        void Promise.resolve().then(() => {
          if (!active) return;
          setProfileSubscriptions(null);
          setProfileSubscriptionsError(
            'Подписки и абонементы временно недоступны. Остальные данные профиля загружены.',
          );
        });
        void gateway.listProfileFriends(8).then(
          (page) => {
            if (!active) return;
            setProfileFriends(page);
            setProfileFriendsError(null);
          },
          () => {
            if (!active) return;
            setProfileFriends({ items: [] });
            setProfileFriendsError('Не удалось загрузить друзей.');
          },
        );
      } else {
        void gateway.getProfileFriendship(targetUserId).then(
          (friendship) => {
            if (!active) return;
            setProfileFriendship(friendship);
            setProfileFriendsError(null);
          },
          () => {
            if (!active) return;
            setProfileFriendsError('Не удалось проверить статус дружбы.');
          },
        );
      }
      void gateway.listNotifications().then(
        (page) => {
          if (active) setNotifications(page);
        },
        () => undefined,
      );
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
              setProfileCommunities(null);
              setProfileCommunitiesError(null);
              setProfileSubscriptions(null);
              setProfileSubscriptionsError(null);
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
    if (protectedRoute.kind === 'chats') {
      chatLastSequenceRef.current = 0;
      chatReadThroughRef.current = 0;
      chatRefreshInFlightRef.current = false;
      chatRefreshPendingRef.current = false;
      chatEarlierAfterSequenceRef.current = 0;
      const previousPendingMessage = chatPendingMessageRef.current;
      const preservedFailedMessage =
        previousPendingMessage?.state === 'failed' &&
        previousPendingMessage.conversationId === requestedConversationId
          ? previousPendingMessage
          : null;
      chatPendingMessageRef.current = preservedFailedMessage;
      const chatNavigationUserId = state.session.context.user.id;
      const cachedGameChatNavigation = chatGameNavigationRef.current;
      const gameChatNavigation =
        requestedConversationId &&
        cachedGameChatNavigation?.tenantKey === tenantKey &&
        cachedGameChatNavigation.userId === chatNavigationUserId &&
        cachedGameChatNavigation.hint.conversationId === requestedConversationId
          ? cachedGameChatNavigation.hint
          : requestedConversationId
            ? consumeGameChatNavigation(
                { tenantKey, userId: chatNavigationUserId },
                requestedConversationId,
              )
            : undefined;
      chatGameNavigationRef.current = gameChatNavigation
        ? { tenantKey, userId: chatNavigationUserId, hint: gameChatNavigation }
        : null;
      let initialHistoryOutcome: 'pending' | 'loaded' | 'failed' = requestedConversationId
        ? 'pending'
        : 'loaded';

      const readMessageGap = async (
        conversationId: string,
        afterSequence: number,
      ): Promise<readonly ConversationMessage[]> => {
        const messages: ConversationMessage[] = [];
        let cursor = afterSequence;
        for (let pageIndex = 0; pageIndex < CHAT_GAP_PAGE_LIMIT; pageIndex += 1) {
          const page = await gateway.listConversationMessages(conversationId, cursor);
          messages.push(...page.messages);
          const newestSequence = page.messages.at(-1)?.sequence ?? cursor;
          const nextCursor = page.nextAfterSequence ?? newestSequence;
          if (nextCursor <= cursor || page.messages.length === 0 || !page.nextAfterSequence) break;
          cursor = nextCursor;
        }
        return messages;
      };

      const refreshChats = async (): Promise<void> => {
        if (!active) return;
        if (chatRefreshInFlightRef.current) {
          chatRefreshPendingRef.current = true;
          return;
        }
        chatRefreshInFlightRef.current = true;
        const listResult = await gateway.listConversations().then(
          (page) => ({ status: 'fulfilled' as const, page }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        const navigationConversation: ConversationPage['items'][number] | undefined =
          gameChatNavigation
            ? {
                id: gameChatNavigation.conversationId,
                kind: 'GAME' as const,
                contextId: gameChatNavigation.contextId,
                title: gameChatNavigation.title,
                unreadCount: 0,
                updatedAt: gameChatNavigation.updatedAt,
              }
            : undefined;
        const effectiveConversationPage =
          listResult.status === 'fulfilled' &&
          navigationConversation &&
          !listResult.page.items.some(
            (conversation) => conversation.id === navigationConversation.id,
          )
            ? { items: [navigationConversation, ...listResult.page.items] }
            : listResult.status === 'fulfilled'
              ? listResult.page
              : undefined;
        const selectedConversation = requestedConversationId
          ? effectiveConversationPage?.items.find(
              (conversation) => conversation.id === requestedConversationId,
            )
          : undefined;
        const initialAfterSequence =
          initialHistoryOutcome === 'pending' && chatLastSequenceRef.current === 0
            ? Math.max(
                0,
                (selectedConversation?.lastMessage?.sequence ??
                  gameChatNavigation?.lastSequence ??
                  0) - CHAT_HISTORY_PAGE_SIZE,
              )
            : chatLastSequenceRef.current;
        const historyResult = requestedConversationId
          ? await readMessageGap(requestedConversationId, initialAfterSequence).then(
              (messages) => ({ status: 'fulfilled' as const, messages }),
              (error: unknown) => ({ status: 'rejected' as const, error }),
            )
          : ({ status: 'skipped' } as const);
        chatRefreshInFlightRef.current = false;
        if (chatRefreshPendingRef.current && active) {
          chatRefreshPendingRef.current = false;
          void Promise.resolve().then(refreshChats);
        }
        if (!active) return;

        if (listResult.status === 'fulfilled') setConversations(listResult.page);
        else {
          setConversations(null);
          setLoadedRealtimeConversationId(null);
          setChatsError(chatUiError(listResult.error, 'list'));
          setChatsBusy((current) => (current === 'refresh' ? null : current));
          return;
        }

        if (historyResult.status === 'rejected') {
          if (initialHistoryOutcome === 'pending') {
            initialHistoryOutcome = 'failed';
            setLoadedRealtimeConversationId(null);
          }
          setChatsError(chatUiError(historyResult.error, 'history'));
          setChatsBusy((current) => (current === 'refresh' ? null : current));
          return;
        }
        if (historyResult.status === 'fulfilled') {
          setConversations(effectiveConversationPage ?? listResult.page);
          const loadingInitialHistory = initialHistoryOutcome === 'pending';
          const pending = chatPendingMessageRef.current;
          if (
            pending &&
            historyResult.messages.some(
              (message) => message.clientMessageId === pending.clientMessageId,
            )
          ) {
            chatPendingMessageRef.current = null;
            setPendingChatMessage(null);
            setChatsBusy((current) => (current === 'send' ? null : current));
          }
          if (requestedConversationId && initialHistoryOutcome === 'pending') {
            initialHistoryOutcome = 'loaded';
            setLoadedRealtimeConversationId(requestedConversationId);
          } else if (initialHistoryOutcome === 'failed') {
            setLoadedRealtimeConversationId(null);
          }
          const newestSequence = historyResult.messages.at(-1)?.sequence;
          if (newestSequence !== undefined) {
            chatLastSequenceRef.current = Math.max(chatLastSequenceRef.current, newestSequence);
            setConversationMessages((current) =>
              mergeConversationMessages(current, historyResult.messages),
            );
            if (loadingInitialHistory) {
              chatEarlierAfterSequenceRef.current = initialAfterSequence;
              setHasEarlierChatMessages(initialAfterSequence > 0);
            }
            if (
              requestedConversationId &&
              chatLastSequenceRef.current > chatReadThroughRef.current
            ) {
              const readThroughSequence = chatLastSequenceRef.current;
              const readCommandId = createMessagingCommandId();
              void gateway
                .markConversationRead(requestedConversationId, readThroughSequence, readCommandId)
                .then(
                  () => {
                    chatReadThroughRef.current = Math.max(
                      chatReadThroughRef.current,
                      readThroughSequence,
                    );
                  },
                  () => undefined,
                );
            }
          }
        }
        setChatsError(null);
        setChatsBusy((current) => (current === 'refresh' ? null : current));
      };
      chatRefreshRef.current = () => void refreshChats();

      void Promise.resolve().then(() => {
        if (!active) return;
        setLoadedRealtimeConversationId(null);
        setChatRealtimeState(requestedConversationId && !realtimeBaseUrl ? 'polling' : null);
        setConversationMessages([]);
        setHasEarlierChatMessages(false);
        setPendingChatMessage(preservedFailedMessage);
        setChatsError(null);
        void refreshChats();
      });
      const refreshInterval = window.setInterval(
        () => void refreshChats(),
        CHATS_REFRESH_INTERVAL_MS,
      );
      return () => {
        active = false;
        chatRefreshInFlightRef.current = false;
        chatRefreshPendingRef.current = false;
        chatRefreshRef.current = () => undefined;
        setLoadedRealtimeConversationId(null);
        setChatRealtimeState(null);
        window.clearInterval(refreshInterval);
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
            setNotificationsInboxUnavailable(false);
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
          setNotificationsInboxUnavailable(false);
        } else {
          setNotifications({ items: [], unreadCount: 0 });
          setNotificationsInboxUnavailable(true);
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
    if (
      protectedRoute.kind !== 'home' &&
      protectedRoute.kind !== 'home-v2' &&
      protectedRoute.kind !== 'home-v3'
    )
      return;
    let homeRetryTimer: number | undefined;
    let homeLoaded = false;
    const refreshHome = (attempt = 0): void => {
      void gateway.getHomeBase().then(
        (dashboard) => {
          if (active) {
            homeLoaded = true;
            setHomeBase(dashboard);
            setHomeError(null);
          }
        },
        () => {
          if (!active) return;
          const retryDelay = HOME_INITIAL_RETRY_DELAYS_MS[attempt];
          if (!homeLoaded && retryDelay !== undefined) {
            homeRetryTimer = window.setTimeout(() => refreshHome(attempt + 1), retryDelay);
            return;
          }
          setHomeError('Не удалось загрузить Главную. Проверьте связь и повторите.');
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
      if (homeRetryTimer !== undefined) window.clearTimeout(homeRetryTimer);
      window.clearInterval(homeRefreshInterval);
      window.clearInterval(notificationRefreshInterval);
      window.removeEventListener('focus', refreshHomeContent);
      document.removeEventListener('visibilitychange', refreshVisibleHome);
    };
  }, [
    gateway,
    chatsReloadToken,
    protectedRoute.kind,
    realtimeBaseUrl,
    requestedConversationId,
    requestedLocationId,
    requestedProfileUserId,
    homeReloadToken,
    state.session,
    state.view,
    tenantKey,
  ]);

  useEffect(() => {
    if (
      !loadedRealtimeConversationId ||
      loadedRealtimeConversationId !== requestedConversationId ||
      !realtimeBaseUrl
    ) {
      return;
    }
    const realtime = connectChatRealtime({
      baseUrl: realtimeBaseUrl,
      tenantKey,
      conversationId: loadedRealtimeConversationId,
      getTicket: () => gateway.createRealtimeTicket(),
      getAfterSequence: () => chatLastSequenceRef.current,
      onRecoveryRequired: (afterSequence) => {
        if (afterSequence < chatLastSequenceRef.current) {
          chatLastSequenceRef.current = afterSequence;
          chatReadThroughRef.current = Math.min(chatReadThroughRef.current, afterSequence);
          if (afterSequence === 0) {
            setConversationMessages([]);
            setHasEarlierChatMessages(false);
            chatEarlierAfterSequenceRef.current = 0;
          }
        }
        chatRefreshRef.current();
      },
      onConnectionStateChange: (connectionState: ChatRealtimeConnectionState) =>
        setChatRealtimeState(connectionState),
    });
    return () => realtime.stop();
  }, [gateway, loadedRealtimeConversationId, realtimeBaseUrl, requestedConversationId, tenantKey]);

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
    communityRealtimeTransport?.stop();
    dispatch({ type: 'logout-started' });
    const serviceWorkerUrl =
      window.__PHUB_BOOTSTRAP__?.serviceWorkerUrl ?? '/phub-notification-sw.js';
    void disableWebPush({ gateway, serviceWorkerUrl })
      .catch(() => undefined)
      .then(() => gateway.logout())
      .then(
        () => {
          clearGameChatNavigation();
          setHomeBase(null);
          setHomeError(null);
          setHomeViewer(null);
          setHomeUpcoming(null);
          setHomeUpcomingRequested(false);
          setLocations(null);
          setLocationDetail(null);
          setLocationsError(null);
          setUserProfile(null);
          setProfileError(null);
          setBookingPreferences(null);
          setBookingPreferencesError(null);
          setBookingPreferencesNotice(null);
          setBookingPreferenceStations([]);
          setProfileCommunities(null);
          setProfileCommunitiesError(null);
          setProfileSubscriptions(null);
          setProfileSubscriptionsError(null);
          setUpcomingBookings(null);
          setBookingsError(null);
          setConversations(null);
          setConversationMessages([]);
          setHasEarlierChatMessages(false);
          setChatsError(null);
          setChatsBusy(null);
          setPendingChatMessage(null);
          chatPendingMessageRef.current = null;
          chatGameNavigationRef.current = null;
          setChatRealtimeState(null);
          chatCreateCommandRef.current = null;
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

  function handleCreateDirectConversation(): void {
    if (!validChatRecipientId) return;
    const existingCommand = chatCreateCommandRef.current;
    const command =
      existingCommand?.recipientUserId === validChatRecipientId
        ? existingCommand
        : {
            recipientUserId: validChatRecipientId,
            idempotencyKey: createMessagingCommandId(),
          };
    chatCreateCommandRef.current = command;
    setChatsBusy('create');
    setChatsError(null);
    void gateway.createDirectConversation(command.recipientUserId, command.idempotencyKey).then(
      (result) => {
        chatCreateCommandRef.current = null;
        setChatsBusy(null);
        window.history.pushState({}, '', `/chats/${result.conversation.id}`);
        setChatsReloadToken((token) => token + 1);
      },
      (error: unknown) => {
        setChatsError(chatUiError(error, 'create'));
        setChatsBusy(null);
      },
    );
  }

  function sendChatCommand(command: {
    readonly conversationId: string;
    readonly clientMessageId: string;
    readonly body: string;
  }): void {
    setChatsBusy('send');
    setChatsError(null);
    const sendingMessage = { ...command, state: 'sending' as const };
    chatPendingMessageRef.current = sendingMessage;
    setPendingChatMessage(sendingMessage);
    void gateway
      .sendConversationMessage(command.conversationId, {
        clientMessageId: command.clientMessageId,
        body: command.body,
      })
      .then(
        (result) => {
          if (chatPendingMessageRef.current?.clientMessageId !== command.clientMessageId) return;
          setConversationMessages((current) =>
            mergeConversationMessages(current, [result.message]),
          );
          chatLastSequenceRef.current = Math.max(
            chatLastSequenceRef.current,
            result.message.sequence,
          );
          chatPendingMessageRef.current = null;
          setPendingChatMessage(null);
          setChatsBusy(null);
          setChatsError(null);
          chatRefreshRef.current();
        },
        (error: unknown) => {
          if (chatPendingMessageRef.current?.clientMessageId !== command.clientMessageId) return;
          const failedMessage = { ...command, state: 'failed' as const };
          chatPendingMessageRef.current = failedMessage;
          setPendingChatMessage(failedMessage);
          setChatsError(chatUiError(error, 'send'));
          setChatsBusy(null);
        },
      );
  }

  function handleSendConversationMessage(body: string): void {
    if (!requestedConversationId) return;
    const command = {
      conversationId: requestedConversationId,
      clientMessageId: createMessagingCommandId(),
      body,
    };
    sendChatCommand(command);
  }

  function handleRetryConversationMessage(): void {
    if (pendingChatMessage?.state === 'failed') sendChatCommand(pendingChatMessage);
  }

  function handleRefreshChats(): void {
    setChatsBusy('refresh');
    setChatsError(null);
    setChatsReloadToken((token) => token + 1);
  }

  function handleLoadEarlierChatMessages(): void {
    if (!requestedConversationId) return;
    const earliestSequence = conversationMessages[0]?.sequence;
    const earlierCursor = chatEarlierAfterSequenceRef.current;
    if (!earliestSequence || earlierCursor <= 0) {
      setHasEarlierChatMessages(false);
      return;
    }
    const afterSequence = Math.max(0, earlierCursor - CHAT_HISTORY_PAGE_SIZE);
    setChatsBusy('load-earlier');
    setChatsError(null);
    void gateway.listConversationMessages(requestedConversationId, afterSequence).then(
      (page) => {
        const earlier = page.messages.filter((message) => message.sequence < earliestSequence);
        setConversationMessages((current) => mergeConversationMessages(current, earlier));
        chatEarlierAfterSequenceRef.current = afterSequence;
        setHasEarlierChatMessages(afterSequence > 0);
        setChatsBusy(null);
      },
      (error: unknown) => {
        setChatsError(chatUiError(error, 'history'));
        setChatsBusy(null);
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

  function navigateToNotificationTarget(href: string): void {
    window.history.pushState({}, '', href);
    refreshLocation();
  }

  function handleOpenNotification(
    item: NotificationInboxPage['items'][number],
    href: string,
    navigate: boolean,
  ): void {
    if (item.readAt) {
      if (navigate) navigateToNotificationTarget(href);
      return;
    }
    setNotificationsBusy(true);
    setNotificationsError(null);
    void gateway.markNotificationsRead(item.id).then(
      () => {
        if (navigate) navigateToNotificationTarget(href);
        setNotificationsBusy(false);
      },
      () => {
        setNotificationsError('Не удалось отметить оповещение прочитанным. Повторите переход.');
        setNotificationsBusy(false);
      },
    );
  }

  function handleRetryNotificationInbox(): void {
    if (notificationsBusy) return;
    setNotificationsBusy(true);
    void gateway.listNotifications().then(
      (page) => {
        setNotifications(page);
        setNotificationsInboxUnavailable(false);
        setNotificationsError(null);
        setNotificationsBusy(false);
      },
      () => {
        setNotificationsInboxUnavailable(true);
        setNotificationsError('Лента оповещений временно недоступна.');
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

  function handleAddProfileFriend(): void {
    if (!requestedProfileUserId || profileFriendship?.status === 'FRIEND') return;
    setProfileFriendsBusy(true);
    setProfileFriendsError(null);
    void gateway.addProfileFriend(requestedProfileUserId).then(
      (friendship) => {
        setProfileFriendship(friendship);
        setProfileFriendsBusy(false);
      },
      () => {
        setProfileFriendsBusy(false);
        setProfileFriendsError('Не удалось добавить игрока в друзья. Повторите попытку.');
      },
    );
  }

  if (publicGiftRoute) {
    return (
      <GiftCertificatesPage
        surface="public"
        gateway={{
          getCatalog: gateway.getPublicGiftCertificateCatalog,
          createOrder: gateway.createPublicGiftCertificateOrder,
          createPayment: gateway.createPublicGiftCertificatePaymentIntent,
          getOrder: gateway.getPublicGiftCertificateOrder,
          downloadCertificate: gateway.downloadPublicGiftCertificate,
        }}
      />
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
    if (protectedRoute.kind === 'profile-level-history') {
      return (
        <ProfileLevelHistoryPage history={profileLevelHistory} error={profileLevelHistoryError} />
      );
    }
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
          logoutBusy={state.busy === 'logout'}
          notificationUnreadCount={notifications?.unreadCount ?? 0}
          privacySettings={profilePrivacy}
          privacyBusy={profilePrivacyBusy}
          privacyError={profilePrivacyError}
          privacyNotice={profilePrivacyNotice}
          bookingPreferences={bookingPreferences}
          bookingPreferencesBusy={bookingPreferencesBusy}
          bookingPreferencesError={bookingPreferencesError}
          bookingPreferencesNotice={bookingPreferencesNotice}
          stationChoices={bookingPreferenceStations}
          subscriptions={profileSubscriptions}
          subscriptionsError={profileSubscriptionsError}
          communities={profileCommunities}
          communitiesError={profileCommunitiesError}
          friends={profileFriends}
          friendship={profileFriendship}
          friendsBusy={profileFriendsBusy}
          friendsError={profileFriendsError}
          error={state.error}
          onSavePrivacy={handleSaveProfilePrivacy}
          onSaveBookingPreferences={handleSaveBookingPreferences}
          onAddFriend={handleAddProfileFriend}
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
          loadHistory={gateway.getActivityHistory}
          loadRecommendations={() => gateway.listBookingRecommendations({ limit: 20 })}
        />
      );
    }
    if (protectedRoute.kind === 'chats') {
      return (
        <ChatsPage
          page={conversations}
          messages={conversationMessages}
          mode={protectedRoute.mode}
          {...(requestedConversationId ? { selectedConversationId: requestedConversationId } : {})}
          hasExplicitRecipient={Boolean(validChatRecipientId)}
          currentUserId={context.user.id}
          busy={chatsBusy}
          error={chatsError}
          pendingMessage={
            pendingChatMessage?.conversationId === requestedConversationId
              ? pendingChatMessage
              : null
          }
          realtimeState={requestedConversationId ? chatRealtimeState : null}
          hasEarlierMessages={hasEarlierChatMessages}
          canRetrySend={
            pendingChatMessage?.state === 'failed' &&
            pendingChatMessage.conversationId === requestedConversationId
          }
          onCreateDirect={handleCreateDirectConversation}
          onSendMessage={handleSendConversationMessage}
          onRetrySend={handleRetryConversationMessage}
          onRefresh={handleRefreshChats}
          onLoadEarlier={handleLoadEarlierChatMessages}
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
          inboxUnavailable={notificationsInboxUnavailable}
          onEnableWebPush={handleEnableWebPush}
          onDisableWebPush={handleDisableWebPush}
          onMarkAllRead={handleMarkAllNotificationsRead}
          onRetryInbox={handleRetryNotificationInbox}
          onOpenNotification={handleOpenNotification}
        />
      );
    }
    if (protectedRoute.kind === 'communities') {
      if (context.runtimeCapabilities?.communityDirectory === false) {
        return <CommunityRuntimeUnavailablePage />;
      }
      return (
        <CommunitiesPage
          tenantName={context.tenant.name}
          loadPage={gateway.listMyCommunities}
          readExperienceEnabled={context.runtimeCapabilities?.communityReadDetail === true}
          {...(context.runtimeCapabilities?.communityCanonical === true
            ? { discoverPage: gateway.discoverCommunities }
            : {})}
        />
      );
    }
    if (protectedRoute.kind === 'community-invite') {
      if (context.runtimeCapabilities?.communityDirectInvites !== true) {
        return <CommunityRuntimeUnavailablePage />;
      }
      return (
        <CommunityInvitePage
          token={communityInviteToken}
          previewInvite={gateway.previewCommunityDirectInvite}
          redeemInvite={gateway.redeemCommunityDirectInvite}
        />
      );
    }
    if (protectedRoute.kind === 'community') {
      if (context.runtimeCapabilities?.communityCanonical === true) {
        return (
          <CommunityDetailPage
            key={protectedRoute.communityId}
            communityId={protectedRoute.communityId}
            communityDirectInvitesEnabled={
              state.session.context.runtimeCapabilities?.communityDirectInvites === true
            }
            loadDetail={gateway.getCommunityDetail}
            loadMembershipState={gateway.getMyCommunityMembershipState}
            joinOrRequestMembership={gateway.joinOrRequestCommunityMembership}
            cancelJoinRequest={gateway.cancelMyCommunityJoinRequest}
            leaveMembership={gateway.leaveCommunity}
            loadInvites={gateway.listCommunityDirectInvites}
            createInvite={gateway.createCommunityDirectInvite}
            revokeInvite={gateway.revokeCommunityDirectInvite}
            loadFeed={gateway.listCommunityFeed}
            issueMediaUpload={gateway.issueCommunityMediaUpload}
            finalizeMediaUpload={gateway.finalizeCommunityMediaUpload}
            getMediaStatus={gateway.getCommunityMediaStatus}
            createPost={gateway.createCommunityPost}
            loadMediaVariant={gateway.downloadCommunityMediaVariant}
            recoverCommunityEvents={gateway.recoverCommunityEvents}
            {...(communityRealtimeTransport
              ? { realtimeTransport: communityRealtimeTransport }
              : {})}
          />
        );
      }
      if (context.runtimeCapabilities?.communityReadDetail === true) {
        return (
          <CommunityReadOnlyPage
            key={protectedRoute.communityId}
            communityId={protectedRoute.communityId}
            feedEnabled={context.runtimeCapabilities?.communityReadFeed === true}
            chatEnabled={context.runtimeCapabilities?.communityReadChat === true}
            ratingEnabled={context.runtimeCapabilities?.communityReadRating === true}
            loadDetail={gateway.getCommunityReadExperienceDetail}
            loadFeed={gateway.listCommunityReadExperienceFeed}
            loadChat={gateway.listCommunityReadExperienceChat}
            loadRating={gateway.getCommunityReadExperienceRating}
          />
        );
      }
      return <CommunityRuntimeUnavailablePage />;
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
      const eventId =
        protectedRoute.kind === 'games' && typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('event')
          : null;
      return (
        <GamesPage
          gateway={gateway}
          chatNavigationScope={{ tenantKey, userId: context.user.id }}
          {...(protectedRoute.kind === 'game' ? { gameId: protectedRoute.gameId } : {})}
          {...(eventId ? { eventId } : {})}
        />
      );
    }
    if (protectedRoute.kind === 'game-create') {
      const createGamePrincipal = {
        tenantId: state.session.context.tenant.id,
        userId: state.session.context.user.id,
      };
      return (
        <CreateGamePage
          key={`${createGamePrincipal.tenantId}:${createGamePrincipal.userId}`}
          gateway={gateway}
          principal={createGamePrincipal}
        />
      );
    }
    if (protectedRoute.kind === 'trainings') {
      return <TrainingsPage gateway={gateway} />;
    }
    if (protectedRoute.kind === 'tournaments') {
      const tournamentId =
        typeof window === 'undefined'
          ? null
          : new URLSearchParams(window.location.search).get('event');
      return <TournamentDetailPage gateway={gateway} tournamentId={tournamentId} />;
    }
    if (protectedRoute.kind === 'gift-certificates') {
      return (
        <GiftCertificatesPage
          surface="user"
          gateway={{
            getCatalog: gateway.getPublicGiftCertificateCatalog,
            createOrder: gateway.createGiftCertificateOrder,
            createPayment: gateway.createGiftCertificatePaymentIntent,
            getOrder: gateway.getGiftCertificateOrder,
            downloadCertificate: gateway.downloadGiftCertificate,
          }}
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
    if (!homeBase || !homeBookingPreferencesResolved) {
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
              onClick={() => {
                setHomeError(null);
                setHomeReloadToken((token) => token + 1);
              }}
            >
              Обновить
            </button>
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
        dashboard={homeBase}
        viewerFallback={context.user}
        viewer={homeViewer}
        upcoming={homeUpcoming}
        tenantName={context.tenant.name}
        layoutVariant={
          protectedRoute.kind === 'home-v2'
            ? 'v2'
            : protectedRoute.kind === 'home-v3'
              ? 'v3'
              : 'default'
        }
        recommendationDisplay={bookingPreferences?.recommendationDisplay ?? 'CARDS'}
        notificationUnreadCount={notifications?.unreadCount ?? 0}
        loadCommunityPage={gateway.listMyCommunities}
        communityPageSize={10}
        loadBookingRecommendations={(input) =>
          gateway.listHomeBookingRecommendations
            ? gateway.listHomeBookingRecommendations(input)
            : gateway.listBookingRecommendations(input)
        }
        recordPromotionEngagement={(promotionId, kind) =>
          gateway.recordPromotionEngagement(promotionId, kind)
        }
        loadActivityHistory={gateway.getActivityHistory}
        logoutBusy={state.busy === 'logout'}
        error={state.error}
        onRetryViewer={() => {
          setHomeViewer(null);
          setHomeViewerReloadToken((token) => token + 1);
        }}
        onActivateUpcoming={() => setHomeUpcomingRequested(true)}
        onRetryUpcoming={() => {
          setHomeUpcoming(null);
          setHomeUpcomingReloadToken((token) => token + 1);
        }}
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
                    Во встроенном браузере Telegram вход через Yandex может потерять сессию. Нажмите
                    ••• → «Открыть в Safari» и начните вход с исходной страницы.
                  </span>
                </div>
              ) : null}

              <div className="viva-login-options" aria-label="Способ входа через Viva">
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
                    <a href="https://padlhub.ru/docs" target="_blank" rel="noreferrer">
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
                    <a href="https://padlhub.ru/politica" target="_blank" rel="noreferrer">
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
              {!iosBrowser ? (
                <button
                  className="text-button auth-alternative"
                  type="button"
                  disabled={isStartingViva}
                  onClick={() => dispatch({ type: 'edit-phone' })}
                >
                  Войти по номеру телефона
                </button>
              ) : null}
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
                      <a href="https://padlhub.ru/docs" target="_blank" rel="noreferrer">
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
                      <a href="https://padlhub.ru/politica" target="_blank" rel="noreferrer">
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
