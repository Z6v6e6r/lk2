// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GamesPage } from './GamesPage.js';
import { buildMockHomeDashboard } from '../../api/src/home/home-dashboard.js';
import {
  beginGameJoinAttempt,
  discardGameJoinAttempt,
  loadGameJoinAttempt,
  markGameJoinAttemptDispatchStarted,
  resolveGameJoinAttempt,
  type GameJoinAttemptPrincipal,
} from './game-join-attempt.js';
import type { BookingRecommendationActivity } from './booking-activity-kind.js';
import { consumeGameChatNavigation } from './game-chat-navigation.js';
import { profileUserIdForParticipant } from './game-participant-profile.js';
import type {
  AuthGateway,
  EventCatalogPage,
  EventCatalogQuery,
  GameCard as ViewerGameCard,
  PlayerLevelState,
  PublicGameCard,
  PublicTournamentSummary,
} from './auth-gateway.js';

type GamesCatalogTestItem =
  | { readonly kind: 'GAME'; readonly game: PublicGameCard }
  | { readonly kind: 'COACH_GAME'; readonly activity: BookingRecommendationActivity }
  | { readonly kind: 'TOURNAMENT'; readonly tournament: PublicTournamentSummary };

const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' });

const game: PublicGameCard = {
  id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
  revision: 7,
  surface: 'DISCOVER',
  displayState: 'ONE_SPOT_LEFT',
  title: 'Рейтинговая игра вечером',
  kind: 'RATING',
  visibility: 'PUBLIC',
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:00:00.000Z',
  timezone: 'Europe/Moscow',
  station: { id: 'a8df730b-6a67-41a5-8772-48bca84f73bc', name: 'Селигерская' },
  court: { id: 'bd35543d-c565-443a-bd3d-eea68eb2fbe6', name: 'Корт №3' },
  levelRange: { from: 'C', to: 'C+' },
  rosterState: 'LAST_SPOT',
  capacity: { total: 4, occupied: 3, reserved: 0, open: 1, waitlistCount: 0 },
  participants: [
    { displayName: 'Анна', avatarUrl: null, level: 'C', role: 'ORGANIZER' },
    { displayName: 'Борис', avatarUrl: null, level: 'C', role: 'PLAYER' },
    { displayName: 'Вера', avatarUrl: null, level: 'C+', role: 'PLAYER' },
  ],
  priceSummary: null,
  viewerRelation: 'ANONYMOUS',
  viewerPaymentState: 'NOT_REQUIRED',
  badges: ['RATING'],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
};

function playerLevelState(code: string, rank: number): PlayerLevelState {
  return {
    sportCode: 'PADEL',
    scaleVersion: 1,
    levels: [],
    currentLevel: {
      playerId: '11111111-1111-4111-8111-111111111111',
      sportCode: 'PADEL',
      levelId: '22222222-2222-4222-8222-222222222222',
      code,
      title: code,
      rank,
      source: 'SELF_DECLARED',
      numericValue: null,
      scaleVersion: 1,
      updatedAt: '2026-08-25T10:00:00.000Z',
    },
  };
}

const tournament: PublicTournamentSummary = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Воскресный Мексикано',
  format: 'Мексикано',
  startsAt: new Date(Date.now() + 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 10_800_000).toISOString(),
  venue: 'Селигерская',
  trainerName: 'Кирилл Твердохлеб',
  levelRange: { from: 'D+', to: 'C' },
  organizer: {
    displayName: 'Кирилл Твердохлеб',
    avatarUrl:
      '/public/api/v1/local-padel/tournaments/99999999-9999-4999-8999-999999999999/organizer-avatar',
  },
  capacity: { total: 16, registered: 12, open: 4, waitlist: 0 },
  status: 'REGISTRATION',
  route: '/tournaments?event=99999999-9999-4999-8999-999999999999',
};

const coachGameActivity: BookingRecommendationActivity = {
  id: '88888888-8888-4888-8888-888888888888',
  kind: 'TRAINING',
  title: 'Игра + тренер · C',
  startsAt: new Date(Date.now() + 1_800_000).toISOString(),
  endsAt: new Date(Date.now() + 5_400_000).toISOString(),
  timezone: 'Europe/Moscow',
  station: {
    id: game.station.id,
    name: game.station.name,
    shortAddress: 'г Москва, ул Нижние Мнёвники, д 12а',
  },
  court: {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Корт №1',
  },
  levelRange: { from: 'C', to: 'C' },
  host: {
    displayName: 'Кирилл Боев',
    avatarUrl:
      '/public/api/v1/local-padel/booking-activities/88888888-8888-4888-8888-888888888888/host-avatar',
    role: 'TRAINER',
  },
  capacity: { total: 3, open: 2 },
  route: '/trainings?event=88888888-8888-4888-8888-888888888888',
};

