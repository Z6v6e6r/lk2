import { describe, expect, it } from 'vitest';

import {
  normalizeVivaUpcomingBookingPayload,
  vivaReadSnapshotUuid,
} from './upcoming-booking-source.js';

describe('Viva upcoming booking source normalization', () => {
  it('accepts only active list members and classifies games, trainings and tournaments', () => {
    const payload = {
      bookings: {
        content: [
          { id: 'booking-game-secret', isCancelled: false },
          { id: 'booking-training-secret', isCancelled: false },
          { id: 'booking-tournament-secret', isCancelled: false },
          { id: 'booking-cancelled-secret', isCancelled: true },
        ],
      },
      details: [
        {
          id: 'booking-game-secret',
          isCancelled: false,
          transactionStatus: null,
          exercise: {
            id: 'exercise-game-secret',
            timeFrom: '2026-08-01T12:00:00+03:00',
            timeTo: '2026-08-01T14:00:00+03:00',
            inWaitlist: false,
            direction: { id: 4588, name: 'Игры' },
            type: { id: 1613, name: 'Открытая игра' },
            studio: { name: 'Терехово', address: 'Москва' },
            room: { name: 'Корт 1' },
          },
        },
        {
          id: 'booking-training-secret',
          isCancelled: false,
          transactionStatus: { transactionStatus: 'UNPAID' },
          exercise: {
            id: 'exercise-training-secret',
            timeFrom: '2026-08-02T12:00:00+03:00',
            inWaitlist: false,
            direction: { id: 100, name: 'Падел' },
            type: { id: 605, name: 'Групповая тренировка' },
            studio: { name: 'Селигерская', address: null },
          },
        },
        {
          id: 'booking-tournament-secret',
          isCancelled: false,
          transactionStatus: null,
          exercise: {
            id: 'exercise-tournament-secret',
            timeFrom: '2026-08-03T12:00:00+03:00',
            inWaitlist: true,
            direction: { id: 2617, name: 'Турниры' },
            type: { id: 839, name: 'Американо' },
            studio: { name: 'Терехово', address: null },
          },
        },
        {
          id: 'booking-cancelled-secret',
          isCancelled: false,
          transactionStatus: null,
          exercise: {
            timeFrom: '2026-08-04T12:00:00+03:00',
            inWaitlist: false,
            direction: { id: 100, name: 'Падел' },
            type: { id: 605, name: 'Групповая тренировка' },
            studio: { name: 'Терехово', address: null },
          },
        },
      ],
    };

    expect(
      normalizeVivaUpcomingBookingPayload(payload, {
        now: new Date('2026-07-30T00:00:00.000Z'),
      }),
    ).toEqual([
      expect.objectContaining({
        bookingRef: 'booking-game-secret',
        exerciseRef: 'exercise-game-secret',
        kind: 'GAME',
        status: 'confirmed',
      }),
      expect.objectContaining({
        bookingRef: 'booking-training-secret',
        kind: 'TRAINING',
        status: 'payment_required',
      }),
      expect.objectContaining({
        bookingRef: 'booking-tournament-secret',
        kind: 'TOURNAMENT',
        status: 'waitlist',
      }),
    ]);
  });

  it('creates stable PadlHub UUIDs without exposing the source reference', () => {
    const first = vivaReadSnapshotUuid('booking', 'private-provider-booking-id');
    expect(first).toBe(vivaReadSnapshotUuid('booking', 'private-provider-booking-id'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toContain('private-provider-booking-id');
  });
});
