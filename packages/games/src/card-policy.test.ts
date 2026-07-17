import { describe, expect, it } from 'vitest';

import {
  GameDomainError,
  deriveGameRosterState,
  projectGameCard,
  projectPublicGameCard,
  type GameCardProjectionInput,
  type GameCardProjectionContext,
} from './index.js';

function expectDomainError(action: () => void, code: GameDomainError['code']): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GameDomainError);
  expect((thrown as GameDomainError).code).toBe(code);
}

const IDS = {
  tenant: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  game: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  station: 'ee2eb9ac-fcb5-40d2-a714-97b9ef75a4a0',
  organizer: 'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
  player2: 'a9c106f7-0db8-4e27-b1e0-298829f94730',
  player3: '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
  player4: 'c68f263e-4a54-4472-9254-103e3b332538',
  outsider: '640a3ae4-ef3b-4789-b6a0-2905bca1e523',
  reservation: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
} as const;

const NOW = '2026-08-01T10:00:00+03:00';

function participant(
  userId: string,
  role: 'ORGANIZER' | 'PLAYER' = 'PLAYER',
): GameCardProjectionInput['participants'][number] {
  return {
    userId,
    displayName: role === 'ORGANIZER' ? 'Организатор' : 'Игрок',
    role,
    paymentState: 'PAID',
  };
}

function game(overrides: Partial<GameCardProjectionInput> = {}): GameCardProjectionInput {
  return {
    id: IDS.game,
    tenantId: IDS.tenant,
    revision: 7,
    organizerUserId: IDS.organizer,
    title: 'Игра в Селигерской',
    kind: 'RATING',
    visibility: 'PUBLIC',
    lifecycleState: 'SCHEDULED',
    startsAt: '2026-08-01T18:00:00+03:00',
    endsAt: '2026-08-01T19:30:00+03:00',
    timezone: 'Europe/Moscow',
    station: {
      id: IDS.station,
      name: 'Селигерская',
      shortAddress: 'Москва',
    },
    levelRange: { from: 'C', to: 'B' },
    capacity: 4,
    participants: [participant(IDS.organizer, 'ORGANIZER')],
    seatReservations: [],
    waitlist: [],
    waitlistEnabled: true,
    joinCutoffAt: '2026-08-01T17:30:00+03:00',
    priceSummary: { amountMinor: 250_000, currency: 'RUB' },
    ...overrides,
  };
}

function cardContext(
  overrides: Partial<GameCardProjectionContext> = {},
): GameCardProjectionContext {
  return { surface: 'DISCOVER', now: NOW, ...overrides };
}