function catalogPage(
  items: readonly GamesCatalogTestItem[],
  nextCursor: string | null = null,
): EventCatalogPage {
  return {
    state: 'READY',
    snapshotVersion: 'a'.repeat(64),
    generatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 60_000).toISOString(),
    items,
    nextCursor,
    sourceStatus: [
      { source: 'LOCAL_GAMES', localDate: null, state: 'READY', errorCode: null },
      { source: 'SCHEDULE', localDate: null, state: 'READY', errorCode: null },
      { source: 'TOURNAMENTS', localDate: null, state: 'READY', errorCode: null },
    ],
    totalMatched: items.length,
    facets: { kinds: [], categories: [], stations: [] },
  } as unknown as EventCatalogPage;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gateway(): AuthGateway {
  return {
    listEventCatalog: vi.fn().mockResolvedValue(catalogPage([{ kind: 'GAME', game }])),
    continueEventCatalog: vi.fn().mockResolvedValue(catalogPage([])),
    getUpcomingBookings: vi.fn(),
    listMyGames: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listLocations: vi.fn().mockResolvedValue({
      items: [
        {
          id: game.station.id,
          title: game.station.name,
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: `/locations/${game.station.id}`,
        },
      ],
    }),
    getGame: vi.fn().mockResolvedValue({
      ...game,
      revision: 8,
      surface: 'MY_UPCOMING',
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'PARTICIPANT',
      viewerPaymentState: 'NOT_REQUIRED',
      resultSummary: null,
      conversation: null,
    }),
    getGameOperation: vi.fn(),
    joinGame: vi.fn().mockResolvedValue({
      commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      operation: {
        id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        type: 'JOIN_GAME',
        status: 'SUCCEEDED',
        gameId: null,
        aggregateRevision: 8,
        createdAt: '2026-07-18T10:00:00.000Z',
        updatedAt: '2026-07-18T10:00:00.000Z',
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: null,
      replayed: false,
    }),
  } as unknown as AuthGateway;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('GamesPage discovery', () => {
  it('routes the authenticated viewer leave badge to the existing self-leave command', async () => {
    const user = userEvent.setup();
    const pending = deferred<never>();
    const api: AuthGateway = { ...gateway(), leaveGame: vi.fn().mockReturnValue(pending.promise) };
    const viewerUserId = '00000000-0000-4000-8000-000000000001';
    const detail: ViewerGameCard = {
      ...(await api.getGame(game.id)),
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      endsAt: new Date(Date.now() + 176_400_000).toISOString(),
      allowedActions: ['OPEN_DETAILS', 'LEAVE'],
    };
    vi.mocked(api.getGame).mockResolvedValue(detail);
    render(
      <GamesPage
        gateway={api}
        gameId={game.id}
        chatNavigationScope={{ tenantKey: 'local-padel', userId: viewerUserId }}
      />,
    );
    const leave = await screen.findByRole('button', { name: 'Покинуть игру' });
    expect(leave.parentElement).toContainElement(screen.getByRole('link', { name: /Борис/ }));
    await user.click(leave);
    expect(api.leaveGame).toHaveBeenCalledExactlyOnceWith(game.id);
    expect(leave).toBeDisabled();
    await user.click(leave);
    expect(api.leaveGame).toHaveBeenCalledTimes(1);
  });

  it('opens a client-assisted booking deep-link as the selected game card', async () => {
    const eventId = '8a830ad0-a8c7-479b-a239-5b434c42148f';
    const api = gateway();
    vi.mocked(api.getUpcomingBookings).mockResolvedValue({
      state: 'READY',
      version: 'b'.repeat(64),
      generatedAt: '2026-08-01T10:00:00.000Z',
      staleAt: '2026-08-01T10:01:00.000Z',
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'game',
          title: 'Открытая игра',
          startsAt: '2026-08-15T05:00:00.000Z',
          endsAt: '2026-08-15T06:00:00.000Z',
          venue: 'Сочи',
          status: 'confirmed',
          route: `/games?event=${eventId}`,
          openSlots: 4,
        },
      ],
    });

    render(<GamesPage gateway={api} eventId={eventId} />);

    expect(await screen.findByRole('heading', { name: 'Карточка игры' })).toBeVisible();
    const card = await screen.findByRole('article', { name: 'Открытая игра' });
    expect(within(card).getByText('Сочи')).toBeVisible();
    expect(within(card).queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument();
    expect(api.getUpcomingBookings).toHaveBeenCalledOnce();
    expect(api.listEventCatalog).not.toHaveBeenCalled();
    expect(api.listLocations).not.toHaveBeenCalled();
  });

  it('resolves the selected public participant against an authenticated card revision', () => {
    const participantUserId = '38edce35-3060-4f16-b23e-3ad8cbf8d1dd';
    const viewerGame = {
      ...game,
      viewerRelation: 'NONE',
      viewerPaymentState: 'NOT_REQUIRED',
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: index === 0 ? participantUserId : `00000000-0000-4000-8000-00000000000${index}`,
      })),
      resultSummary: null,
      conversation: null,
    } as ViewerGameCard;

    expect(profileUserIdForParticipant(game, game.participants[0]!, 0, viewerGame)).toBe(
      participantUserId,
    );
  });

  it('opens the result tab immediately for a finished game', async () => {
    const finishedGame: ViewerGameCard = {
      ...game,
      surface: 'HISTORY',
      displayState: 'RESULT_REQUIRED',
      levelRange: game.levelRange ?? null,
      capacity: { ...game.capacity, total: 4 },
      priceSummary: game.priceSummary ?? null,
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'PARTICIPANT',
      resultSummary: { state: 'AWAITING_SUBMISSION' },
      allowedActions: ['OPEN_DETAILS', 'SUBMIT_RESULT'],
      conversation: null,
    };
    const api: AuthGateway = {
      ...gateway(),
      getGame: vi.fn().mockResolvedValue(finishedGame),
    };

    render(<GamesPage gateway={api} gameId={finishedGame.id} />);

    expect(await screen.findByRole('tab', { name: 'Результат' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Пары и счёт по сетам' })).toBeInTheDocument();
  });

  it('waits for the created projection before rendering the durable detail', async () => {
    const viewerGame = {
      ...game,
      levelRange: game.levelRange ?? null,
      priceSummary: null,
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'ORGANIZER',
      viewerPaymentState: 'NOT_REQUIRED',
      resultSummary: null,
      conversation: null,
    } as ViewerGameCard;
    const notProjected = Object.assign(new Error('not projected'), { code: 'GAME_NOT_FOUND' });
    const getGame = vi
      .fn<AuthGateway['getGame']>()
      .mockRejectedValueOnce(notProjected)
      .mockRejectedValueOnce(notProjected)
      .mockResolvedValue(viewerGame);
    const api: AuthGateway = { ...gateway(), getGame };
    window.history.replaceState({}, '', `/games/${game.id}?created=1&recovered=1`);

    render(<GamesPage gateway={api} gameId={game.id} />);

    expect(await screen.findByText(game.title, {}, { timeout: 2_000 })).toBeVisible();
    expect(screen.getByText(/Игра успешно восстановлена/)).toBeVisible();
    expect(getGame).toHaveBeenCalledTimes(3);
  });

  it('offers a user-controlled detail retry after projection loading fails', async () => {
    const viewerGame = {
      ...game,
      levelRange: game.levelRange ?? null,
      priceSummary: null,
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'ORGANIZER',
      viewerPaymentState: 'NOT_REQUIRED',
      resultSummary: null,
      conversation: null,
    } as ViewerGameCard;
    const getGame = vi
      .fn<AuthGateway['getGame']>()
      .mockRejectedValueOnce(Object.assign(new Error('not projected'), { code: 'GAME_NOT_FOUND' }))
      .mockResolvedValue(viewerGame);
    const api: AuthGateway = { ...gateway(), getGame };
    const user = userEvent.setup();

    render(<GamesPage gateway={api} gameId={game.id} />);
    await user.click(await screen.findByRole('button', { name: 'Повторить загрузку' }));

    expect(await screen.findByText(game.title)).toBeVisible();
    expect(getGame).toHaveBeenCalledTimes(2);
  });

  it('lets the organizer cancel a free game and refreshes the persisted status', async () => {
    const organizerGame: ViewerGameCard = {
      ...game,
      surface: 'MY_UPCOMING',
      startsAt: '2099-07-20T15:00:00.000Z',
      endsAt: '2099-07-20T16:00:00.000Z',
      levelRange: game.levelRange ?? null,
      priceSummary: null,
      capacity: { ...game.capacity, total: 4 },
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'ORGANIZER',
      viewerPaymentState: 'NOT_REQUIRED',
      resultSummary: null,
      allowedActions: ['OPEN_DETAILS', 'CANCEL'],
      conversation: null,
    };
    const cancelledGame: ViewerGameCard = {
      ...organizerGame,
      revision: organizerGame.revision + 1,
      displayState: 'CANCELLED',
      allowedActions: ['OPEN_DETAILS'],
    };
    const cancelGame = vi.fn<AuthGateway['cancelGame']>().mockResolvedValue({
      commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      operation: {
        id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        type: 'CANCEL_GAME',
        status: 'SUCCEEDED',
        gameId: game.id,
        aggregateRevision: cancelledGame.revision,
        createdAt: '2026-08-26T10:00:00.000Z',
        updatedAt: '2026-08-26T10:00:00.000Z',
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: cancelledGame,
      replayed: false,
    });
    const getGame = vi.fn().mockResolvedValueOnce(organizerGame).mockResolvedValue(cancelledGame);
    const api: AuthGateway = { ...gateway(), getGame, cancelGame };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<GamesPage gateway={api} gameId={organizerGame.id} />);
    await user.click(await screen.findByRole('button', { name: 'Отменить игру' }));

    expect(window.confirm).toHaveBeenCalledWith('Отменить игру для всех участников?');
    expect(cancelGame).toHaveBeenCalledWith(organizerGame.id, {
      reasonCode: 'ORGANIZER_REQUEST',
    });
    expect(await screen.findByText('Игра отменена. Статус и состав обновлены.')).toBeVisible();
    expect(await screen.findByText('Игра отменена')).toBeVisible();
  });

  it('requests the game chat with the canonical detail id and no user-entered identifier', async () => {
    const participantGame: ViewerGameCard = {
      ...game,
      surface: 'MY_UPCOMING',
      startsAt: '2099-07-20T15:00:00.000Z',
      endsAt: '2099-07-20T16:00:00.000Z',
      levelRange: game.levelRange ?? null,
      priceSummary: game.priceSummary ?? null,
      capacity: { ...game.capacity, total: 4 },
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'PARTICIPANT',
      viewerPaymentState: 'PAID',
      resultSummary: null,
      allowedActions: ['OPEN_DETAILS'],
      conversation: null,
    };
    const getOrCreateGameConversation = vi
      .fn<AuthGateway['getOrCreateGameConversation']>()
      .mockRejectedValue(new Error('CONTEXTUAL_MESSAGING_DISABLED'));
    const api: AuthGateway = {
      ...gateway(),
      getGame: vi.fn().mockResolvedValue(participantGame),
      getOrCreateGameConversation,
    };

    render(<GamesPage gateway={api} gameId={participantGame.id} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Открыть чат игры' }));

    await waitFor(() =>
      expect(getOrCreateGameConversation).toHaveBeenCalledWith(participantGame.id),
    );
    expect(getOrCreateGameConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Не удалось выполнить действие. Проверьте связь и повторите.',
    );
  });

  it('opens the game chat from the games list card with its unread count', async () => {
    const conversationId = '0f8a2c1e-1111-4111-8111-111111111111';
    const viewerGame: ViewerGameCard = {
      ...game,
      surface: 'MY_UPCOMING',
      levelRange: game.levelRange ?? null,
      capacity: { ...game.capacity, total: 4 },
      priceSummary: game.priceSummary ?? null,
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'PARTICIPANT',
      viewerPaymentState: 'PAID',
      resultSummary: null,
      allowedActions: ['OPEN_DETAILS', 'OPEN_CHAT'],
      conversation: { conversationId, unreadCount: 4 },
    };
    const api: AuthGateway = {
      ...gateway(),
      listMyGames: vi.fn().mockResolvedValue({ items: [viewerGame], nextCursor: null }),
    };
    const chatUserId = '00000000-0000-4000-8000-00000000000f';
    window.sessionStorage.clear();
    const user = userEvent.setup();
    render(
      <GamesPage
        chatNavigationScope={{ tenantKey: 'local-padel', userId: chatUserId }}
        gateway={api}
      />,
    );

    const tabs = await screen.findByRole('navigation', { name: 'Разделы игр' });
    await user.click(within(tabs).getByRole('button', { name: 'Для меня' }));

    const chat = await screen.findByRole('link', {
      name: 'Чат игры, непрочитанных сообщений: 4',
    });
    expect(chat).toHaveAttribute('href', `/chats/${conversationId}`);
    expect(within(chat).getByText('4')).toBeInTheDocument();

    await user.click(chat);

    // The chat screen receives the game context even while the thread is not in its newest page.
    expect(
      consumeGameChatNavigation({ tenantKey: 'local-padel', userId: chatUserId }, conversationId),
    ).toMatchObject({
      conversationId,
      contextId: viewerGame.id,
      title: viewerGame.title,
    });
  });

  it('creates the game chat from a roster card that has no conversation yet', async () => {
    const viewerGame: ViewerGameCard = {
      ...game,
      surface: 'MY_UPCOMING',
      levelRange: game.levelRange ?? null,
      capacity: { ...game.capacity, total: 4 },
      priceSummary: game.priceSummary ?? null,
      participants: game.participants.map((participant, index) => ({
        ...participant,
        userId: `00000000-0000-4000-8000-00000000000${index}`,
      })),
      viewerRelation: 'PARTICIPANT',
      viewerPaymentState: 'PAID',
      resultSummary: null,
      allowedActions: ['OPEN_DETAILS'],
      conversation: null,
    };
    const getOrCreateGameConversation = vi
      .fn<AuthGateway['getOrCreateGameConversation']>()
      .mockRejectedValue(new Error('CONTEXTUAL_MESSAGING_DISABLED'));
    const api: AuthGateway = {
      ...gateway(),
      listMyGames: vi.fn().mockResolvedValue({ items: [viewerGame], nextCursor: null }),
      getOrCreateGameConversation,
    };
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    const tabs = await screen.findByRole('navigation', { name: 'Разделы игр' });
    await user.click(within(tabs).getByRole('button', { name: 'Для меня' }));
    await user.click(await screen.findByRole('button', { name: 'Открыть чат игры' }));

    await waitFor(() => expect(getOrCreateGameConversation).toHaveBeenCalledWith(viewerGame.id));
    expect(getOrCreateGameConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Не удалось выполнить действие. Проверьте связь и повторите.',
    );
  });

  it('uses the shared main navigation and exposes the MVP create-game call to action', async () => {
    const api = gateway();
    render(<GamesPage gateway={api} />);

    await screen.findByText(game.title);

    const navigation = screen.getByRole('navigation', { name: 'Основная навигация' });
    expect(navigation).toHaveClass('fh-bottom-nav');
    expect(within(navigation).getByRole('link', { name: 'Игры' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(navigation).getByRole('link', { name: 'Создать игру' })).toHaveAttribute(
      'href',
      '/games/new?new=1',
    );

    const createDescription = screen.getByText('Выберите станцию, время и собери свою игру');
    expect(createDescription.closest('a')).toHaveClass('games-create-hero');
    expect(createDescription.closest('a')).toHaveAttribute('href', '/games/new?new=1');
    expect(document.querySelector('.games-header a[aria-label="Создать игру"]')).toBeNull();
    expect(document.querySelector('.games-bottom-nav')).toBeNull();
  });

  it('opens on today with a swipeable two-week date horizon and two discovery tabs', async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    await screen.findByText(game.title);

    expect(screen.queryByRole('heading', { name: 'Игры' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Разделы игр' });
    expect(within(tabs).getAllByRole('button')).toHaveLength(2);
    expect(within(tabs).getByRole('button', { name: 'Для меня' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: 'Мои игры' })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: 'История' })).not.toBeInTheDocument();

    const dateRail = screen.getByLabelText('Выбор даты');
    const dateButtons = within(dateRail).getAllByRole('button');
    expect(dateButtons).toHaveLength(16);
    expect(dateButtons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(dateButtons[1]).toHaveAttribute('aria-pressed', 'true');
    const initialFilters = vi.mocked(api.listEventCatalog).mock.calls[0]?.[0] as unknown as {
      readonly localDates: readonly string[];
    };
    expect(initialFilters.localDates).toHaveLength(1);

    const twoWeeksAhead = new Date();
    twoWeeksAhead.setHours(0, 0, 0, 0);
    twoWeeksAhead.setDate(twoWeeksAhead.getDate() + 14);
    expect(
      within(dateRail).getByRole('button', {
        name: `${dayFormatter.format(twoWeeksAhead)}${weekdayFormatter
          .format(twoWeeksAhead)
          .replace('.', '')}`,
      }),
    ).toBeInTheDocument();

    await user.click(within(tabs).getByRole('button', { name: 'Для меня' }));
    await waitFor(() =>
      expect(api.listMyGames).toHaveBeenCalledWith({ scope: 'UPCOMING', limit: 20 }),
    );
  });

  it('loads real discovery contract and executes a revision-guarded join', async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    expect(await screen.findByText(game.title)).toBeInTheDocument();
    expect(api.listEventCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'GAMES',
        kinds: ['GAME', 'COACH_GAME', 'TOURNAMENT'],
        availability: 'EXCLUDE_FULL',
        limit: 20,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Вступить в игру' }));
    expect(api.joinGame).toHaveBeenCalledWith(game.id, game.revision, undefined);
    expect(await screen.findByText(/Вы в игре/)).toBeInTheDocument();
  });

  it('saves a self-declared canonical level and resumes the interrupted join', async () => {
    const levelId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
    const api: AuthGateway = {
      ...gateway(),
      getOwnPlayerLevel: vi.fn().mockResolvedValue({
        sportCode: 'PADEL',
        scaleVersion: 1,
        currentLevel: null,
        levels: [
          {
            id: levelId,
            sportCode: 'PADEL',
            code: 'C+',
            title: 'C+',
            rank: 4,
            sortOrder: 4,
            aliases: ['C+'],
            active: true,
            scaleVersion: 1,
          },
        ],
      }),
      setOwnPlayerLevel: vi.fn().mockResolvedValue({
        playerId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
        sportCode: 'PADEL',
        levelId,
        code: 'C+',
        title: 'C+',
        rank: 4,
        source: 'SELF_DECLARED',
        numericValue: null,
        scaleVersion: 1,
        updatedAt: '2026-08-16T18:00:00.000Z',
      }),
    };
    vi.mocked(api.joinGame)
      .mockRejectedValueOnce(
        Object.assign(new Error('level required'), { code: 'PLAYER_LEVEL_REQUIRED' }),
      )
      .mockResolvedValueOnce({
        commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        operation: {
          id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
          type: 'JOIN_GAME',
          status: 'SUCCEEDED',
          gameId: null,
          aggregateRevision: 8,
          createdAt: '2026-08-16T18:00:00.000Z',
          updatedAt: '2026-08-16T18:00:00.000Z',
          nextAction: { type: 'NONE' },
          error: null,
        },
        game: null,
        replayed: false,
      });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Укажите уровень, чтобы присоединиться',
    });
    expect(within(dialog).getByRole('button', { name: 'Знаю свой уровень' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Пройти определение уровня' })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Знаю свой уровень' }));
    expect(within(dialog).getByRole('combobox', { name: 'Ваш уровень' })).toHaveValue(levelId);
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить и продолжить запись' }));

    await waitFor(() => expect(api.setOwnPlayerLevel).toHaveBeenCalledWith(levelId, 'PADEL'));
    await waitFor(() => expect(api.joinGame).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Вы в игре/)).toBeVisible();
  });

  it('completes the server-owned assessment and resumes the interrupted join', async () => {
    const levelId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
    const api: AuthGateway = {
      ...gateway(),
      getOwnPlayerLevel: vi.fn().mockResolvedValue({
        sportCode: 'PADEL',
        scaleVersion: 1,
        currentLevel: null,
        levels: [],
      }),
      setOwnPlayerLevel: vi.fn(),
      getOwnLevelAssessment: vi.fn().mockResolvedValue({
        version: 'padel-self-assessment-v1',
        sportCode: 'PADEL',
        baseQuestionId: 'q1_1',
        questions: [
          {
            id: 'q1_1',
            text: 'Опыт игры',
            type: 'single',
            options: [{ id: 'less_month', label: 'Меньше месяца' }],
          },
          {
            id: 'q1_2',
            text: 'Был ли опыт в теннисе?',
            type: 'single',
            options: [{ id: 'no', label: 'Нет' }],
          },
        ],
        branches: { less_month: ['q1_2'] },
      }),
      completeOwnLevelAssessment: vi.fn().mockResolvedValue({
        assessment: {
          version: 'padel-self-assessment-v1',
          numericScore: 1,
          levelCode: 'D',
        },
        level: {
          playerId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
          sportCode: 'PADEL',
          levelId,
          code: 'D',
          title: 'D',
          rank: 1,
          source: 'ONBOARDING',
          numericValue: 1,
          scaleVersion: 1,
          updatedAt: '2026-08-16T18:00:00.000Z',
        },
      }),
    };
    vi.mocked(api.joinGame)
      .mockRejectedValueOnce(
        Object.assign(new Error('level required'), { code: 'PLAYER_LEVEL_REQUIRED' }),
      )
      .mockResolvedValueOnce({
        commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        operation: {
          id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
          type: 'JOIN_GAME',
          status: 'SUCCEEDED',
          gameId: null,
          aggregateRevision: 8,
          createdAt: '2026-08-16T18:00:00.000Z',
          updatedAt: '2026-08-16T18:00:00.000Z',
          nextAction: { type: 'NONE' },
          error: null,
        },
        game: null,
        replayed: false,
      });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Укажите уровень, чтобы присоединиться',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Пройти определение уровня' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Меньше месяца' }));
    await user.click(within(dialog).getByRole('button', { name: 'Далее' }));
    await user.click(within(dialog).getByRole('button', { name: 'Нет' }));
    await user.click(within(dialog).getByRole('button', { name: 'Завершить и продолжить' }));

    await waitFor(() =>
      expect(api.completeOwnLevelAssessment).toHaveBeenCalledWith('padel-self-assessment-v1', {
        q1_1: ['less_month'],
        q1_2: ['no'],
      }),
    );
    await waitFor(() => expect(api.joinGame).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Вы в игре/)).toBeVisible();
  });

  it('selects multiple event types from a checkbox dropdown and translates the coach type', async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    await user.click(screen.getByRole('button', { name: 'Все типы' }));
    const typeFilter = screen.getByRole('group', { name: 'Тип события' });
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра' })).toBeInTheDocument();
    expect(
      within(typeFilter).queryByRole('checkbox', { name: 'Групповая тренировка' }),
    ).not.toBeInTheDocument();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' })).toBeInTheDocument();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Турнир' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Тип игры' })).not.toBeInTheDocument();

    await user.click(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' }));
    await waitFor(() =>
      expect(api.listEventCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ kinds: ['COACH_GAME'], availability: 'EXCLUDE_FULL' }),
      ),
    );
    await user.click(within(typeFilter).getByRole('checkbox', { name: 'Турнир' }));
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' })).toBeChecked();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Турнир' })).toBeChecked();
  });

  it('renders the mixed catalog without client-side source filtering', async () => {
    const api = gateway();
    vi.mocked(api.listEventCatalog).mockResolvedValueOnce(
      catalogPage([
        { kind: 'GAME', game },
        { kind: 'COACH_GAME', activity: coachGameActivity },
        { kind: 'TOURNAMENT', tournament },
      ]),
    );
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    expect(await screen.findByText(tournament.title)).toBeInTheDocument();
    const coachGameCard = screen.getByText(coachGameActivity.title).closest('article');
    expect(coachGameCard).not.toBeNull();
    expect(coachGameCard).toHaveAttribute('data-event-kind', 'TRAINING');
    expect(within(coachGameCard!).getByText('Игра + тренер')).toBeInTheDocument();
    expect(within(coachGameCard!).getByText('Уровень C')).toBeInTheDocument();
    expect(
      within(coachGameCard!).getByText(
        `${coachGameActivity.station.name} · ${coachGameActivity.court?.name}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(coachGameCard!).queryByText('г Москва, ул Нижние Мнёвники, д 12а'),
    ).not.toBeInTheDocument();
    const trainerSlots = within(coachGameCard!).getByLabelText('Тренер и свободные места');
    const trainerAvatar = within(trainerSlots).getByRole('img', { name: /Кирилл Боев/ });
    expect(trainerAvatar.querySelector('[data-player-level-photo]')).toHaveAttribute(
      'src',
      coachGameActivity.host?.avatarUrl,
    );
    const openSlots = within(trainerSlots).getByLabelText('Свободных мест: 2');
    expect(within(openSlots).getAllByLabelText('Свободное место')).toHaveLength(2);
    expect(within(coachGameCard!).queryByText('Свободно мест: 2')).not.toBeInTheDocument();
    expect(within(coachGameCard!).getByRole('link', { name: 'Записаться' })).toHaveAttribute(
      'href',
      coachGameActivity.route,
    );
    const tournamentCard = screen.getByText(tournament.title).closest('article');
    expect(tournamentCard).not.toBeNull();
    expect(within(tournamentCard!).getByText('Турнир · Мексикано').parentElement).toHaveClass(
      'fh-event__tag',
      'is-tournament',
    );
    expect(within(tournamentCard!).getByRole('link', { name: 'Записаться' })).toHaveClass(
      'game-card__button',
    );
    expect(within(tournamentCard!).queryByText(/Корт/)).not.toBeInTheDocument();
    expect(within(tournamentCard!).getByText('Селигерская · от D+ до C')).toBeInTheDocument();
    expect(within(tournamentCard!).getByText('Организатор')).toBeInTheDocument();
    expect(within(tournamentCard!).getByText('Кирилл Твердохлеб')).toBeInTheDocument();
    const organizerAvatar = within(tournamentCard!).getByRole('img', {
      name: 'Организатор: Кирилл Твердохлеб',
    });
    expect(organizerAvatar.querySelector('img')).toHaveAttribute(
      'src',
      tournament.organizer?.avatarUrl,
    );
    expect(organizerAvatar.querySelector('img')).toHaveAttribute('loading', 'lazy');
    expect(organizerAvatar.querySelector('span')).toHaveAttribute('hidden');
    expect(within(tournamentCard!).getByText('Доступно 4 места из 16')).toBeInTheDocument();
    expect(within(tournamentCard!).getByLabelText('Ещё мест: 1')).toHaveTextContent('+1');

    await user.click(screen.getByRole('button', { name: 'Все типы' }));
    await user.click(screen.getByRole('checkbox', { name: 'Игра + Тренер' }));
    await waitFor(() =>
      expect(api.listEventCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ kinds: ['COACH_GAME'] }),
      ),
    );
  });

  it('applies station, availability and advanced filters from the reference-shaped panel', async () => {
    const api = gateway();
    const secondStation = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Терехово',
      city: 'Москва',
      courtCount: 4,
      coverImageUrl: null,
      route: '/locations/11111111-1111-4111-8111-111111111111',
    };
    vi.mocked(api.listLocations).mockResolvedValueOnce({
      items: [
        {
          id: game.station.id,
          title: game.station.name,
          city: 'Москва',
          courtCount: 3,
          coverImageUrl: null,
          route: `/locations/${game.station.id}`,
        },
        secondStation,
      ],
    });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    expect(screen.queryByText('Тип игры')).not.toBeInTheDocument();
    expect(screen.queryByText('Станция')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Все станции' }));
    const stationFilter = screen.getByRole('group', { name: 'Станции' });
    await user.click(
      await within(stationFilter).findByRole('checkbox', { name: game.station.name }),
    );
    await user.click(
      await within(stationFilter).findByRole('checkbox', { name: secondStation.title }),
    );
    expect(within(stationFilter).getByRole('checkbox', { name: game.station.name })).toBeChecked();
    expect(
      within(stationFilter).getByRole('checkbox', { name: secondStation.title }),
    ).toBeChecked();
    expect(screen.getByRole('button', { name: 'Станции: 2' })).toBeInTheDocument();
    const availabilityFilter = screen.getByRole('checkbox', { name: 'Не показывать набранные' });
    expect(availabilityFilter).toBeChecked();
    await user.click(availabilityFilter);
    const advancedFiltersButton = await screen.findByRole('button', { name: 'Все фильтры · 2' });
    await user.click(advancedFiltersButton);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Время начала' }), '18:00');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Уровень игроков' }), 'C_B_PLUS');

    await waitFor(() => {
      const filters = vi.mocked(api.listEventCatalog).mock.calls.at(-1)?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(filters).toMatchObject({
        stationIds: [secondStation.id, game.station.id].sort(),
        availability: 'INCLUDE_FULL',
        levelFrom: 'C',
        levelTo: 'B+',
        startsAfterLocal: '18:00',
      });
    });
    expect(screen.getByRole('button', { name: 'Убрать фильтр После 18:00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать фильтр Уровень C–B+' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сбросить всё' }));
    await waitFor(() => {
      const filters = vi.mocked(api.listEventCatalog).mock.calls.at(-1)?.[0];
      expect(filters).not.toHaveProperty('stationIds');
      expect(filters).not.toHaveProperty('levelFrom');
      expect(filters).not.toHaveProperty('levelTo');
    });
    expect(screen.getByRole('checkbox', { name: 'Не показывать набранные' })).toBeChecked();
  });

  it('filters the catalog to the current player level with one action', async () => {
    const api: AuthGateway = {
      ...gateway(),
      getOwnPlayerLevel: vi.fn().mockResolvedValue(playerLevelState('C+', 4)),
    };
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    await user.click(screen.getByRole('button', { name: 'Под мой уровень' }));

    await waitFor(() => expect(api.getOwnPlayerLevel).toHaveBeenCalledWith('PADEL'));
    await waitFor(() =>
      expect(api.listEventCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ levelFrom: 'C+', levelTo: 'C+' }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Мой уровень · C+' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Убрать фильтр Мой уровень C+' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Вступить в игру' })).toBeVisible();
  });

  it('shows the useful empty state after the current-level filter finds no events', async () => {
    const api: AuthGateway = {
      ...gateway(),
      getOwnPlayerLevel: vi.fn().mockResolvedValue(playerLevelState('B', 5)),
    };
    vi.mocked(api.listEventCatalog)
      .mockResolvedValueOnce(catalogPage([{ kind: 'GAME', game }]))
      .mockResolvedValueOnce(catalogPage([]));
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    await user.click(screen.getByRole('button', { name: 'Под мой уровень' }));

    expect(await screen.findByText('Подходящих событий пока нет')).toBeVisible();
    expect(
      screen.getByText(
        'Смените дату, тип события, уровень или покажите события без свободных мест.',
      ),
    ).toBeVisible();
  });

  it('continues the mixed catalog through its opaque cursor', async () => {
    const secondGame: PublicGameCard = {
      ...game,
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Вторая игра каталога',
      deepLink: '/games/22222222-2222-4222-8222-222222222222',
    };
    const api = gateway();
    vi.mocked(api.listEventCatalog).mockResolvedValueOnce(
      catalogPage([{ kind: 'GAME', game }], 'opaque-page-2'),
    );
    vi.mocked(api.continueEventCatalog).mockResolvedValueOnce(
      catalogPage([{ kind: 'GAME', game: secondGame }]),
    );
    const user = userEvent.setup();

    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);
    await user.click(screen.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => expect(api.continueEventCatalog).toHaveBeenCalledWith('opaque-page-2', 20));
    expect(await screen.findByText(secondGame.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).not.toBeInTheDocument();
  });

  it('resets the catalog query on date change and rejects the stale response', async () => {
    const stalePage = deferred<EventCatalogPage>();
    const currentPage = deferred<EventCatalogPage>();
    const api = gateway();
    vi.mocked(api.listEventCatalog)
      .mockImplementationOnce(() => stalePage.promise)
      .mockImplementationOnce(() => currentPage.promise);
    const user = userEvent.setup();

    render(<GamesPage gateway={api} />);
    await waitFor(() => expect(api.listEventCatalog).toHaveBeenCalledTimes(1));
    const dateButtons = within(screen.getByLabelText('Выбор даты')).getAllByRole('button');
    await user.click(dateButtons[2]!);
    await waitFor(() => expect(api.listEventCatalog).toHaveBeenCalledTimes(2));
    const changedQuery = vi.mocked(api.listEventCatalog).mock.calls[1]?.[0] as EventCatalogQuery;
    expect(changedQuery.localDates).toHaveLength(1);

    const currentGame: PublicGameCard = {
      ...game,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Игра новой даты',
      deepLink: '/games/33333333-3333-4333-8333-333333333333',
    };
    act(() => currentPage.resolve(catalogPage([{ kind: 'GAME', game: currentGame }])));
    expect(await screen.findByText(currentGame.title)).toBeInTheDocument();

    act(() => stalePage.resolve(catalogPage([{ kind: 'GAME', game }])));
    await waitFor(() => expect(screen.queryByText(game.title)).not.toBeInTheDocument());
    expect(screen.getByText(currentGame.title)).toBeInTheDocument();
  });

  it('polls an accepted roster command before reporting completion', async () => {
    const api = gateway();
    vi.mocked(api.joinGame).mockResolvedValueOnce({
      commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      operation: {
        id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        type: 'JOIN_GAME',
        status: 'ACCEPTED',
        gameId: game.id,
        aggregateRevision: null,
        createdAt: '2026-07-18T10:00:00.000Z',
        updatedAt: '2026-07-18T10:00:00.000Z',
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: null,
      replayed: false,
    });
    vi.mocked(api.getGameOperation).mockResolvedValueOnce({
      commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
      operation: {
        id: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
        type: 'JOIN_GAME',
        status: 'SUCCEEDED',
        gameId: null,
        aggregateRevision: 8,
        createdAt: '2026-07-18T10:00:00.000Z',
        updatedAt: '2026-07-18T10:00:00.250Z',
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: null,
      replayed: false,
    });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));

    await waitFor(() =>
      expect(api.getGameOperation).toHaveBeenCalledWith('c3889c99-b0e3-4a3d-b3e8-a5c99af730ea'),
    );
    expect(await screen.findByText(/Вы в игре/)).toBeInTheDocument();
  });
});

describe('GamesPage list return and freshness', () => {
  it('replays filtered pages with fresh reads and restores scroll after returning from details', async () => {
    const api = gateway();
    const secondGame = {
      ...game,
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Игра на второй странице',
    };
    vi.mocked(api.listEventCatalog).mockResolvedValue(
      catalogPage([{ kind: 'GAME', game }], 'page-two'),
    );
    vi.mocked(api.continueEventCatalog).mockResolvedValue(
      catalogPage([{ kind: 'GAME', game: secondGame }]),
    );
    const user = userEvent.setup();
    const first = render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);
    await user.click(screen.getByRole('button', { name: 'Все станции' }));
    await user.click(screen.getByRole('checkbox', { name: game.station.name }));
    await user.click(screen.getByRole('button', { name: 'Все фильтры · 1' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Время начала' }), '18:00');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Уровень игроков' }), 'C_B_PLUS');
    await user.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    const link = await screen.findByRole('link', { name: secondGame.title });
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    const stored = window.sessionStorage.getItem('phub.games-list.v1:local:local');
    expect(JSON.parse(stored!)).toMatchObject({ pages: 2, scrollY: 640 });
    expect(stored).not.toContain(secondGame.title);
    expect(stored).not.toContain('page-two');
    first.unmount();

    // The return re-reads the authoritative catalog instead of displaying old saved cards.
    vi.mocked(api.listEventCatalog).mockClear();
    vi.mocked(api.continueEventCatalog).mockClear();
    vi.mocked(api.continueEventCatalog).mockResolvedValue(
      catalogPage([{ kind: 'GAME', game: { ...secondGame, title: 'Обновлённая игра' } }]),
    );
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    render(<GamesPage gateway={api} />);
    await screen.findByRole('link', { name: 'Обновлённая игра' });
    expect(api.listEventCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        stationIds: [game.station.id],
        startsAfterLocal: '18:00',
        levelFrom: 'C',
        levelTo: 'B+',
      }),
    );
    expect(api.continueEventCatalog).toHaveBeenCalledTimes(1);
    expect(api.continueEventCatalog).toHaveBeenCalledWith('page-two', 20);
    expect(screen.getByRole('combobox', { name: 'Время начала' })).toHaveValue('18:00');
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 640, behavior: 'instant' }));
  });

  it('marks an expired snapshot and refreshes it without inventing current availability', async () => {
    const api = gateway();
    vi.mocked(api.listEventCatalog).mockResolvedValueOnce({
      ...catalogPage([{ kind: 'GAME', game }]),
      staleAt: new Date(Date.now() - 1000).toISOString(),
    });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(/Данные могли измениться/);
    expect(screen.getByText('Свободных мест: 1 из 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Обновить список' }));
    await waitFor(() => expect(api.listEventCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/Данные могли измениться/)).not.toBeInTheDocument(),
    );
  });

  it('keeps the loaded page on continuation failure and retries the same cursor', async () => {
    const api = gateway();
    vi.mocked(api.listEventCatalog).mockResolvedValue(
      catalogPage([{ kind: 'GAME', game }], 'page-two'),
    );
    vi.mocked(api.continueEventCatalog)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(catalogPage([]));
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await user.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    await screen.findByText(/Уже загруженные события сохранены/);
    expect(screen.getByRole('link', { name: game.title })).toBeInTheDocument();
    expect(screen.queryByText('Подходящих событий пока нет')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() => expect(api.continueEventCatalog).toHaveBeenCalledTimes(2));
    expect(api.continueEventCatalog).toHaveBeenLastCalledWith('page-two', 20);
  });
});

it('ignores invalid saved filters instead of sending them to the catalog', async () => {
  window.sessionStorage.setItem(
    'phub.games-list.v1:local:local',
    JSON.stringify({ tab: 'DISCOVER', selectedKinds: ['UNSUPPORTED'], pages: -1 }),
  );
  const api = gateway();
  render(<GamesPage gateway={api} />);
  await screen.findByRole('link', { name: game.title });
  expect(api.listEventCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ kinds: ['GAME', 'COACH_GAME', 'TOURNAMENT'] }),
  );
});

const PAID_GAME_ID = '99999999-9999-4999-8999-999999999901';
const PAID_SUBSCRIPTION_ID = '99999999-9999-4999-8999-999999999902';
const PAID_OPERATION_ID = '99999999-9999-4999-8999-999999999903';
const PAID_TENANT_ID = '99999999-9999-4999-8999-999999999904';
const PAID_USER_ID = '99999999-9999-4999-8999-999999999905';
const PAID_ATTEMPT_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const paidPrincipal: GameJoinAttemptPrincipal = {
  tenantId: PAID_TENANT_ID,
  userId: PAID_USER_ID,
};

const paidGame: ViewerGameCard = {
  id: PAID_GAME_ID,
  revision: 4,
  surface: 'DISCOVER',
  displayState: 'FINDING_PLAYERS',
  title: 'Платная игра по подписке',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  startsAt: '2099-09-21T04:00:00Z',
  endsAt: '2099-09-21T05:30:00Z',
  timezone: 'Europe/Moscow',
  station: { id: game.station.id, name: game.station.name, shortAddress: null },
  court: { id: '99999999-9999-4999-8999-999999999906', name: 'Корт' },
  levelRange: null,
  rosterState: 'OPEN',
  capacity: { total: 4, occupied: 2, reserved: 0, open: 2, waitlistCount: 0 },
  participants: [],
  priceSummary: { amountMinor: 300000, currency: 'RUB' },
  viewerRelation: 'NONE',
  viewerPaymentState: 'NOT_REQUIRED',
  resultSummary: null,
  badges: [],
  allowedActions: ['OPEN_DETAILS', 'JOIN'],
  deepLink: `/games/${PAID_GAME_ID}`,
  conversation: null,
};

function paidHome(): ReturnType<typeof buildMockHomeDashboard> {
  return {
    ...buildMockHomeDashboard({
      tenantId: PAID_TENANT_ID,
      userId: PAID_USER_ID,
      displayName: 'Синтетический игрок',
      phoneLast4: '0000',
      roles: ['client'],
      permissions: ['games.play'],
    }),
    subscriptions: [
      {
        id: PAID_SUBSCRIPTION_ID,
        title: 'Подписка для проверки',
        status: 'active',
        remainingUnits: 4,
        validUntil: '2099-12-31T00:00:00.000Z',
        route: `/subscriptions/${PAID_SUBSCRIPTION_ID}`,
      },
    ],
  };
}

function paidConditions(amountMinor: number): Record<string, unknown> {
  return {
    gameId: PAID_GAME_ID,
    revision: paidGame.revision,
    ownerRevision: null,
    subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
    eligibility: 'AVAILABLE',
    reasonCode: null,
    subscriptionApplied: true,
    price: { status: 'ADVISORY', amountMinor, currency: 'RUB', confirmed: false },
    freeMinutes: 60,
    paidMinutes: 30,
    evaluatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonBinding: true,
    requiresReservationRecheck: true,
    requiresPriceConsent: true,
    source: 'LK1_PRICE_PREVIEW',
    providerMode: 'MOCK',
  };
}

function ownerConfirmedCommercial(): Record<string, unknown> {
  return {
    attemptState: 'OWNER_CONFIRMED',
    reservation: null,
    price: { amountMinor: 250000, currency: 'RUB', consent: 'SETTLED' },
    receipt: null,
    reason: null,
  };
}

function unknownCommercial(): Record<string, unknown> {
  return {
    attemptState: 'UNKNOWN',
    reservation: null,
    price: { amountMinor: 250000, currency: 'RUB', consent: 'SETTLED' },
    receipt: null,
    reason: 'RECONCILIATION_REQUIRED',
  };
}

function joinOperation(
  status: string,
  options: {
    readonly wait?: boolean;
    readonly code?: string;
    readonly commercial?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const now = '2026-10-21T08:00:00.000Z';
  return {
    commandId: PAID_OPERATION_ID,
    operation: {
      id: PAID_OPERATION_ID,
      type: 'JOIN_GAME',
      status,
      gameId: PAID_GAME_ID,
      aggregateRevision: status === 'SUCCEEDED' ? 5 : null,
      createdAt: now,
      updatedAt: now,
      nextAction: options.wait
        ? { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 1 }
        : { type: 'NONE' },
      error: options.code ? { code: options.code, message: 'rejected' } : null,
      commercial: options.commercial ?? null,
    },
    game: null,
    replayed: false,
  };
}

function paidJoinGateway(
  options: {
    readonly conditions?: () => unknown;
    readonly joinPaidGame?: ReturnType<typeof vi.fn>;
    readonly getPaidJoinOperation?: ReturnType<typeof vi.fn>;
    readonly getGame?: ReturnType<typeof vi.fn>;
  } = {},
): AuthGateway {
  return {
    ...gateway(),
    getHomeDashboard: vi.fn().mockResolvedValue(paidHome()),
    getGame:
      options.getGame ??
      vi
        .fn()
        .mockResolvedValueOnce(paidGame)
        .mockResolvedValue({
          ...paidGame,
          revision: 5,
          viewerRelation: 'PARTICIPANT',
          allowedActions: ['OPEN_DETAILS', 'LEAVE'],
          participants: [
            {
              userId: PAID_USER_ID,
              displayName: 'Синтетический игрок',
              avatarUrl: null,
              level: null,
              role: 'PLAYER',
            },
          ],
        }),
    getUpcomingBookings: vi.fn().mockResolvedValue({
      state: 'READY',
      version: 'synthetic-c2-v5',
      generatedAt: new Date().toISOString(),
      staleAt: '2099-12-31T00:00:00.000Z',
      items: [
        {
          id: '99999999-9999-4999-8999-999999999908',
          gameId: PAID_GAME_ID,
          kind: 'game',
          title: 'Синтетическая запись',
          startsAt: paidGame.startsAt,
          venue: 'Синтетическая станция',
          status: 'confirmed',
          route: `/games/${PAID_GAME_ID}`,
          roster: { state: 'READY', revision: 5 },
        },
      ],
    }),
    getGameJoinConditions: vi.fn(
      options.conditions ?? (() => Promise.resolve(paidConditions(250000))),
    ),
    joinPaidGame:
      options.joinPaidGame ??
      vi
        .fn()
        .mockResolvedValue(joinOperation('SUCCEEDED', { commercial: ownerConfirmedCommercial() })),
    getPaidJoinOperation:
      options.getPaidJoinOperation ??
      vi
        .fn()
        .mockResolvedValue(
          joinOperation('UNKNOWN', { wait: true, commercial: unknownCommercial() }),
        ),
    getGameOperation: vi.fn(),
    joinGame: vi.fn().mockResolvedValue(joinOperation('SUCCEEDED', { commercial: null })),
  } as unknown as AuthGateway;
}

async function openPaidConsent(
  api: AuthGateway,
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
  const picker = await screen.findByRole('combobox', { name: 'Выберите подписку' });
  await user.selectOptions(picker, PAID_SUBSCRIPTION_ID);
  await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
  await screen.findByRole('heading', { name: 'Подтверждение стоимости' }, { timeout: 3_000 });
}

describe('GamesPage paid JOIN', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  beforeEach(() => {
    let tail = Promise.resolve<unknown>(undefined);
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => unknown) => {
          const result = tail.then(callback);
          tail = result.catch(() => undefined);
          return result;
        },
      },
    });
  });
  it('rechecks an expired consent without dispatching or minting an attempt', async () => {
    const user = userEvent.setup();
    const api = paidJoinGateway();
    await openPaidConsent(api, user);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
      expect(api.joinPaidGame).not.toHaveBeenCalled();
      expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();
      expect(api.getGameJoinConditions).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });
  it('hides prior-account consent synchronously on a same-game principal switch', async () => {
    const api = paidJoinGateway();
    const user = userEvent.setup();
    const view = render(
      <GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />,
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Выберите подписку' }),
      PAID_SUBSCRIPTION_ID,
    );
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    await screen.findByRole('button', { name: /^Подтвердить/ });
    view.rerender(
      <GamesPage
        gateway={api}
        gameId={PAID_GAME_ID}
        joinPrincipal={{ ...paidPrincipal, userId: '99999999-9999-4999-8999-999999999999' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Подтвердить/ })).toBeNull();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('bounds a hung paid command as UNKNOWN with the same persisted key and no replacement POST', async () => {
    const api = paidJoinGateway({ joinPaidGame: vi.fn(() => new Promise(() => {})) });
    const user = userEvent.setup();
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
    const originalKey = loadGameJoinAttempt(
      paidPrincipal,
      window.localStorage,
      PAID_GAME_ID,
    )?.idempotencyKey;
    expect(
      await screen.findByRole('heading', { name: 'Проверяем статус оплаты' }, { timeout: 9500 }),
    ).toBeVisible();
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBe(originalKey);
    expect(api.joinPaidGame).toHaveBeenCalledTimes(1);
  }, 12000);
  it('retains custody after trusted success until card, roster and personal record converge', async () => {
    const api = paidJoinGateway({ getGame: vi.fn().mockResolvedValue(paidGame) });
    const user = userEvent.setup();
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
    expect(
      await screen.findByRole('heading', { name: 'Запись подтверждена, данные обновляются' }),
    ).toBeVisible();
    expect(screen.queryByText('Вы в игре. Состав и доступные действия обновлены.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).not.toBeNull();
  });
  it('keeps a dispatched original key after payment-return readback 404 without trusting the URL', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: 4,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage);
    const api = paidJoinGateway({
      getPaidJoinOperation: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not yet visible'), { code: 'GAME_OPERATION_NOT_FOUND' }),
        ),
    });
    window.history.replaceState(null, '', `/games/${PAID_GAME_ID}?status=paid&payment=success`);
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    expect(await screen.findByText(/Сервер пока не нашёл исходную операцию/)).toBeVisible();
    expect(api.getPaidJoinOperation).toHaveBeenCalledWith(PAID_GAME_ID, PAID_ATTEMPT_KEY);
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBe(PAID_ATTEMPT_KEY);
    expect(api.joinPaidGame).not.toHaveBeenCalled();
    expect(screen.queryByText('Вы в игре. Состав и доступные действия обновлены.')).toBeNull();
  });
  it('shows no old-account result after a delayed conditions reply', async () => {
    const response = deferred<unknown>();
    const api = paidJoinGateway({ conditions: () => response.promise });
    const user = userEvent.setup();
    const view = render(
      <GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />,
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Выберите подписку' }),
      PAID_SUBSCRIPTION_ID,
    );
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    view.rerender(
      <GamesPage
        gateway={api}
        gameId={PAID_GAME_ID}
        joinPrincipal={{ ...paidPrincipal, userId: '99999999-9999-4999-8999-999999999999' }}
      />,
    );
    await act(async () => {
      response.resolve(paidConditions(250000));
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: /^Подтвердить/ })).toBeNull();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('does not display an old-game command result after navigating to another game', async () => {
    const response = deferred<unknown>();
    const otherId = '99999999-9999-4999-8999-999999999999';
    let oldReads = 0;
    const getGame = vi.fn((id: string) =>
      Promise.resolve(
        id === otherId
          ? { ...paidGame, id: otherId, title: 'Другая синтетическая игра' }
          : ++oldReads === 1
            ? paidGame
            : {
                ...paidGame,
                revision: 5,
                viewerRelation: 'PARTICIPANT',
                allowedActions: ['OPEN_DETAILS', 'LEAVE'],
                participants: [
                  {
                    userId: PAID_USER_ID,
                    displayName: 'Синтетический игрок',
                    avatarUrl: null,
                    level: null,
                    role: 'PLAYER',
                  },
                ],
              },
      ),
    );
    const api = paidJoinGateway({ getGame, joinPaidGame: vi.fn(() => response.promise) });
    const user = userEvent.setup();
    const view = render(
      <GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />,
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Выберите подписку' }),
      PAID_SUBSCRIPTION_ID,
    );
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    await user.click(await screen.findByRole('button', { name: /^Подтвердить/ }));
    await waitFor(() => expect(api.joinPaidGame).toHaveBeenCalledTimes(1));
    view.rerender(<GamesPage gateway={api} gameId={otherId} joinPrincipal={paidPrincipal} />);
    await screen.findByRole('heading', { name: 'Другая синтетическая игра' });
    await act(async () => {
      response.resolve(joinOperation('SUCCEEDED', { commercial: ownerConfirmedCommercial() }));
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Другая синтетическая игра' })).toBeVisible();
    expect(screen.queryByText('Вы в игре. Состав и доступные действия обновлены.')).toBeNull();
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBeDefined();
  });
  it.each(['SUCCEEDED', 'FAILED'])(
    'rejects automatic readback %s for a different operation after first binding',
    async (status) => {
      const seeded = await beginGameJoinAttempt(
        paidPrincipal,
        {
          gameId: PAID_GAME_ID,
          expectedRevision: 4,
          subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
          priceConsent: { amountMinor: 250000, currency: 'RUB' },
        },
        window.localStorage,
        { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
      );
      await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage);
      const other = joinOperation(status, {
        commercial: status === 'SUCCEEDED' ? ownerConfirmedCommercial() : null,
        ...(status === 'FAILED' ? { code: 'GAME_FULL' } : {}),
      });
      other.operation = {
        ...(other.operation as Record<string, unknown>),
        id: '99999999-9999-4999-8999-999999999999',
      };
      const readback = vi
        .fn()
        .mockResolvedValueOnce(
          joinOperation('UNKNOWN', { wait: true, commercial: unknownCommercial() }),
        )
        .mockResolvedValue(other);
      const api = paidJoinGateway({ getPaidJoinOperation: readback });
      render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
      await waitFor(() => expect(readback).toHaveBeenCalledTimes(2), { timeout: 3000 });
      await act(async () => {
        await Promise.resolve();
      });
      const retained = loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID);
      expect(retained?.idempotencyKey).toBe(PAID_ATTEMPT_KEY);
      expect(retained?.operationId).toBe(PAID_OPERATION_ID);
      expect(screen.queryByText('Вы в игре. Состав и доступные действия обновлены.')).toBeNull();
    },
  );
  it('releases projection busy ownership after successful readback with stale projections', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: 4,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage);
    const getGame = vi.fn().mockResolvedValue(paidGame);
    const api = paidJoinGateway({
      getGame,
      getPaidJoinOperation: vi
        .fn()
        .mockResolvedValue(joinOperation('SUCCEEDED', { commercial: ownerConfirmedCommercial() })),
    });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    await screen.findByRole('heading', { name: 'Запись подтверждена, данные обновляются' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Проверить статус' })).toBeEnabled(),
    );
    getGame.mockResolvedValue({
      ...paidGame,
      revision: 5,
      viewerRelation: 'PARTICIPANT',
      allowedActions: ['OPEN_DETAILS', 'LEAVE'],
      participants: [
        {
          userId: PAID_USER_ID,
          displayName: 'Синтетический игрок',
          avatarUrl: null,
          level: null,
          role: 'PLAYER',
        },
      ],
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Проверить статус' }));
    expect(
      await screen.findByText('Вы в игре. Состав и доступные действия обновлены.'),
    ).toBeVisible();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('never falls back to a free command when paid conditions have no consent amount', async () => {
    const api = paidJoinGateway({
      conditions: () =>
        Promise.resolve({
          ...paidConditions(0),
          requiresPriceConsent: false,
          price: { status: 'MISSING', amountMinor: null, currency: 'RUB', confirmed: false },
        }),
    });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Выберите подписку' }),
      PAID_SUBSCRIPTION_ID,
    );
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));
    expect(api.joinGame).not.toHaveBeenCalled();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Условия и цена не подтверждены. Повторите проверку перед записью.'),
    ).toBeVisible();
  });
  afterEach(() => {
    window.localStorage.clear();
    if (originalLocks) Object.defineProperty(window.navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(window.navigator, 'locks');
  });

  it('shows the server-owned price, never posts before consent, and dispatches once', async () => {
    const user = userEvent.setup();
    const dispatch = deferred<unknown>();
    const joinPaidGame = vi.fn().mockReturnValue(dispatch.promise);
    const api = paidJoinGateway({ joinPaidGame });
    await openPaidConsent(api, user);

    // The price came from the conditions response, not from the client.
    expect(
      within(screen.getByRole('region', { name: 'Подтверждение стоимости' })).getByText(/2\s*500/, {
        selector: 'strong',
      }),
    ).toBeVisible();
    expect(joinPaidGame).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
    // While the request is in flight the consent panel is replaced by the dispatch status.
    expect(await screen.findByRole('heading', { name: 'Отправляем запись' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Подтвердить/ })).toBeNull();
    expect(joinPaidGame).toHaveBeenCalledTimes(1);
    const [gameIdArg, inputArg, keyArg] = joinPaidGame.mock.calls[0] as [
      string,
      {
        expectedRevision: number;
        subscriptionInstanceId: string;
        priceConsent: { amountMinor: number; currency: string };
      },
      string,
    ];
    expect(gameIdArg).toBe(PAID_GAME_ID);
    expect(inputArg).toEqual({
      expectedRevision: 4,
      subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
      priceConsent: { amountMinor: 250000, currency: 'RUB' },
    });
    expect(keyArg).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    dispatch.resolve(joinOperation('SUCCEEDED', { commercial: ownerConfirmedCommercial() }));

    expect(await screen.findByText(/Вы в игре/, {}, { timeout: 3_000 })).toBeVisible();
    // Keep the resolved original identity for readback on reopen; never turn it into a new purchase.
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.state).toBe(
      'SUCCEEDED',
    );
  });

  it('keeps custody and offers no purchase after a lost response', async () => {
    const user = userEvent.setup();
    const dispatchKeys: string[] = [];
    const joinPaidGame = vi.fn((gameIdValue: string, _input: unknown, idempotencyKey: string) => {
      dispatchKeys.push(idempotencyKey);
      return Promise.reject(
        Object.assign(new Error('owner unavailable'), {
          code: 'GAME_OWNER_UNAVAILABLE',
          operationStatus: 'UNKNOWN',
          recoveryAction: 'KEEP_SAME_ATTEMPT',
          canStartNewPurchase: false,
          gameId: gameIdValue,
          idempotencyKey,
        }),
      );
    });
    const api = paidJoinGateway({ joinPaidGame });
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));

    expect(
      await screen.findByRole('heading', { name: 'Проверяем статус оплаты' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Проверить статус' })).toBeVisible();

    const retained = loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID);
    expect(retained?.state).toBe('UNKNOWN');
    expect(retained?.idempotencyKey).toBe(dispatchKeys[0]);
    expect(retained?.dispatchStartedAt).toBeDefined();
    expect(joinPaidGame).toHaveBeenCalledTimes(1);
  });

  it('recovers an existing unresolved attempt on mount without resending the POST', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage);
    await resolveGameJoinAttempt(
      paidPrincipal,
      seeded.attempt,
      { state: 'UNKNOWN', operationId: PAID_OPERATION_ID },
      window.localStorage,
    );
    const joinPaidGame = vi.fn();
    const getPaidJoinOperation = vi
      .fn()
      .mockResolvedValue(joinOperation('UNKNOWN', { wait: true, commercial: unknownCommercial() }));
    const api = paidJoinGateway({ joinPaidGame, getPaidJoinOperation });

    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);

    expect(
      await screen.findByRole('heading', { name: 'Проверяем статус оплаты' }, { timeout: 3_000 }),
    ).toBeVisible();
    await waitFor(() =>
      expect(getPaidJoinOperation).toHaveBeenCalledWith(PAID_GAME_ID, PAID_ATTEMPT_KEY),
    );
    expect(joinPaidGame).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    // The original attempt is still the only custody record.
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBe(PAID_ATTEMPT_KEY);
  });

  it('requires a fresh explicit consent when the server price changed', async () => {
    const user = userEvent.setup();
    let currentAmount = 250000;
    const keys: string[] = [];
    const joinPaidGame = vi.fn((_gameIdValue: string, _input: unknown, idempotencyKey: string) => {
      keys.push(idempotencyKey);
      if (keys.length === 1) {
        currentAmount = 300000;
        return Promise.reject(
          Object.assign(new Error('price changed'), {
            code: 'GAME_PRICE_CONFIRMATION_REQUIRED',
          }),
        );
      }
      return Promise.resolve(
        joinOperation('SUCCEEDED', { commercial: ownerConfirmedCommercial() }),
      );
    });
    const api = paidJoinGateway({
      joinPaidGame,
      conditions: () => Promise.resolve(paidConditions(currentAmount)),
    });
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
    // The old consent is discarded; the new server amount is shown for a new explicit tap.
    expect(
      await screen.findByRole('heading', { name: 'Подтверждение стоимости' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(
      within(await screen.findByRole('region', { name: 'Подтверждение стоимости' })).getByText(
        /3\s*000/,
        { selector: 'strong' },
      ),
    ).toBeVisible();
    expect(joinPaidGame).toHaveBeenCalledTimes(1);
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));
    expect(await screen.findByText(/Вы в игре/, {}, { timeout: 3_000 })).toBeVisible();
    expect(joinPaidGame).toHaveBeenCalledTimes(2);
    expect(new Set(keys).size).toBe(2);
    expect(joinPaidGame.mock.calls[1]?.[1]).toMatchObject({
      priceConsent: { amountMinor: 300000, currency: 'RUB' },
    });
  });

  it('shows a service block separately from the payment contour', async () => {
    const user = userEvent.setup();
    const api = paidJoinGateway({
      joinPaidGame: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('blocked'), { code: 'GAME_SERVICE_BLOCKED' })),
    });
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));

    expect(
      await screen.findByRole('heading', { name: 'Услуга недоступна' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/по правилам клуба/);
    expect(screen.queryByRole('heading', { name: 'Оплата пока недоступна' })).toBeNull();
    // A definite server rejection leaves no purchase custody behind.
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();
  });

  it('shows the payment contour as unavailable, not as a service block', async () => {
    const user = userEvent.setup();
    const api = paidJoinGateway({
      joinPaidGame: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('unavailable'), { code: 'GAME_PAYMENT_REQUIRED' }),
        ),
    });
    await openPaidConsent(api, user);
    await user.click(screen.getByRole('button', { name: /^Подтвердить/ }));

    expect(
      await screen.findByRole('heading', { name: 'Оплата пока недоступна' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(screen.queryByText(/по правилам клуба/)).toBeNull();
  });

  it('keeps the untouched free JOIN when the gateway also supports paid join', async () => {
    const base = gateway();
    const freeGame = {
      ...game,
      id: '99999999-9999-4999-8999-999999999907',
      deepLink: '/games/99999999-9999-4999-8999-999999999907',
      startsAt: '2099-09-21T04:00:00Z',
      endsAt: '2099-09-21T05:30:00Z',
      displayState: 'FINDING_PLAYERS',
      priceSummary: null,
      viewerRelation: 'NONE',
      viewerPaymentState: 'NOT_REQUIRED',
      resultSummary: null,
      conversation: null,
    } as ViewerGameCard;
    const getGameJoinConditions = vi.fn();
    const joinPaidGame = vi.fn();
    const getPaidJoinOperation = vi.fn();
    const joinGame = vi.fn().mockResolvedValue({
      commandId: PAID_OPERATION_ID,
      operation: {
        id: PAID_OPERATION_ID,
        type: 'JOIN_GAME',
        status: 'SUCCEEDED',
        gameId: freeGame.id,
        aggregateRevision: freeGame.revision,
        createdAt: '2026-10-21T08:00:00.000Z',
        updatedAt: '2026-10-21T08:00:00.000Z',
        nextAction: { type: 'NONE' },
        error: null,
        commercial: null,
      },
      game: null,
      replayed: false,
    });
    const api: AuthGateway = {
      ...base,
      getHomeDashboard: vi.fn().mockResolvedValue(paidHome()),
      getGame: vi.fn().mockResolvedValue(freeGame),
      getGameJoinConditions,
      joinPaidGame,
      getPaidJoinOperation,
      joinGame,
    };
    const user = userEvent.setup();

    render(<GamesPage gateway={api} gameId={freeGame.id} joinPrincipal={paidPrincipal} />);
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));

    await waitFor(() =>
      expect(api.joinGame).toHaveBeenCalledWith(freeGame.id, freeGame.revision, undefined),
    );
    expect(joinPaidGame).not.toHaveBeenCalled();
    expect(getGameJoinConditions).not.toHaveBeenCalled();
    expect(await screen.findByText(/Вы в игре/)).toBeVisible();
  });

  it('asks for a subscription first and re-enables JOIN after an explicit selection', async () => {
    const user = userEvent.setup();
    const api = paidJoinGateway();
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    await user.click(await screen.findByRole('button', { name: 'Вступить в игру' }));

    expect(await screen.findByRole('heading', { name: 'Нужна подписка' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Вступить в игру' })).toBeNull();
    expect(api.joinPaidGame).not.toHaveBeenCalled();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Выберите подписку' }),
      PAID_SUBSCRIPTION_ID,
    );
    const joinButton = await screen.findByRole('button', { name: 'Вступить в игру' });
    await user.click(joinButton);
    expect(
      await screen.findByRole('heading', { name: 'Подтверждение стоимости' }, { timeout: 3_000 }),
    ).toBeVisible();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('rule (a): releases a quiet attempt that never dispatched and restores the fresh JOIN entry', async () => {
    await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      {
        createIdempotencyKey: () => PAID_ATTEMPT_KEY,
        now: () => new Date(Date.now() - 10 * 60_000),
      },
    );
    const getPaidJoinOperation = vi.fn();
    const api = paidJoinGateway({
      getGame: vi.fn().mockResolvedValue(paidGame),
      getPaidJoinOperation,
    });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    expect(await screen.findByText(/не была отправлена на сервер/)).toBeVisible();
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();
    expect(getPaidJoinOperation).not.toHaveBeenCalled();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Вступить в игру' })).toBeEnabled();
  });

  it('rule (a): keeps a just-created undispatched attempt instead of racing a concurrent dispatch', async () => {
    await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
    );
    const getPaidJoinOperation = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('not yet visible'), { code: 'GAME_OPERATION_NOT_FOUND' }),
      );
    const api = paidJoinGateway({ getPaidJoinOperation });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    expect(await screen.findByText(/Сервер пока не нашёл исходную операцию/)).toBeVisible();
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBe(PAID_ATTEMPT_KEY);
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });

  it('rule (b): releases a quiet dispatched key after a 404 so JOIN can be checked again', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      {
        createIdempotencyKey: () => PAID_ATTEMPT_KEY,
        now: () => new Date(Date.now() - 10 * 60_000),
      },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage, {
      now: () => new Date(Date.now() - 5 * 60_000),
    });
    const getPaidJoinOperation = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('void'), { code: 'GAME_OPERATION_NOT_FOUND' }));
    const api = paidJoinGateway({ getPaidJoinOperation });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    expect(await screen.findByText(/подтверждённой записи нет/)).toBeVisible();
    expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();
    expect(getPaidJoinOperation).toHaveBeenCalledWith(PAID_GAME_ID, PAID_ATTEMPT_KEY);
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('closes stale trusted-success custody on reopen so a later leave can JOIN again', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => PAID_ATTEMPT_KEY },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage);
    await resolveGameJoinAttempt(
      paidPrincipal,
      seeded.attempt,
      { state: 'SUCCEEDED', operationId: PAID_OPERATION_ID },
      window.localStorage,
    );
    const getPaidJoinOperation = vi.fn();
    const api = paidJoinGateway({
      getGame: vi.fn().mockResolvedValue(paidGame),
      getPaidJoinOperation,
    });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    // Resolved custody is convergence evidence, not an open purchase: it must not hide JOIN.
    expect(await screen.findByRole('button', { name: 'Вступить в игру' })).toBeEnabled();
    // Recovery runs asynchronously after the detail render; wait for the discard instead of racing
    // it immediately after the first render (this test flaked 1/692 in CI).
    await waitFor(() =>
      expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull(),
    );
    expect(getPaidJoinOperation).not.toHaveBeenCalled();
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
  it('rule (a): releases a quiet undispatched attempt from the manual status check', async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const startedAt = new Date('2026-10-27T09:00:00.000Z');
      vi.setSystemTime(startedAt);
      await beginGameJoinAttempt(
        paidPrincipal,
        {
          gameId: PAID_GAME_ID,
          expectedRevision: paidGame.revision,
          subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
          priceConsent: { amountMinor: 250000, currency: 'RUB' },
        },
        window.localStorage,
        { createIdempotencyKey: () => PAID_ATTEMPT_KEY, now: () => startedAt },
      );
      const getPaidJoinOperation = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('not yet visible'), { code: 'GAME_OPERATION_NOT_FOUND' }),
        );
      const api = paidJoinGateway({
        getGame: vi.fn().mockResolvedValue(paidGame),
        getPaidJoinOperation,
      });
      render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
      // The fresh marker-less attempt may still belong to an in-flight begin->dispatch: keep it.
      expect(await screen.findByText(/Сервер пока не нашёл исходную операцию/)).toBeVisible();
      expect(
        loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
      ).toBe(PAID_ATTEMPT_KEY);
      // Past the quiet window the same manual check must release it instead of staying stuck.
      vi.setSystemTime(new Date(startedAt.getTime() + 181_000));
      await user.click(screen.getByRole('button', { name: 'Проверить статус' }));
      expect(await screen.findByText(/подтверждённой записи нет/)).toBeVisible();
      expect(loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)).toBeNull();
      expect(api.joinPaidGame).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rule (b): keeps newer cross-tab custody when a quiet 404 finds a replaced attempt', async () => {
    const seeded = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      {
        createIdempotencyKey: () => PAID_ATTEMPT_KEY,
        now: () => new Date(Date.now() - 10 * 60_000),
      },
    );
    await markGameJoinAttemptDispatchStarted(paidPrincipal, seeded.attempt, window.localStorage, {
      now: () => new Date(Date.now() - 5 * 60_000),
    });
    let rejectReadback!: (reason: unknown) => void;
    const readback = new Promise<never>((_resolve, reject) => {
      rejectReadback = reject;
    });
    const getPaidJoinOperation = vi.fn(() => readback);
    const api = paidJoinGateway({
      getGame: vi.fn().mockResolvedValue(paidGame),
      getPaidJoinOperation,
    });
    render(<GamesPage gateway={api} gameId={PAID_GAME_ID} joinPrincipal={paidPrincipal} />);
    await waitFor(() => expect(getPaidJoinOperation).toHaveBeenCalledTimes(1));
    // Another tab replaces the stale custody with its own attempt while this readback is in flight.
    const NEWER_KEY = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    await discardGameJoinAttempt(paidPrincipal, seeded.attempt, window.localStorage, {
      allowUnresolved: true,
    });
    const newer = await beginGameJoinAttempt(
      paidPrincipal,
      {
        gameId: PAID_GAME_ID,
        expectedRevision: paidGame.revision,
        subscriptionInstanceId: PAID_SUBSCRIPTION_ID,
        priceConsent: { amountMinor: 250000, currency: 'RUB' },
      },
      window.localStorage,
      { createIdempotencyKey: () => NEWER_KEY },
    );
    rejectReadback(Object.assign(new Error('void'), { code: 'GAME_OPERATION_NOT_FOUND' }));
    expect(await screen.findByRole('heading', { name: 'Проверяем статус оплаты' })).toBeVisible();
    // The release must fail on the replaced identity and keep the newer custody.
    expect(
      loadGameJoinAttempt(paidPrincipal, window.localStorage, PAID_GAME_ID)?.idempotencyKey,
    ).toBe(newer.attempt.idempotencyKey);
    expect(api.joinPaidGame).not.toHaveBeenCalled();
  });
});

describe('GamesPage managed SELF leave recovery', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: (_n: string, _o: unknown, fn: () => unknown) => Promise.resolve().then(() => fn()),
      },
    });
  });
  afterEach(() => {
    window.localStorage.clear();
    if (originalLocks) Object.defineProperty(window.navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(window.navigator, 'locks');
  });
  it('shows a typed unsupported refusal without claiming owner acceptance or erasing the key', async () => {
    const api: AuthGateway = {
      ...gateway(),
      leaveGame: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('unsupported'), { code: 'GAME_PAYMENT_REQUIRED' }),
        ),
      getManagedLeaveOperation: vi.fn(),
    };
    const userId = '00000000-0000-4000-8000-000000000001';
    vi.mocked(api.getGame).mockResolvedValue({
      ...(await api.getGame(game.id)),
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      endsAt: new Date(Date.now() + 176400000).toISOString(),
      allowedActions: ['OPEN_DETAILS', 'LEAVE'],
    });
    render(
      <GamesPage
        gateway={api}
        gameId={game.id}
        joinPrincipal={{ tenantId: 'tenant', userId }}
        chatNavigationScope={{ tenantKey: 'local-padel', userId }}
      />,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Покинуть игру' }));
    await screen.findByText('Сервер отклонил выход: возврат по подписке сейчас недоступен.');
    expect(screen.queryByText('Выход из игры подтверждён.')).not.toBeInTheDocument();
    expect(window.localStorage.length).toBeGreaterThan(0);
    expect(api.leaveGame).toHaveBeenCalledOnce();
  });
  it('renders UNKNOWN as pending, preserves key across reload and manual retry, clears view on account change', async () => {
    const user = userEvent.setup();
    const operationId = '22222222-2222-4222-8222-222222222222';
    const result = {
      commandId: operationId,
      operation: {
        id: operationId,
        type: 'LEAVE_GAME',
        status: 'UNKNOWN',
        gameId: game.id,
        aggregateRevision: 8,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
        error: null,
      },
      game: null,
      replayed: true,
    };
    const api: AuthGateway = {
      ...gateway(),
      leaveGame: vi.fn().mockResolvedValue(result),
      getManagedLeaveOperation: vi.fn().mockResolvedValue(result),
    };
    const detail: ViewerGameCard = {
      ...(await api.getGame(game.id)),
      startsAt: new Date(Date.now() + 172800000).toISOString(),
      endsAt: new Date(Date.now() + 176400000).toISOString(),
      allowedActions: ['OPEN_DETAILS', 'LEAVE'],
    };
    vi.mocked(api.getGame).mockResolvedValue(detail);
    const principal = { tenantId: 'tenant', userId: '00000000-0000-4000-8000-000000000001' };
    const view = render(
      <GamesPage
        gateway={api}
        gameId={game.id}
        joinPrincipal={principal}
        chatNavigationScope={{ tenantKey: 'local-padel', userId: principal.userId }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Покинуть игру' }));
    await screen.findByRole('button', { name: 'Повторить исходный запрос' });
    expect(screen.queryByText('Выход из игры подтверждён.')).not.toBeInTheDocument();
    const key = vi.mocked(api.leaveGame).mock.calls[0]?.[1]?.idempotencyKey;
    expect(key).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Повторить исходный запрос' }));
    expect(vi.mocked(api.leaveGame).mock.calls[1]?.[1]?.idempotencyKey).toBe(key);
    view.unmount();
    const next = render(<GamesPage gateway={api} gameId={game.id} joinPrincipal={principal} />);
    await waitFor(() => expect(api.getManagedLeaveOperation).toHaveBeenCalledWith(game.id, key));
    expect(api.leaveGame).toHaveBeenCalledTimes(2);
    next.rerender(
      <GamesPage
        gateway={api}
        gameId={game.id}
        joinPrincipal={{ ...principal, userId: 'other-account' }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Повторить исходный запрос' }),
      ).not.toBeInTheDocument(),
    );
  });
});
