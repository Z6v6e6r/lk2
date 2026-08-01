// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TournamentDetailPage } from './TournamentDetailPage.js';
import type { AuthGateway, PublicTournamentSummary } from './auth-gateway.js';
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

describe('TournamentDetailPage', () => {
  it('loads the requested summary and switches the design tabs', async () => {
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
    expect(screen.getByText('11')).toBeVisible();
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
  });

  it('builds the lookup range from Moscow calendar dates near UTC midnight', () => {
    expect(tournamentDetailRange(new Date('2026-08-01T21:30:00.000Z'))).toEqual({
      dateFrom: '2026-08-02',
      dateTo: '2026-08-17',
    });
  });
});
