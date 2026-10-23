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
    confirmPayment: () => Promise.reject(new Error('not expected')),
    beginPaidJoin: () => Promise.reject(new Error('must not be called')),
    getPaidJoinAttempt: () => Promise.resolve(null),
    failPaidJoinAttempt: () => Promise.reject(new Error('must not be called')),
  };
}

function boundary(
  overrides: {
    readonly admissible?: boolean;
    readonly mapped?: boolean;
    readonly providerSubscriptionId?: string | undefined;
    readonly issued?: unknown[];
  } = {},
) {
  const boundary: GameCommercialJoinOwnerBoundary = {
    delegationIssuer: {
      issueBookedOperationAdmission: (input) => {
        overrides.issued?.push(input);
        return Promise.resolve('delegation');
      },
      issueBookedOperationRead: () => Promise.resolve('delegation'),
    },
    resolveProviderClientSubscriptionId: () =>
      Promise.resolve(
        'providerSubscriptionId' in overrides ? overrides.providerSubscriptionId : fixtureId(40),
      ),
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
    readonly issueActorToken?: (actor: {
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly userId: string;
      readonly sessionId: string;
      readonly correlationId: string;
    }) => Promise<{ token: string; expiresAt: string }>;
  } = {},
) {
  const fixture = createJoinConditionsFixture();
  return {
    issueActorToken:
      overrides.issueActorToken ??
      (() =>
        Promise.resolve({
          token: ACTOR_TOKEN,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        })),
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

const ACTOR_TOKEN = ['synthetic', 'actor', 'token', 'value'].join('-');

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

  it('stays undefined without a user-scoped token issuer', () => {
    const fixture = createJoinConditionsFixture();
    const runtime = createGameCommercialJoinRuntime({
      config,
      pool: {} as Parameters<typeof createGameCommercialJoinRuntime>[0]['pool'],
      rosterRepository: rosterRepository(),
      conditionsOwner: fixture.owner,
      ownerBoundary: boundary(),
    });
    expect(runtime).toBeUndefined();
  });

  it('stays undefined without a provider subscription resolver', () => {
    const fixture = createJoinConditionsFixture();
    const runtime = createGameCommercialJoinRuntime({
      config,
      pool: {} as Parameters<typeof createGameCommercialJoinRuntime>[0]['pool'],
      rosterRepository: rosterRepository(),
      conditionsOwner: fixture.owner,
      ownerBoundary: {
        delegationIssuer: {
          issueBookedOperationAdmission: () => Promise.resolve('delegation'),
          issueBookedOperationRead: () => Promise.resolve('delegation'),
        },
        actorContextRepository: boundary().actorContextRepository,
        ...(boundary().targetRepository ? { targetRepository: boundary().targetRepository } : {}),
      },
      issueActorToken: () =>
        Promise.resolve({
          token: ACTOR_TOKEN,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
    });
    expect(runtime).toBeUndefined();
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

  it('binds a user-scoped actor token to the admission envelope and never leaks it', async () => {
    const calls: Array<{ readonly token?: string; readonly sha256?: string }> = [];
    const issued: unknown[] = [];
    const runtime = createGameCommercialJoinRuntime(
      dependencies({
        ownerBoundary: {
          ...boundary({ issued }),
          admissionTransport: {
            admit: (_request, envelope) => {
              calls.push({
                ...(envelope.actorToken ? { token: envelope.actorToken.token } : {}),
                ...(envelope.actorTokenSha256 ? { sha256: envelope.actorTokenSha256 } : {}),
              });
              return Promise.resolve({
                contractVersion: 1,
                operationId: fixtureId(30),
                status: 'PENDING',
                asOf: new Date().toISOString(),
                reason: 'OWNER_PENDING',
              });
            },
          },
        },
        issueActorToken: () =>
          Promise.resolve({
            token: ACTOR_TOKEN,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          }),
      }),
    );
    const outcome = await runtime!.owner.execute({
      actor,
      operationId: fixtureId(30),
      idempotencyKey: 'commercial-join-runtime-key-03',
      correlationId: 'correlation-runtime-03',
      subscriptionInstanceId: fixtureId(31),
      price,
    });
    expect(outcome).toEqual({ status: 'PENDING' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(ACTOR_TOKEN);
    expect(calls[0]?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(outcome)).not.toContain(ACTOR_TOKEN);
    // The signed delegation binds the same token and the server-resolved provider subscription.
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      actorToken: { token: ACTOR_TOKEN },
      providerClientSubscriptionId: fixtureId(40),
    });
  });

  it('refuses to dispatch when the selected product has no provider subscription mapping', async () => {
    const calls: string[] = [];
    const runtime = createGameCommercialJoinRuntime(
      dependencies({
        ownerBoundary: {
          ...boundary({ providerSubscriptionId: undefined }),
          admissionTransport: {
            admit: () => {
              calls.push('admit');
              return Promise.resolve({
                contractVersion: 1,
                operationId: fixtureId(41),
                status: 'PENDING',
                asOf: new Date().toISOString(),
                reason: 'OWNER_PENDING',
              });
            },
          },
        },
        issueActorToken: () =>
          Promise.resolve({
            token: ACTOR_TOKEN,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          }),
      }),
    );
    const outcome = await runtime!.owner.execute({
      actor,
      operationId: fixtureId(41),
      idempotencyKey: 'commercial-join-runtime-key-05',
      correlationId: 'correlation-runtime-05',
      subscriptionInstanceId: fixtureId(42),
      price,
    });
    expect(outcome).toEqual({
      status: 'REJECTED',
      code: 'GAME_SUBSCRIPTION_SELECTION_REQUIRED',
    });
    expect(calls).toEqual([]);
  });

  it('treats an unavailable actor token as unresolved and dispatches nothing', async () => {
    const calls: string[] = [];
    const runtime = createGameCommercialJoinRuntime(
      dependencies({
        ownerBoundary: {
          ...boundary(),
          admissionTransport: {
            admit: () => {
              calls.push('admit');
              return Promise.resolve({
                contractVersion: 1,
                operationId: fixtureId(32),
                status: 'PENDING',
                asOf: new Date().toISOString(),
                reason: 'OWNER_PENDING',
              });
            },
          },
        },
        issueActorToken: () => Promise.reject(new Error('oauth contour unavailable')),
      }),
    );
    const outcome = await runtime!.owner.execute({
      actor,
      operationId: fixtureId(32),
      idempotencyKey: 'commercial-join-runtime-key-04',
      correlationId: 'correlation-runtime-04',
      subscriptionInstanceId: fixtureId(33),
      price,
    });
    expect(outcome).toEqual({ status: 'UNKNOWN' });
    expect(calls).toEqual([]);
  });
});
