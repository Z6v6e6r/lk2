import { describe, expect, it, vi } from 'vitest';
import type { StoredGameCardProjection, UpcomingBookingsProjection } from '@phub/database';
import type { GameCardProjectionInput } from '@phub/games';
import { attachUpcomingRosters } from './upcoming-rosters.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const playerId = '47b10c0e-2d9f-4775-96dc-2941adae4968';
const stationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const courtId = '4eac46e0-3600-4f57-956f-dabf49eaab80';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const secondGameId = '2f674339-c562-4b10-8ec8-5b58d1701ee8';

function snapshot(overrides: Partial<GameCardProjectionInput> = {}): GameCardProjectionInput {
  return {
    id: gameId,
    tenantId,
    revision: 3,
    organizerUserId: userId,
    title: 'Игра в Сколково',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    lifecycleState: 'SCHEDULED',
    startsAt: '2099-08-01T18:00:00.000Z',
    endsAt: '2099-08-01T19:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: { id: stationId, name: 'Падел Сколково', shortAddress: 'Новая, 1' },
    court: { id: courtId, name: 'Корт №3' },
    levelRange: { from: 'C', to: 'B' },
    capacity: 4,
    participants: [
      {
        userId,
        displayName: 'Алексей',
        avatarUrl: null,
        level: 'C',
        role: 'ORGANIZER',
        paymentState: 'NOT_REQUIRED',
      },
      {
        userId: playerId,
        displayName: 'Мария',
        avatarUrl: null,
        level: 'C+',
        role: 'PLAYER',
        paymentState: 'PAID',
      },
    ],
    seatReservations: [],
    waitlist: [],
    waitlistEnabled: true,
    joinCutoffAt: '2099-08-01T17:30:00.000Z',
    priceSummary: { amountMinor: 250_000, currency: 'RUB' },
    ...overrides,
  };
}

function projection(value: GameCardProjectionInput): StoredGameCardProjection {
  return {
    gameId: value.id,
    aggregateRevision: value.revision,
    projectionRevision: value.revision,
    lifecycleState: value.lifecycleState as StoredGameCardProjection['lifecycleState'],
    visibility: value.visibility,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    basePayload: value,
    projectedAt: '2026-07-17T20:00:00.000Z',
  };
}

const now = '2026-07-17T20:00:30.000Z';
const booking: UpcomingBookingsProjection = {
  tenantId,
  userId,
  version: 'v1',
  generatedAt: now,
  staleAt: now,
  updatedAt: now,
  items: [
    {
      id: secondGameId,
      gameId,
      kind: 'game',
      title: 'Игра',
      startsAt: now,
      venue: 'Корт',
      status: 'confirmed',
      route: '/games/' + gameId,
    },
  ],
};
function repository(value = projection(snapshot())) {
  return {
    getCardProjection: vi.fn(),
    listPublicCardProjections: vi.fn(),
    listViewerCardProjections: vi.fn(),
    getCardProjections: vi.fn((tenant: string) =>
      Promise.resolve(new Map(tenant === tenantId ? [[gameId, value]] : [])),
    ),
  };
}
describe('upcoming roster snapshots', () => {
  it('reads duplicate games once and returns participants and capacity from the same snapshot', async () => {
    const repo = repository();
    const result = await attachUpcomingRosters(
      { ...booking, items: [...booking.items, ...booking.items] },
      { repository: repo, now },
    );
    expect(repo.getCardProjections).toHaveBeenCalledExactlyOnceWith(tenantId, [gameId]);
    expect(repo.getCardProjection).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      roster: { state: 'READY', revision: 3, capacity: 4 },
      openSlots: 2,
      participants: [{ displayName: 'Алексей' }, { displayName: 'Мария' }],
    });
    expect(result.items[1]).toEqual(result.items[0]);
    expect(result.version).not.toBe(booking.version);
  });
  it.each(['missing', 'unmapped', 'private-outsider', 'public-outsider', 'other-tenant'] as const)(
    'does not disclose roster for %s',
    async (scenario) => {
      const repo = repository(
        projection(
          snapshot({ visibility: scenario === 'private-outsider' ? 'PRIVATE' : 'PUBLIC' }),
        ),
      );
      const input = {
        ...booking,
        ...(scenario === 'other-tenant' ? { tenantId: stationId } : {}),
        ...(scenario.endsWith('outsider') ? { userId: stationId } : {}),
        items: booking.items.map((item) => {
          const value = { ...item, ...(scenario === 'missing' ? { gameId: stationId } : {}) };
          if (scenario === 'unmapped') delete value.gameId;
          return value;
        }),
      };
      const result = await attachUpcomingRosters(input, { repository: repo, now });
      expect(result.items[0]?.roster?.state).toBe('UNAVAILABLE');
      expect(result.items[0]?.participants).toBeUndefined();
      expect(result.items[0]?.openSlots).toBeUndefined();
    },
  );
  it('labels an old projection stale instead of refreshing its timestamp', async () => {
    const result = await attachUpcomingRosters(booking, {
      repository: repository(),
      now: '2026-07-17T20:02:00.000Z',
    });
    expect(result.items[0]?.roster).toMatchObject({
      state: 'STALE',
      generatedAt: '2026-07-17T20:00:00.000Z',
    });
  });
  it('drops expired roster identities and free seats', async () => {
    const result = await attachUpcomingRosters(booking, {
      repository: repository(),
      now: '2026-07-17T20:06:01.000Z',
    });
    expect(result.items[0]?.roster?.state).toBe('UNAVAILABLE');
    expect(result.items[0]?.participants).toBeUndefined();
    expect(result.items[0]?.openSlots).toBeUndefined();
  });
});
