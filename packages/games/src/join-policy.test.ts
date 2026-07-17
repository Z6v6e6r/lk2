import { describe, expect, it } from 'vitest';

import {
  GameDomainError,
  assertCanJoinGame,
  assertCanJoinGameFacts,
  assertCanJoinWaitlist,
  assertCanJoinWaitlistFacts,
  assertCanLeaveGame,
  assertCanLeaveGameFacts,
  assertCanLeaveWaitlistFacts,
  type GameCardProjectionInput,
} from './index.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76';
const stationId = 'ee2eb9ac-fcb5-40d2-a714-97b9ef75a4a0';
const organizerId = 'f75b4e2a-9c98-4b26-85b6-ae58e0edca24';
const playerId = 'a9c106f7-0db8-4e27-b1e0-298829f94730';
const outsiderId = '640a3ae4-ef3b-4789-b6a0-2905bca1e523';
const waitlistedId = '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70';
const reservationId = '8ef58c73-f94c-4e04-97e8-f6057afc0ec1';
const now = '2026-08-01T10:00:00+03:00';

function snapshot(overrides: Partial<GameCardProjectionInput> = {}): GameCardProjectionInput {
  return {
    id: gameId,
    tenantId,
    revision: 1,
    organizerUserId: organizerId,
    title: 'Открытая игра',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    lifecycleState: 'SCHEDULED',
    startsAt: '2026-08-01T18:00:00+03:00',
    endsAt: '2026-08-01T19:30:00+03:00',
    timezone: 'Europe/Moscow',
    station: { id: stationId, name: 'Селигерская' },
    capacity: 4,
    participants: [
      {
        userId: organizerId,
        displayName: 'Организатор',
        role: 'ORGANIZER',
        paymentState: 'PAID',
      },
    ],
    seatReservations: [],
    waitlist: [],
    waitlistEnabled: true,
    joinCutoffAt: '2026-08-01T17:30:00+03:00',
    ...overrides,
  };
}

function expectCode(action: () => void, code: GameDomainError['code']): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GameDomainError);
  expect((thrown as GameDomainError).code).toBe(code);
}

describe('join policy', () => {
  it('allows a new user to join an open scheduled game', () => {
    expect(() => assertCanJoinGame(snapshot(), { now, viewerUserId: outsiderId })).not.toThrow();
  });

  it('rejects already joined, reserved and waitlisted users', () => {
    expectCode(
      () => assertCanJoinGame(snapshot(), { now, viewerUserId: organizerId }),
      'GAME_ALREADY_JOINED',
    );
    expectCode(
      () =>
        assertCanJoinGame(
          snapshot({
            seatReservations: [
              {
                id: reservationId,
                userId: outsiderId,
                expiresAt: '2026-08-01T10:15:00+03:00',
                paymentState: 'PROCESSING',
              },
            ],
          }),
          { now, viewerUserId: outsiderId },
        ),
      'GAME_ALREADY_RESERVED',
    );
    expectCode(
      () =>
        assertCanJoinGame(snapshot({ waitlist: [{ userId: waitlistedId, position: 1 }] }), {
          now,
          viewerUserId: waitlistedId,
        }),
      'GAME_ALREADY_WAITLISTED',
    );
  });

  it('rejects direct join when the game is full', () => {
    expectCode(
      () =>
        assertCanJoinGame(
          snapshot({
            participants: [
              {
                userId: organizerId,
                displayName: 'Организатор',
                role: 'ORGANIZER',
                paymentState: 'PAID',
              },
              {
                userId: playerId,
                displayName: 'Игрок 2',
                role: 'PLAYER',
                paymentState: 'PAID',
              },
              {
                userId: outsiderId,
                displayName: 'Игрок 3',
                role: 'PLAYER',
                paymentState: 'PAID',
              },
              {
                userId: waitlistedId,
                displayName: 'Игрок 4',
                role: 'PLAYER',
                paymentState: 'PAID',
              },
            ],
          }),
          {
            now,
            viewerUserId: 'c68f263e-4a54-4472-9254-103e3b332538',
          },
        ),
      'GAME_FULL',
    );
  });

  it('rejects join at the command cut-off', () => {
    expectCode(
      () =>
        assertCanJoinGame(snapshot(), {
          now: '2026-08-01T17:30:00+03:00',
          viewerUserId: outsiderId,
        }),
      'GAME_JOIN_CUTOFF_PASSED',
    );
  });
});