describe('GameCard display policy', () => {
  it('shows finding players when more than one place is open', () => {
    const card = projectGameCard(game(), cardContext());
    expect(card).toMatchObject({
      displayState: 'FINDING_PLAYERS',
      rosterState: 'OPEN',
      capacity: { total: 4, occupied: 1, reserved: 0, open: 3 },
      viewerRelation: 'ANONYMOUS',
    });
    expect(card.allowedActions).toEqual(['OPEN_DETAILS', 'JOIN']);
  });

  it('shows one remaining place', () => {
    const card = projectGameCard(
      game({
        participants: [
          participant(IDS.organizer, 'ORGANIZER'),
          participant(IDS.player2),
          participant(IDS.player3),
        ],
      }),
      cardContext(),
    );
    expect(card.displayState).toBe('ONE_SPOT_LEFT');
    expect(card.rosterState).toBe('LAST_SPOT');
  });

  it('shows a ready roster and waitlist action when full', () => {
    const card = projectGameCard(
      game({
        participants: [
          participant(IDS.organizer, 'ORGANIZER'),
          participant(IDS.player2),
          participant(IDS.player3),
          participant(IDS.player4),
        ],
      }),
      cardContext(),
    );
    expect(card).toMatchObject({ displayState: 'ROSTER_READY', rosterState: 'WAITLIST_ONLY' });
    expect(card.allowedActions).toEqual(['OPEN_DETAILS', 'JOIN_WAITLIST']);
  });

  it('gives viewer payment precedence over the roster state', () => {
    const card = projectGameCard(
      game({
        seatReservations: [
          {
            id: IDS.reservation,
            userId: IDS.outsider,
            expiresAt: '2026-08-01T10:15:00+03:00',
            paymentState: 'REQUIRES_ACTION',
          },
        ],
      }),
      cardContext({ viewerUserId: IDS.outsider }),
    );
    expect(card).toMatchObject({
      displayState: 'SEAT_PAYMENT_REQUIRED',
      viewerRelation: 'SEAT_RESERVED',
      viewerPaymentState: 'REQUIRES_ACTION',
      capacity: { occupied: 1, reserved: 1, open: 2 },
    });
    expect(card.allowedActions).toEqual(['OPEN_DETAILS', 'PAY']);
  });

  it('does not count an expired seat reservation against capacity', () => {
    const input = game({
      seatReservations: [
        {
          id: IDS.reservation,
          userId: IDS.outsider,
          expiresAt: '2026-08-01T09:59:59+03:00',
          paymentState: 'REQUIRES_ACTION',
        },
      ],
    });
    const card = projectGameCard(input, cardContext({ viewerUserId: IDS.outsider }));
    expect(card.capacity).toMatchObject({ occupied: 1, reserved: 0, open: 3 });
    expect(card.viewerRelation).toBe('NONE');
  });

  it('shows starting soon using server policy time', () => {
    const card = projectGameCard(
      game({ startsAt: '2026-08-01T11:00:00+03:00', endsAt: '2026-08-01T12:30:00+03:00' }),
      cardContext({ startingSoonMinutes: 90 }),
    );
    expect(card.displayState).toBe('STARTING_SOON');
  });

  it('does not call an underfilled game ready after registration closes', () => {
    const card = projectGameCard(
      game({ joinCutoffAt: '2026-08-01T09:00:00+03:00' }),
      cardContext(),
    );
    expect(card).toMatchObject({
      displayState: 'REGISTRATION_CLOSED',
      rosterState: 'LOCKED',
      capacity: { occupied: 1, open: 3 },
    });
    expect(card.allowedActions).toEqual(['OPEN_DETAILS']);
  });

  it('lets a waitlisted viewer leave the waitlist', () => {
    const card = projectGameCard(
      game({ waitlist: [{ userId: IDS.outsider, position: 1 }] }),
      cardContext({ viewerUserId: IDS.outsider }),
    );
    expect(card.viewerRelation).toBe('WAITLISTED');
    expect(card.allowedActions).toEqual(['OPEN_DETAILS', 'LEAVE_WAITLIST']);
  });

  it('shows in progress independently from roster data', () => {
    const card = projectGameCard(
      game({ lifecycleState: 'IN_PROGRESS' }),
      cardContext({ viewerUserId: IDS.player2 }),
    );
    expect(card.displayState).toBe('IN_PROGRESS');
    expect(card.rosterState).toBe('LOCKED');
  });

  it('shows result required only to a game participant', () => {
    const finished = game({
      lifecycleState: 'FINISHED',
      participants: [participant(IDS.organizer, 'ORGANIZER'), participant(IDS.player2)],
      result: {
        state: 'AWAITING_SUBMISSION',
        requiredConfirmationUserIds: [],
        confirmedByUserIds: [],
      },
    });
    expect(
      projectGameCard(finished, cardContext({ surface: 'HISTORY', viewerUserId: IDS.player2 }))
        .displayState,
    ).toBe('RESULT_REQUIRED');
    expect(projectGameCard(finished, cardContext({ surface: 'HISTORY' })).displayState).toBe(
      'COMPLETED',
    );
  });

  it('offers result confirmation only to an eligible non-submitting player', () => {
    const input = game({
      lifecycleState: 'FINISHED',
      participants: [participant(IDS.organizer, 'ORGANIZER'), participant(IDS.player2)],
      result: {
        state: 'PENDING_CONFIRMATION',
        submittedByUserId: IDS.organizer,
        requiredConfirmationUserIds: [IDS.player2],
        confirmedByUserIds: [],
        sets: [{ teamA: 6, teamB: 4 }],
      },
    });
    const playerCard = projectGameCard(
      input,
      cardContext({ surface: 'HISTORY', viewerUserId: IDS.player2 }),
    );
    expect(playerCard.displayState).toBe('RESULT_PENDING');
    expect(playerCard.allowedActions).toContain('CONFIRM_RESULT');
    expect(playerCard.allowedActions).toContain('DISPUTE_RESULT');

    const submitterCard = projectGameCard(
      input,
      cardContext({ surface: 'HISTORY', viewerUserId: IDS.organizer }),
    );
    expect(submitterCard.allowedActions).not.toContain('CONFIRM_RESULT');
  });

  it('shows disputed, completed and cancelled terminal presentations', () => {
    expect(
      projectGameCard(
        game({
          lifecycleState: 'FINISHED',
          result: {
            state: 'DISPUTED',
            submittedByUserId: IDS.organizer,
            requiredConfirmationUserIds: [],
            confirmedByUserIds: [],
            sets: [{ teamA: 6, teamB: 4 }],
          },
        }),
        cardContext({ surface: 'HISTORY' }),
      ).displayState,
    ).toBe('RESULT_DISPUTED');
    expect(
      projectGameCard(
        game({
          lifecycleState: 'FINISHED',
          result: {
            state: 'CONFIRMED',
            submittedByUserId: IDS.organizer,
            requiredConfirmationUserIds: [],
            confirmedByUserIds: [],
            sets: [{ teamA: 6, teamB: 4 }],
          },
        }),
        cardContext({ surface: 'HISTORY' }),
      ).displayState,
    ).toBe('COMPLETED');
    expect(projectGameCard(game({ lifecycleState: 'CANCELLED' }), cardContext()).displayState).toBe(
      'CANCELLED',
    );
  });

  it('keeps draft and provisioning games outside the card projection', () => {
    for (const lifecycleState of ['DRAFT', 'PROVISIONING'] as const) {
      expectDomainError(
        () => projectGameCard(game({ lifecycleState }), cardContext()),
        'GAME_NOT_CARD_VISIBLE',
      );
    }
  });
});

