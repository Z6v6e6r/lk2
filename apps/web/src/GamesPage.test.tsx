// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GamesPage } from './GamesPage.js';
import { profileUserIdForParticipant } from './game-participant-profile.js';
import type {
  AuthGateway,
  GameCard as ViewerGameCard,
  PublicGameCard,
  PublicCoachGameSummary,
  PublicTournamentSummary,
} from './auth-gateway.js';

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

const coachGame: PublicCoachGameSummary = {
  id: '88888888-8888-4888-8888-888888888888',
  title: 'Игра с тренером · C',
  startsAt: new Date(Date.now() + 1_800_000).toISOString(),
  endsAt: new Date(Date.now() + 5_400_000).toISOString(),
  stationName: 'Селигерская',
  courtName: 'Корт №2',
  level: 'C',
  trainer: {
    displayName: 'Кирилл Боев',
    avatarUrl:
      '/public/api/v1/local-padel/coach-games/88888888-8888-4888-8888-888888888888/trainer-avatar',
  },
  capacity: { total: 3, occupied: 1, open: 2 },
  status: 'JOINABLE',
};

function gateway(): AuthGateway {
  return {
    listPublicGames: vi.fn().mockResolvedValue({ items: [game], nextCursor: null }),
    listPublicTournamentSummaries: vi.fn().mockResolvedValue({ items: [] }),
    listPublicCoachGameSummaries: vi.fn().mockResolvedValue({ items: [] }),
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

afterEach(() => cleanup());

describe('GamesPage discovery', () => {
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
      '/games/new',
    );

    const createDescription = screen.getByText('Выберите станцию, время и собери свою игру');
    expect(createDescription.closest('a')).toHaveClass('games-create-hero');
    expect(createDescription.closest('a')).toHaveAttribute('href', '/games/new');
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
    const initialFilters = vi.mocked(api.listPublicGames).mock.calls[0]?.[0];
    expect(typeof initialFilters?.startsFrom).toBe('string');
    expect(typeof initialFilters?.startsTo).toBe('string');

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
    expect(api.listPublicGames).toHaveBeenCalledWith(
      expect.objectContaining({ availability: 'JOINABLE', limit: 20 }),
    );

    await user.click(screen.getByRole('button', { name: 'Вступить в игру' }));
    expect(api.joinGame).toHaveBeenCalledWith(game.id, game.revision);
    expect(await screen.findByText(/Вы в игре/)).toBeInTheDocument();
  });

  it('selects multiple event types from a checkbox dropdown and translates the coach type', async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    await user.click(screen.getByRole('button', { name: 'Все типы' }));
    const typeFilter = screen.getByRole('group', { name: 'Тип события' });
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра' })).toBeInTheDocument();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' })).toBeInTheDocument();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Турнир' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Тип игры' })).not.toBeInTheDocument();

    await user.click(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' }));
    await waitFor(() =>
      expect(api.listPublicGames).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'COACH_GAME', availability: 'JOINABLE' }),
      ),
    );
    await user.click(within(typeFilter).getByRole('checkbox', { name: 'Турнир' }));
    expect(within(typeFilter).getByRole('checkbox', { name: 'Игра + Тренер' })).toBeChecked();
    expect(within(typeFilter).getByRole('checkbox', { name: 'Турнир' })).toBeChecked();
  });

  it('loads bounded tournament and coach-game summaries without roster requests', async () => {
    const api = gateway();
    vi.mocked(api.listPublicTournamentSummaries!).mockResolvedValueOnce({ items: [tournament] });
    vi.mocked(api.listPublicCoachGameSummaries!).mockResolvedValueOnce({ items: [coachGame] });
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);

    expect(await screen.findByText(tournament.title)).toBeInTheDocument();
    expect(api.listPublicTournamentSummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        availability: 'JOINABLE',
        limit: 50,
      }),
    );
    expect(api.listPublicCoachGameSummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        availability: 'JOINABLE',
        limit: 50,
      }),
    );
    const coachGameCard = screen.getByText(coachGame.title).closest('article');
    expect(coachGameCard).not.toBeNull();
    expect(coachGameCard).toHaveAttribute('data-event-kind', 'COACH_GAME');
    expect(within(coachGameCard!).getByText('Уровень C')).toBeInTheDocument();
    expect(within(coachGameCard!).getByText('Кирилл Боев')).toBeInTheDocument();
    const trainerAvatar = within(coachGameCard!).getByRole('img', {
      name: 'Тренер: Кирилл Боев',
    });
    expect(trainerAvatar.querySelector('img')).toHaveAttribute('src', coachGame.trainer?.avatarUrl);
    expect(trainerAvatar.querySelector('img')).toHaveAttribute('loading', 'lazy');
    expect(trainerAvatar.querySelector('span')).toHaveAttribute('hidden');
    expect(within(coachGameCard!).getByText('Доступно 2 места из 3')).toBeInTheDocument();
    expect(within(coachGameCard!).getByLabelText('Доступно мест: 2')).toBeInTheDocument();
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
      expect(api.listPublicGames).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'COACH_GAME' }),
      ),
    );
    expect(api.listPublicTournamentSummaries).toHaveBeenCalledTimes(1);
    expect(api.listPublicCoachGameSummaries).toHaveBeenCalledTimes(2);
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
      const recentFilters = vi
        .mocked(api.listPublicGames)
        .mock.calls.slice(-2)
        .map(([filters]) => filters);
      expect(recentFilters.map((filters) => filters?.stationId)).toEqual(
        expect.arrayContaining([game.station.id, secondStation.id]),
      );
      recentFilters.forEach((filters) => {
        expect(filters).toBeDefined();
        if (!filters) return;
        expect(filters).toMatchObject({
          availability: 'INCLUDE_FULL',
          levelFrom: 'C',
          levelTo: 'B+',
        });
        expect(filters.startsFrom).toContain('T15:00:00.000Z');
      });
    });
    expect(screen.getByRole('button', { name: 'Убрать фильтр После 18:00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать фильтр Уровень C–B+' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Сбросить всё' }));
    await waitFor(() => {
      const filters = vi.mocked(api.listPublicGames).mock.calls.at(-1)?.[0];
      expect(filters).not.toHaveProperty('stationId');
      expect(filters).not.toHaveProperty('levelFrom');
      expect(filters).not.toHaveProperty('levelTo');
    });
    expect(screen.getByRole('checkbox', { name: 'Не показывать набранные' })).toBeChecked();
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