describe('waitlist policy', () => {
  const fullGame = () =>
    snapshot({
      capacity: 2,
      participants: [
        {
          userId: organizerId,
          displayName: 'Организатор',
          role: 'ORGANIZER',
          paymentState: 'PAID',
        },
        {
          userId: playerId,
          displayName: 'Игрок',
          role: 'PLAYER',
          paymentState: 'PAID',
        },
      ],
    });

  it('allows a new user into an enabled waitlist only when full', () => {
    expect(() =>
      assertCanJoinWaitlist(fullGame(), { now, viewerUserId: outsiderId }),
    ).not.toThrow();
    expectCode(
      () => assertCanJoinWaitlist(snapshot(), { now, viewerUserId: outsiderId }),
      'GAME_WAITLIST_NOT_AVAILABLE',
    );
  });

  it('fails closed when waitlist is disabled', () => {
    expectCode(
      () =>
        assertCanJoinWaitlist(snapshot({ ...fullGame(), waitlistEnabled: false }), {
          now,
          viewerUserId: outsiderId,
        }),
      'GAME_WAITLIST_DISABLED',
    );
  });
});

describe('leave policy', () => {
  const joinedGame = () =>
    snapshot({
      participants: [
        {
          userId: organizerId,
          displayName: 'Организатор',
          role: 'ORGANIZER',
          paymentState: 'PAID',
        },
        {
          userId: playerId,
          displayName: 'Игрок',
          role: 'PLAYER',
          paymentState: 'PAID',
        },
      ],
    });

  it('allows a participant to leave before cut-off', () => {
    expect(() => assertCanLeaveGame(joinedGame(), { now, viewerUserId: playerId })).not.toThrow();
  });

  it('requires the organizer to use game cancellation', () => {
    expectCode(
      () => assertCanLeaveGame(joinedGame(), { now, viewerUserId: organizerId }),
      'GAME_ORGANIZER_MUST_CANCEL',
    );
  });

  it('rejects leave after cut-off', () => {
    expectCode(
      () =>
        assertCanLeaveGame(joinedGame(), {
          now: '2026-08-01T17:31:00+03:00',
          viewerUserId: playerId,
        }),
      'GAME_NOT_LEAVABLE',
    );
  });
});

describe('persistence-safe roster facts policy', () => {
  const facts = {
    lifecycleState: 'SCHEDULED' as const,
    startsAt: '2026-08-01T18:00:00+03:00',
    joinCutoffAt: '2026-08-01T17:30:00+03:00',
    capacity: 4,
    activeParticipantCount: 1,
    activeReservationCount: 0,
    waitlistEnabled: true,
    viewerRelation: 'NONE' as const,
  };

  it('applies the same join and capacity invariants without a presentation snapshot', () => {
    expect(() => assertCanJoinGameFacts(facts, now)).not.toThrow();
    expectCode(
      () =>
        assertCanJoinGameFacts(
          { ...facts, activeParticipantCount: 3, activeReservationCount: 1 },
          now,
        ),
      'GAME_FULL',
    );
    expectCode(
      () =>
        assertCanJoinGameFacts(
          { ...facts, activeParticipantCount: 4, activeReservationCount: 1 },
          now,
        ),
      'GAME_CAPACITY_INVARIANT_VIOLATION',
    );
  });

  it('allows waitlist only at capacity and permits only the current entry to leave', () => {
    expect(() =>
      assertCanJoinWaitlistFacts({ ...facts, activeParticipantCount: 4 }, now),
    ).not.toThrow();
    expectCode(() => assertCanJoinWaitlistFacts(facts, now), 'GAME_WAITLIST_NOT_AVAILABLE');
    expect(() =>
      assertCanLeaveWaitlistFacts({ ...facts, viewerRelation: 'WAITLISTED' }, now),
    ).not.toThrow();
    expectCode(() => assertCanLeaveWaitlistFacts(facts, now), 'GAME_NOT_WAITLISTED');
  });

  it('keeps organizer cancellation and participant leave rules shared with persistence', () => {
    expectCode(
      () => assertCanLeaveGameFacts({ ...facts, viewerRelation: 'ORGANIZER' }, now),
      'GAME_ORGANIZER_MUST_CANCEL',
    );
    expect(() =>
      assertCanLeaveGameFacts({ ...facts, viewerRelation: 'PARTICIPANT' }, now),
    ).not.toThrow();
  });
});
