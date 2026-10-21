import { describe, expect, it } from 'vitest';

import {
  createGameCommercialJoinRuntime,
  type GameCommercialJoinOwnerBoundary,
} from './game-commercial-join-runtime.js';
import { createJoinConditionsFixture, fixtureId } from './game-join-conditions.test-fixture.js';

const baseUrl = 'https://owner.example.test';
const config = {
  APP_ENV: 'local' as const,
  GAME_COMMERCIAL_JOIN_ENABLED: true,
  GAME_COMMERCIAL_JOIN_OWNER_BASE_URL: baseUrl,
  GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: 3_000,
};

function rosterRepository() {
  return {
    beginPaidJoin: () => Promise.reject(new Error('must not be called')),
    getPaidJoinAttempt: () => Promise.resolve(null),
    failPaidJoinAttempt: () => Promise.reject(new Error('must not be called')),
  };
}

function boundary(overrides: { readonly admissible?: boolean; readonly mapped?: boolean } = {}) {
  const boundary: GameCommercialJoinOwnerBoundary = {
    delegationIssuer: {
      issueBookedOperationAdmission: () => Promise.resolve('delegation'),
      issueBookedOperationRead: () => Promise.resolve('delegation'),
    },
    actorContextRepository: {
      resolve: () =>
        Promise.resolve({
          outcome: 'ok' as const,
          providerClientId: fixtureId(1),
          providerMappingId: fixtureId(2),
        }),
    },
    targetRepository: {
      resolve: () =>
        Promise.resolve(
          overrides.mapped === false
            ? null
            : {
                providerExerciseId: fixtureId(3),
                targetMappingId: fixtureId(4),
                targetVersion: '1',
                startsAt: new Date(Date.now() + 3_600_000).toISOString(),
                durationMinutes: 90,
                capacity: 4,
                admissible: overrides.admissible ?? true,
              },
        ),
    },
  };
  return boundary;
}

function dependencies(
  overrides: {
    readonly conditionsOwner?: boolean;
    readonly ownerBoundary?: GameCommercialJoinOwnerBoundary | null;
    readonly baseUrl?: string | null;
  } = {},
) {
  const fixture = createJoinConditionsFixture();
  return {
    config: {
      ...config,
      GAME_COMMERCIAL_JOIN_OWNER_BASE_URL:
        overrides.baseUrl === null
          ? undefined
          : (overrides.baseUrl ?? config.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL),
    },
    pool: {} as Parameters<typeof createGameCommercialJoinRuntime>[0]['pool'],
    rosterRepository: rosterRepository(),
    ...(overrides.conditionsOwner === false ? {} : { conditionsOwner: fixture.owner }),
    ...(overrides.ownerBoundary === undefined
      ? { ownerBoundary: boundary() }
      : overrides.ownerBoundary === null
        ? {}
        : { ownerBoundary: overrides.ownerBoundary }),
  };
}

const actor = {
  tenantId: fixtureId(10),
  tenantKey: 'synthetic',
  userId: fixtureId(11),
  sessionId: fixtureId(12),
  gameId: fixtureId(13),
  expectedRevision: 8,
};
const price = {
  amountMinor: 70_000,
  currency: 'RUB' as const,
  basePriceMinor: 70_000,
  freeMinutes: 0,
  paidMinutes: 90,
  evaluatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe('commercial JOIN runtime composition', () => {
  it('stays undefined while the flag is off, so the route keeps GAME_PAYMENT_REQUIRED', () => {
    const runtime = createGameCommercialJoinRuntime({
      ...dependencies(),
      config: { ...config, GAME_COMMERCIAL_JOIN_ENABLED: false },
    });
    expect(runtime).toBeUndefined();
  });

  it('stays undefined without a join-conditions owner', () => {
    expect(
      createGameCommercialJoinRuntime(dependencies({ conditionsOwner: false })),
    ).toBeUndefined();
  });

  it('stays undefined without the existing delegation boundary', () => {
    expect(createGameCommercialJoinRuntime(dependencies({ ownerBoundary: null }))).toBeUndefined();
  });

  it('stays undefined without an owner base url', () => {
    expect(createGameCommercialJoinRuntime(dependencies({ baseUrl: null }))).toBeUndefined();
  });

  it('composes the repository, conditions owner and a fail-closed owner adapter', async () => {
    const runtime = createGameCommercialJoinRuntime(
      dependencies({ ownerBoundary: boundary({ mapped: false }) }),
    );
    expect(runtime).toBeDefined();
    // An unmapped target is not chargeable: definitive rejection, no booking attempt.
    await expect(
      runtime!.owner.execute({
        actor,
        operationId: fixtureId(20),
        idempotencyKey: 'commercial-join-runtime-key-01',
        correlationId: 'correlation-runtime-01',
        subscriptionInstanceId: fixtureId(21),
        price,
      }),
    ).resolves.toEqual({ status: 'REJECTED', code: 'GAME_PAYMENT_REQUIRED' });
  });

  it('rejects a non-admissible target as a service prohibition', async () => {
    const runtime = createGameCommercialJoinRuntime(
      dependencies({ ownerBoundary: boundary({ admissible: false }) }),
    );
    await expect(
      runtime!.owner.execute({
        actor,
        operationId: fixtureId(22),
        idempotencyKey: 'commercial-join-runtime-key-02',
        correlationId: 'correlation-runtime-02',
        subscriptionInstanceId: fixtureId(23),
        price,
      }),
    ).resolves.toEqual({ status: 'REJECTED', code: 'GAME_SERVICE_BLOCKED' });
  });
});
