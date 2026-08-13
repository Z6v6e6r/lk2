// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TournamentDetailPage } from './TournamentDetailPage.js';
import type { AuthGateway, PublicTournamentSummary, UserUpcomingBookings } from './auth-gateway.js';
import { tournamentDetailRange } from './tournament-detail-range.js';

const tournament: PublicTournamentSummary = {
  id: '91a1c7c6-73d0-4270-a400-3358873e4d9b',
  title: 'Субботний ДвиЖ Мексикано D+/C',
  format: 'Мексикано',
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 7_200_000).toISOString(),
  venue: 'Сколково',
  trainerName: 'Сколково Мокроусова',
  levelRange: { from: 'D+', to: 'C' },
  organizer: { displayName: 'Сколково Мокроусова', avatarUrl: null },
  capacity: { total: 12, registered: 11, open: 1, waitlist: 0 },
  status: 'REGISTRATION',
  route: '/tournaments?event=91a1c7c6-73d0-4270-a400-3358873e4d9b',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('TournamentDetailPage', () => {
  it('loads the requested summary and switches the design tabs', async () => {
    window.history.pushState({}, '', `/tournaments?event=${tournament.id}`);
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const getPublicTournamentSummary = vi
      .fn<NonNullable<AuthGateway['getPublicTournamentSummary']>>()
      .mockResolvedValue(tournament);
    const getTournamentParticipants = vi.fn().mockResolvedValue({
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        displayName: `Игрок ${index + 1}`,
        level: 'D+' as const,
        avatarUrl: null,
      })),
      refreshedAt: new Date().toISOString(),
    });
    const gateway = {
      getPublicTournamentSummary,
      getTournamentParticipants,
    } as unknown as AuthGateway;
    const user = userEvent.setup();

    render(<TournamentDetailPage gateway={gateway} tournamentId={tournament.id} />);

    expect(await screen.findByRole('heading', { name: tournament.title })).toBeVisible();
    expect(within(screen.getByRole('tabpanel')).getByText('11')).toBeVisible();
    expect(screen.getByText('/ 12')).toBeVisible();
    const level = screen.getByText('от D+ до C');
    expect(level).toBeVisible();
    expect(level.previousElementSibling?.querySelector('svg')).toBeInTheDocument();
    await waitFor(() => expect(getPublicTournamentSummary).toHaveBeenCalledOnce());
    const detailCall = getPublicTournamentSummary.mock.calls[0];
    expect(detailCall?.[0]).toBe(tournament.id);
    expect(detailCall?.[1]?.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(detailCall?.[1]?.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await screen.findByText('Игрок 1')).toBeVisible();
    expect(screen.queryByText('Игрок 6')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать больше' }));
    expect(screen.getByText('Игрок 6')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Регламент' }));
    expect(screen.getByText('Организатор пока не опубликовал регламент.')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Назад к событиям' }));
    expect(historyBack).toHaveBeenCalledOnce();
    historyBack.mockRestore();
  });

  it('builds the lookup range from Moscow calendar dates near UTC midnight', () => {
    expect(tournamentDetailRange(new Date('2026-08-01T21:30:00.000Z'))).toEqual({
      dateFrom: '2026-08-02',
      dateTo: '2026-08-17',
    });
  });

  it('shows leave tournament for a confirmed booking more than 24 hours before start', async () => {
    const futureTournament: PublicTournamentSummary = {
      ...tournament,
      startsAt: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString(),
      endsAt: new Date(Date.now() + 50 * 60 * 60 * 1_000).toISOString(),
    };
    const booking: UserUpcomingBookings['items'][number] = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'tournament',
      title: futureTournament.title,
      startsAt: futureTournament.startsAt,
      endsAt: futureTournament.endsAt,
      venue: futureTournament.venue,
      status: 'confirmed',
      route: futureTournament.route,
    };
    const gateway = {
      getPublicTournamentSummary: vi.fn().mockResolvedValue(futureTournament),
      getUpcomingBookings: vi.fn().mockResolvedValue({
        version: 'a'.repeat(64),
        generatedAt: new Date().toISOString(),
        staleAt: new Date(Date.now() + 60_000).toISOString(),
        items: [booking],
      }),
      getTournamentParticipants: vi.fn().mockResolvedValue({
        items: [],
        refreshedAt: new Date().toISOString(),
      }),
    } as unknown as AuthGateway;

    render(<TournamentDetailPage gateway={gateway} tournamentId={futureTournament.id} />);

    expect(await screen.findByRole('button', { name: 'Покинуть турнир' })).toBeEnabled();
    expect(
      screen.getByText('Выход из турнира будет подключён отдельным безопасным действием'),
    ).toBeVisible();
  });

  it('locks tournament exit during the last 24 hours', async () => {
    const nearTournament: PublicTournamentSummary = {
      ...tournament,
      startsAt: new Date(Date.now() + 23 * 60 * 60 * 1_000).toISOString(),
      endsAt: new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString(),
    };
    const booking: UserUpcomingBookings['items'][number] = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'tournament',
      title: nearTournament.title,
      startsAt: nearTournament.startsAt,
      endsAt: nearTournament.endsAt,
      venue: nearTournament.venue,
      status: 'confirmed',
      route: nearTournament.route,
    };
    const gateway = {
      getPublicTournamentSummary: vi.fn().mockResolvedValue(nearTournament),
      getUpcomingBookings: vi.fn().mockResolvedValue({
        version: 'a'.repeat(64),
        generatedAt: new Date().toISOString(),
        staleAt: new Date(Date.now() + 60_000).toISOString(),
        items: [booking],
      }),
      getTournamentParticipants: vi.fn().mockResolvedValue({
        items: [],
        refreshedAt: new Date().toISOString(),
      }),
    } as unknown as AuthGateway;

    render(<TournamentDetailPage gateway={gateway} tournamentId={nearTournament.id} />);

    expect(await screen.findByRole('button', { name: 'Вы записаны' })).toBeDisabled();
    expect(
      screen.getByText('Покинуть турнир можно не позднее чем за 24 часа до начала'),
    ).toBeVisible();
  });

  it('uses the complete upcoming-booking snapshot when public discovery cannot resolve its id', async () => {
    const booking: UserUpcomingBookings['items'][number] = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'tournament',
      title: 'Падел Турнир',
      startsAt: '2026-08-04T05:30:00.000Z',
      endsAt: '2026-08-04T07:00:00.000Z',
      venue: 'Терехово',
      status: 'confirmed',
      route: `/tournaments?event=${tournament.id}`,
      participantsCount: 4,
      openSlots: 0,
    };
    const gateway = {
      getPublicTournamentSummary: vi.fn().mockRejectedValue(new Error('TOURNAMENT_NOT_FOUND')),
      getUpcomingBookings: vi.fn().mockResolvedValue({
        version: 'a'.repeat(64),
        generatedAt: '2026-08-02T08:00:00.000Z',
        staleAt: '2026-08-02T08:01:00.000Z',
        items: [booking],
      }),
      getTournamentParticipants: vi.fn(),
    } as unknown as AuthGateway;

    render(<TournamentDetailPage gateway={gateway} tournamentId={tournament.id} />);

    expect(await screen.findByRole('heading', { name: 'Падел Турнир', level: 1 })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Турнир из моих записей' })).toBeVisible();
    expect(screen.getByText('Показаны подтверждённые данные из вашей записи.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(gateway.getTournamentParticipants).not.toHaveBeenCalled();
  });

  it('replaces the booking fallback with the canonical tournament when public discovery finishes later', async () => {
    const booking: UserUpcomingBookings['items'][number] = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'tournament',
      title: 'Падел Турнир',
      startsAt: '2026-08-04T05:30:00.000Z',
      endsAt: '2026-08-04T07:00:00.000Z',
      venue: 'Терехово',
      status: 'confirmed',
      route: `/tournaments?event=${tournament.id}`,
      participantsCount: 4,
      openSlots: 0,
    };
    let resolvePublic!: (value: PublicTournamentSummary) => void;
    const publicRead = new Promise<PublicTournamentSummary>((resolve) => {
      resolvePublic = resolve;
    });
    const gateway = {
      getPublicTournamentSummary: vi.fn().mockReturnValue(publicRead),
      getUpcomingBookings: vi.fn().mockResolvedValue({
        version: 'a'.repeat(64),
        generatedAt: '2026-08-02T08:00:00.000Z',
        staleAt: '2026-08-02T08:01:00.000Z',
        items: [booking],
      }),
      getTournamentParticipants: vi.fn().mockResolvedValue({
        items: [],
        refreshedAt: new Date().toISOString(),
      }),
    } as unknown as AuthGateway;

    render(<TournamentDetailPage gateway={gateway} tournamentId={tournament.id} />);

    expect(await screen.findByRole('region', { name: 'Турнир из моих записей' })).toBeVisible();
    await act(async () => {
      resolvePublic(tournament);
      await publicRead;
    });
    expect(await screen.findByRole('region', { name: 'Информация о турнире' })).toBeVisible();
    expect(screen.getByRole('heading', { name: tournament.title, level: 1 })).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Турнир из моих записей' }),
    ).not.toBeInTheDocument();
  });
});
