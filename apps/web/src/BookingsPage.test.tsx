// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BookingRecommendationPage, UserUpcomingBookings } from './auth-gateway.js';
import { BookingsPage } from './BookingsPage.js';

const bookings: UserUpcomingBookings = {
  version: 'bookings-1',
  generatedAt: '2026-07-18T09:00:00.000Z',
  staleAt: '2026-07-18T09:05:00.000Z',
  items: [
    {
      id: '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      kind: 'game',
      title: 'Утренняя игра',
      startsAt: '2026-07-20T07:00:00.000Z',
      venue: 'Селигерская',
      status: 'confirmed',
      route: '/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
    },
  ],
};

const recommendations: BookingRecommendationPage = {
  version: 'a'.repeat(64),
  generatedAt: '2026-07-18T09:00:00.000Z',
  staleAt: '2026-07-18T09:05:00.000Z',
  personalization: 'BASIC',
  items: [],
  nextCursor: null,
};

afterEach(cleanup);

describe('BookingsPage', () => {
  it('keeps history and recommendations lazy while showing truthful upcoming records', async () => {
    const loadHistory = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const loadRecommendations = vi.fn().mockResolvedValue(recommendations);
    render(
      <BookingsPage
        bookings={bookings}
        tenantName="ПадлХАБ"
        loadHistory={loadHistory}
        loadRecommendations={loadRecommendations}
      />,
    );

    expect(screen.getByRole('link', { name: /Утренняя игра/ })).toHaveAttribute(
      'href',
      bookings.items[0]?.route,
    );
    expect(loadHistory).not.toHaveBeenCalled();
    expect(loadRecommendations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'История' }));
    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('История пока пуста'),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Для меня' }));
    await vi.waitFor(() => expect(loadRecommendations).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Пока нет подходящих игр'),
    );
  });
});
