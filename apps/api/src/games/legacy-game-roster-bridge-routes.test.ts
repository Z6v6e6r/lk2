import type { GameRosterRepository, LegacyGameRosterBridgeRepository } from '@phub/database';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLegacyGameRosterBridgeRoutes } from './legacy-game-roster-bridge-routes.js';
import type { LegacyLkIdentityVerifier } from './legacy-lk-identity-verifier.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const commandId = 'd39e4287-e65c-4e75-88e4-4447e4c91ddb';
const bridgeToken = 'legacy-bridge-token-at-least-32-characters';
const apps: FastifyInstance[] = [];

const verifyIdentity = vi.fn().mockResolvedValue({
  issuer: 'https://kc.vivacrm.ru/realms/clients',
  subject: 'signed-subject',
  phoneNorm: '79000000001',
  tenantKey: 'local-padel',
  authorizedParty: 'widget',
});
const identityVerifier: LegacyLkIdentityVerifier = {
  verify: verifyIdentity,
};

function contextRepository(
  outcome: Awaited<ReturnType<LegacyGameRosterBridgeRepository['resolve']>> = {
    outcome: 'resolved',
    context: {
      tenantId,
      userId,
      gameId,
      gameRevision: 4,
      player: {
        userId,
        displayName: 'Анна Игрокова',
        phoneE164: '+79000000001',
        levelLabel: 'C+',
        levelValue: 3.63,
      },
    },
  },
): LegacyGameRosterBridgeRepository {
  return { resolve: vi.fn().mockResolvedValue(outcome) };
}

function rosterRepository(
  joinResult: Awaited<ReturnType<GameRosterRepository['join']>> = {
    outcome: 'applied',
    commandId,
    gameId,
    revision: 5,
    viewerRelation: 'PARTICIPANT',
    participationId: '05d8cc21-9ab9-4ec2-a966-cb52ef13dd29',
    committedAt: '2026-08-16T18:00:00.000Z',
    replayed: false,
  },
): Pick<GameRosterRepository, 'join' | 'joinWaitlist' | 'confirmPayment'> {
  return {
    join: vi.fn().mockResolvedValue(joinResult),
    joinWaitlist: vi.fn().mockResolvedValue(joinResult),
    confirmPayment: vi.fn().mockResolvedValue(joinResult),
  };
}

