// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { TournamentDirectoryPage } from './TournamentDirectoryPage.js';
import { tournamentDetailRange } from './tournament-detail-range.js';
import type { AuthGateway } from './auth-gateway.js';
afterEach(cleanup);
describe('Android dated tournament directory', () => {
  it('preserves Moscow local day across UTC midnight without deriving owner date from startsAt', async () => {
    expect(tournamentDetailRange(new Date('2026-11-01T20:59:59Z'))).toEqual({
      dateFrom: '2026-11-01',
      dateTo: '2026-11-16',
    });
    expect(tournamentDetailRange(new Date('2026-11-01T21:00:00Z'))).toEqual({
      dateFrom: '2026-11-02',
      dateTo: '2026-11-17',
    });
    const list = vi
      .fn<NonNullable<AuthGateway['listPublicTournamentSummaries']>>()
      .mockResolvedValue({ items: [] });
    render(<TournamentDirectoryPage gateway={{ listPublicTournamentSummaries: list }} />);
    expect(await screen.findByText('В выбранные дни турниров пока нет.')).toBeVisible();
    expect(list).toHaveBeenCalledWith({
      ...tournamentDetailRange(),
      limit: 50,
      availability: 'INCLUDE_FULL',
    });
  });
  it('unavailable discovery remains explicit and cannot show signup', async () => {
    const list = vi
      .fn<NonNullable<AuthGateway['listPublicTournamentSummaries']>>()
      .mockRejectedValue(new TypeError('offline'));
    render(<TournamentDirectoryPage gateway={{ listPublicTournamentSummaries: list }} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Записаться на турнир' })).not.toBeInTheDocument();
  });
});