describe('public game card', () => {
  it('strips stable user IDs while preserving safe presentation data', () => {
    const card = projectPublicGameCard(game(), cardContext());
    expect(card.viewerRelation).toBe('ANONYMOUS');
    expect(card.participants[0]).toEqual({
      displayName: 'Организатор',
      avatarUrl: null,
      level: null,
      role: 'ORGANIZER',
    });
    expect(JSON.stringify(card)).not.toContain(IDS.organizer);
    expect(JSON.stringify(card)).not.toMatch(/phone|bookingId|paymentUrl|viva/i);
  });

  it('rejects authenticated-only surfaces', () => {
    expectDomainError(
      () => projectPublicGameCard(game(), { surface: 'MY_UPCOMING', now: NOW }),
      'GAME_SNAPSHOT_INVALID',
    );
  });

  it('rejects private and non-scheduled games from public discovery', () => {
    expectDomainError(
      () => projectPublicGameCard(game({ visibility: 'PRIVATE' }), cardContext()),
      'GAME_NOT_CARD_VISIBLE',
    );
    expectDomainError(
      () => projectPublicGameCard(game({ lifecycleState: 'IN_PROGRESS' }), cardContext()),
      'GAME_NOT_CARD_VISIBLE',
    );
  });
});

describe('card input invariants', () => {
  it('requires one matching organizer participant for active games', () => {
    expectDomainError(
      () => projectGameCard(game({ participants: [] }), cardContext()),
      'GAME_SNAPSHOT_INVALID',
    );
    expectDomainError(
      () =>
        projectGameCard(
          game({ participants: [participant(IDS.organizer, 'PLAYER')] }),
          cardContext(),
        ),
      'GAME_SNAPSHOT_INVALID',
    );
  });

  it('rejects duplicate user roster states', () => {
    const duplicate = game({
      seatReservations: [
        {
          id: IDS.reservation,
          userId: IDS.organizer,
          expiresAt: '2026-08-01T10:15:00+03:00',
          paymentState: 'REQUIRES_ACTION',
        },
      ],
    });
    expectDomainError(() => projectGameCard(duplicate, cardContext()), 'GAME_SNAPSHOT_INVALID');
  });

  it('rejects over-capacity confirmed and reserved seats', () => {
    const overCapacity = game({
      capacity: 2,
      participants: [participant(IDS.organizer, 'ORGANIZER'), participant(IDS.player2)],
      seatReservations: [
        {
          id: IDS.reservation,
          userId: IDS.player3,
          expiresAt: '2026-08-01T10:15:00+03:00',
          paymentState: 'PROCESSING',
        },
      ],
    });
    expectDomainError(
      () => deriveGameRosterState(overCapacity, NOW),
      'GAME_CAPACITY_INVARIANT_VIOLATION',
    );
  });

  it('rejects active reservations outside a scheduled game', () => {
    expectDomainError(
      () =>
        projectGameCard(
          game({
            lifecycleState: 'IN_PROGRESS',
            seatReservations: [
              {
                id: IDS.reservation,
                userId: IDS.outsider,
                expiresAt: '2026-08-01T20:00:00+03:00',
                paymentState: 'PROCESSING',
              },
            ],
          }),
          cardContext(),
        ),
      'GAME_SNAPSHOT_INVALID',
    );
  });

  it('rejects incomplete or contradictory result facts', () => {
    expectDomainError(
      () =>
        projectGameCard(
          game({
            lifecycleState: 'FINISHED',
            result: {
              state: 'NOT_AVAILABLE',
              requiredConfirmationUserIds: [],
              confirmedByUserIds: [],
            },
          }),
          cardContext({ surface: 'HISTORY' }),
        ),
      'GAME_SNAPSHOT_INVALID',
    );
    expectDomainError(
      () =>
        projectGameCard(
          game({
            lifecycleState: 'FINISHED',
            result: {
              state: 'CONFIRMED',
              requiredConfirmationUserIds: [],
              confirmedByUserIds: [],
            },
          }),
          cardContext({ surface: 'HISTORY' }),
        ),
      'GAME_SNAPSHOT_INVALID',
    );
  });
});
