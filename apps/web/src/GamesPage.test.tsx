// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GamesPage } from './GamesPage.js';
import type { AuthGateway, GameCard as ViewerGameCard, PublicGameCard } from './auth-gateway.js';

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

function gateway(): AuthGateway {
  return {
    listPublicGames: vi.fn().mockResolvedValue({ items: [game], nextCursor: null }),
    listMyGames: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
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

    const createDescription = screen.getByText('Выберите станцию, время и откройте набор игроков');
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
      expect.objectContaining({ availability: 'INCLUDE_FULL', limit: 20 }),
    );

    await user.click(screen.getByRole('button', { name: 'Вступить в игру' }));
    expect(api.joinGame).toHaveBeenCalledWith(game.id, game.revision);
    expect(await screen.findByText(/Вы в игре/)).toBeInTheDocument();
  });

  it('translates a kind filter into the public API query', async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<GamesPage gateway={api} />);
    await screen.findByText(game.title);

    await user.click(screen.getByRole('button', { name: 'Рейтинговые' }));
    await waitFor(() =>
      expect(api.listPublicGames).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'RATING', availability: 'INCLUDE_FULL' }),
      ),
    );
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