async function appWith(input: {
  readonly context?: LegacyGameRosterBridgeRepository;
  readonly roster?: Pick<GameRosterRepository, 'join' | 'joinWaitlist' | 'confirmPayment'>;
}) {
  const app = Fastify();
  registerLegacyGameRosterBridgeRoutes(app, {
    enabled: true,
    integrationToken: bridgeToken,
    identityVerifier,
    contextRepository: input.context ?? contextRepository(),
    rosterRepository: input.roster ?? rosterRepository(),
    commandHandlers: [
      (request) => {
        request.tenantId = tenantId;
        return Promise.resolve();
      },
    ],
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('legacy game roster bridge routes', () => {
  it('derives actor and canonical game server-side before the final roster command', async () => {
    const context = contextRepository();
    const roster = rosterRepository();
    const resolveContext = vi.fn(context.resolve.bind(context));
    const joinRoster = vi.fn(roster.join.bind(roster));
    const instrumentedContext: LegacyGameRosterBridgeRepository = { resolve: resolveContext };
    const instrumentedRoster: Pick<
      GameRosterRepository,
      'join' | 'joinWaitlist' | 'confirmPayment'
    > = {
      join: joinRoster,
      joinWaitlist: roster.joinWaitlist.bind(roster),
      confirmPayment: roster.confirmPayment.bind(roster),
    };
    const app = await appWith({ context: instrumentedContext, roster: instrumentedRoster });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-join-command-1',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: { command: 'JOIN_GAME' },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyIdentity).toHaveBeenCalledWith('Bearer signed-legacy-jwt');
    expect(resolveContext).toHaveBeenCalledWith({
      tenantId,
      issuer: 'https://kc.vivacrm.ru/realms/clients',
      subject: 'signed-subject',
      externalGameId: 'pay_legacy-game',
    });
    expect(joinRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        gameId,
        expectedRevision: 4,
        idempotencyKey: 'legacy-join-command-1',
      }),
    );
    expect(response.json()).toEqual({
      commandId,
      replayed: false,
      projection: {
        legacyGameId: 'pay_legacy-game',
        canonicalGameId: gameId,
        aggregateRevision: 5,
        relation: 'PARTICIPANT',
        player: {
          userId,
          displayName: 'Анна Игрокова',
          phoneE164: '+79000000001',
          levelLabel: 'C+',
          levelValue: 3.63,
        },
      },
    });
  });

  it('rejects client-owned identity, level and roster fields', async () => {
    const app = await appWith({});
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-join-command-2',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: {
        command: 'JOIN_GAME',
        playerId: userId,
        level: 'A',
        skipLevelCheck: true,
        participants: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'LEGACY_GAME_COMMAND_INVALID' });
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('fails closed for an unlinked actor or a denied level decision', async () => {
    const unlinked = await appWith({ context: contextRepository({ outcome: 'actor_not_linked' }) });
    const headers = {
      authorization: 'Bearer signed-legacy-jwt',
      'idempotency-key': 'legacy-join-command-3',
      'x-phub-legacy-roster-token': bridgeToken,
    };
    const unlinkedResponse = await unlinked.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers,
      payload: { command: 'JOIN_GAME' },
    });
    expect(unlinkedResponse.statusCode).toBe(409);
    expect(unlinkedResponse.json()).toMatchObject({ code: 'LEGACY_ACTOR_NOT_LINKED' });

    const denied = await appWith({
      roster: rosterRepository({
        outcome: 'rejected',
        code: 'LEVEL_NOT_ALLOWED',
        replayed: false,
      }),
    });
    const deniedResponse = await denied.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: { ...headers, 'idempotency-key': 'legacy-join-command-4' },
      payload: { command: 'JOIN_GAME' },
    });
    expect(deniedResponse.statusCode).toBe(409);
    expect(deniedResponse.json()).toMatchObject({ code: 'LEVEL_NOT_ALLOWED' });
  });

  it('accepts payment confirmation only through strict server evidence and verified identity', async () => {
    const roster = rosterRepository({
      outcome: 'applied',
      commandId,
      gameId,
      revision: 6,
      viewerRelation: 'PARTICIPANT',
      participationId: '05d8cc21-9ab9-4ec2-a966-cb52ef13dd29',
      reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
      committedAt: '2026-08-16T18:00:00.000Z',
      replayed: false,
    });
    const confirmPayment = vi.fn(roster.confirmPayment.bind(roster));
    const app = await appWith({ roster: { ...roster, confirmPayment } });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-payment-confirmation-1',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: {
        command: 'CONFIRM_PAYMENT',
        reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-101',
          bookingId: 'viva-booking-101',
          exerciseId: 'viva-exercise-101',
          clientPhoneE164: '+79000000001',
          status: 'CONFIRMED',
          verifiedAt: '2026-08-16T17:59:59.000Z',
          amountMinor: 250000,
          currency: 'RUB',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projection: {
        relation: 'PARTICIPANT',
        reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
      },
    });
    const confirmation = confirmPayment.mock.calls[0]?.[0];
    expect(confirmation).toMatchObject({
      tenantId,
      actorUserId: userId,
      gameId,
      reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
      evidence: {
        provider: 'VIVA',
        operationType: 'TRANSACTION',
        operationId: 'viva-transaction-101',
        bookingId: 'viva-booking-101',
        exerciseId: 'viva-exercise-101',
        clientPhoneE164: '+79000000001',
        verifiedBy: 'LEGACY_NODE_RED',
      },
    });
    expect(confirmation?.evidence.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects browser-owned paid flags without trusted provider evidence', async () => {
    const roster = rosterRepository();
    const app = await appWith({ roster });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-payment-confirmation-2',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: {
        command: 'CONFIRM_PAYMENT',
        reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
        paid: true,
        transactionId: 'forged-browser-transaction',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'LEGACY_GAME_COMMAND_INVALID' });
    expect(roster.confirmPayment).not.toHaveBeenCalled();
  });

  it('accepts legacy evidence without exercise binding during the expand phase', async () => {
    const roster = rosterRepository();
    const confirmPayment = vi.fn(roster.confirmPayment.bind(roster));
    const app = await appWith({ roster: { ...roster, confirmPayment } });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-payment-confirmation-missing-exercise',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: {
        command: 'CONFIRM_PAYMENT',
        reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-101',
          bookingId: 'viva-booking-101',
          clientPhoneE164: '+79000000001',
          status: 'CONFIRMED',
          verifiedAt: '2026-08-16T17:59:59.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(confirmPayment).toHaveBeenCalledOnce();
    expect(confirmPayment.mock.calls[0]?.[0].evidence.exerciseId).toBeUndefined();
  });

  it('rejects provider evidence for a different profile phone', async () => {
    const roster = rosterRepository();
    const app = await appWith({ roster });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/api/v1/local-padel/legacy-games/pay_legacy-game/roster-commands',
      headers: {
        authorization: 'Bearer signed-legacy-jwt',
        'idempotency-key': 'legacy-payment-confirmation-3',
        'x-phub-legacy-roster-token': bridgeToken,
      },
      payload: {
        command: 'CONFIRM_PAYMENT',
        reservationId: '238df6f5-fec4-44dd-ad8c-39e98ade8366',
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-102',
          bookingId: 'viva-booking-102',
          exerciseId: 'viva-exercise-102',
          clientPhoneE164: '+79000000099',
          status: 'CONFIRMED',
          verifiedAt: '2026-08-16T17:59:59.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'GAME_PAYMENT_ACTOR_MISMATCH' });
    expect(roster.confirmPayment).not.toHaveBeenCalled();
  });
});
