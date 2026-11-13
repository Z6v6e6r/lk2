import type { UserUpcomingBookings } from './auth-gateway.js';

type UpcomingBooking = UserUpcomingBookings['items'][number];

/** Prefer the server's explicit association over a legacy snapshot link. */
export function upcomingBookingDetailsRoute(item: UpcomingBooking): string {
  return item.kind === 'game' && item.gameId
    ? `/games/${encodeURIComponent(item.gameId)}`
    : item.route;
}
