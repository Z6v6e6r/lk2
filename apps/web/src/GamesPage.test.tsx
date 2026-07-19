// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GamesPage } from './GamesPage.js';
import type { AuthGateway, PublicGameCard } from './auth-gateway.js';

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
