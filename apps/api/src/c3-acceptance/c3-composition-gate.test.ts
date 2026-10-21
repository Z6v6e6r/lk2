/**
 * C3 independent acceptance tests — commercial JOIN composition gate (P0-1 fix).
 *
 * Verifies the shipped `createGameCommercialJoinRuntime` gate and the owner adapter contract:
 *   - without the flag / join-conditions owner / owner boundary / base URL the runtime is absent,
 *     so the real route keeps the fail-closed GAME_PAYMENT_REQUIRED behaviour;
 *   - with every dependency present the runtime exposes the repository, conditions owner and the
 *     owner port, and construction performs no network call;
 *   - the owner adapter can only report PENDING / UNKNOWN / REJECTED: an owner "CONFIRMED" read
 *     never becomes success and a booking is dispatched at most once per execute.
 *
 * Everything is synthetic and offline (local fetch double). LOCAL evidence only.
 */
import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBookedOperationOwner,
  createGameCommercialJoinRuntime,
  type GameCommercialJoinOwnerBoundary,
} from '../games/game-commercial-join-runtime.js';
import { loadC3Config } from './harness.js';

const UUID = randomUUID();
const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const SESSION_ID = randomUUID();

const actor = {
  tenantId: TENANT_ID,
  tenantKey: 'c3-synthetic-composition',
  userId: USER_ID,
  sessionId: SESSION_ID,
  gameId: UUID,
  expectedRevision: 3,
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadC3Config(),
    APP_ENV: 'ci',
    GAME_COMMERCIAL_JOIN_ENABLED: true,
    GAME_COMMERCIAL_JOIN_OWNER_BASE_URL: 'http://127.0.0.1:59999',
    GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: 1_000,
    ...overrides,
  } as AppConfig;
}

const rosterRepository = {
  async beginPaidJoin(): Promise<never> {
    throw new Error('C3 composition: repository must not be called during construction');
  },
  async getPaidJoinAttempt(): Promise<null> {
    return null;
  },
  async failPaidJoinAttempt(): Promise<void> {},
};

const conditionsOwner = {} as never;

const issueActorToken = async () => ({
  token: `c3-synthetic-actor-token-${randomUUID()}`,
  expiresAt: new Date(Date.now() + 45_000).toISOString(),
});

const completeBoundary = () =>
  boundary({
    resolveProviderClientSubscriptionId: async () => randomUUID(),
  });

function target(overrides: Record<string, unknown> = {}) {
  return {
    providerExerciseId: 'c3-synthetic-exercise',
    targetMappingId: 'c3-synthetic-target-mapping',
    targetVersion: 'v1',
    startsAt: '2026-10-22T15:00:00.000Z',
    durationMinutes: 90,
    capacity: 4,
    admissible: true,
    ...overrides,
  };
}

function boundary(
  overrides: Partial<GameCommercialJoinOwnerBoundary> = {},
): GameCommercialJoinOwnerBoundary {
  return {
    delegationIssuer: {
      async issueBookedOperationAdmission() {
        return 'c3-synthetic-delegation-admission';
      },
      async issueBookedOperationRead() {
        return 'c3-synthetic-delegation-read';
      },
    },
    actorContextRepository: {
      async resolve() {
        return { outcome: 'ok', providerClientId: 'c3-client', providerMappingId: 'c3-mapping' };
      },
    },
    targetRepository: {
      async resolve() {
        return target();
      },
    },
    ...overrides,
  } as GameCommercialJoinOwnerBoundary;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pendingBody(operationId: string) {
  return {
    contractVersion: 1,
    operationId,
    status: 'PENDING',
    reason: 'OWNER_PENDING',
    asOf: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('C3 commercial JOIN composition gate (P0-1)', () => {
  it('P0-GATEa: without the feature flag the runtime is absent (fail-closed)', async () => {
    const runtime = createGameCommercialJoinRuntime({
      config: config({ GAME_COMMERCIAL_JOIN_ENABLED: false }),
      pool: {} as Pool,
      rosterRepository: rosterRepository as never,
      conditionsOwner,
      ownerBoundary: boundary(),
    });
    expect(runtime).toBeUndefined();
  });

  it('P0-GATEb: a partial composition is absent instead of a half-wired owner', () => {
    const base = {
      config: config(),
      pool: {} as Pool,
      rosterRepository: rosterRepository as never,
    };
    expect(createGameCommercialJoinRuntime(base)).toBeUndefined();
    expect(createGameCommercialJoinRuntime({ ...base, conditionsOwner })).toBeUndefined();
    expect(createGameCommercialJoinRuntime({ ...base, ownerBoundary: boundary() })).toBeUndefined();
    // Missing actor-token issuer: the owner could never execute, so the runtime must stay absent.
    expect(
      createGameCommercialJoinRuntime({
        ...base,
        conditionsOwner,
        ownerBoundary: completeBoundary(),
      }),
    ).toBeUndefined();
    // Missing provider-subscription resolver: half-composed, same fail-closed rule.
    expect(
      createGameCommercialJoinRuntime({
        ...base,
        conditionsOwner,
        ownerBoundary: boundary(),
        issueActorToken,
      }),
    ).toBeUndefined();
    expect(
      createGameCommercialJoinRuntime({
        ...base,
        config: config({ GAME_COMMERCIAL_JOIN_OWNER_BASE_URL: undefined }),
        conditionsOwner,
        ownerBoundary: completeBoundary(),
        issueActorToken,
      }),
    ).toBeUndefined();
    // Every required dependency present: the runtime exists.
    expect(
      createGameCommercialJoinRuntime({
        ...base,
        conditionsOwner,
        ownerBoundary: completeBoundary(),
        issueActorToken,
      }),
    ).toBeDefined();
  });

  it('P0-GATEc: a complete composition exposes real ports and performs no network call', async () => {
    const fetchDouble = vi.fn();
    vi.stubGlobal('fetch', fetchDouble);
    const runtime = createGameCommercialJoinRuntime({
      config: config(),
      pool: {} as Pool,
      rosterRepository: rosterRepository as never,
      conditionsOwner,
      ownerBoundary: completeBoundary(),
      issueActorToken,
    });
    expect(runtime).toBeDefined();
    expect(runtime?.repository).toBe(rosterRepository);
    expect(runtime?.conditionsOwner).toBe(conditionsOwner);
    expect(typeof runtime?.owner.execute).toBe('function');
    expect(typeof runtime?.owner.read).toBe('function');
    // The pre-dispatch provider-subscription resolution is part of the owner port (C1 c36877f9).
    expect(typeof runtime?.owner.resolveProviderClientSubscriptionId).toBe('function');
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('P0-GATEd: the owner adapter dispatches at most one admission and never reports owner success', async () => {
    const operationId = randomUUID();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(202, pendingBody(operationId));
    });
    const owner = createBookedOperationOwner({
      baseUrl: 'http://127.0.0.1:59999',
      timeoutMs: 1_000,
      environment: 'development',
      boundary: boundary(),
      targetRepository: boundary().targetRepository!,
    });

    const outcome = await owner.execute({
      actor,
      operationId,
      idempotencyKey: 'c3-composition-idempotency-0001',
      correlationId: 'c3-composition-correlation-0001',
      subscriptionInstanceId: randomUUID(),
      price: {
        amountMinor: 90_000,
        currency: 'RUB',
        basePriceMinor: 90_000,
        freeMinutes: 60,
        paidMinutes: 30,
        evaluatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    expect(outcome).toEqual({ status: 'PENDING' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:59999/lk/integrations/v1/booked-operation-admissions',
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Subscription-Actor-Delegation']).toBe('c3-synthetic-delegation-admission');
    expect(headers['X-Correlation-ID']).toBe('c3-composition-correlation-0001');
    const requestBody = JSON.parse(String(calls[0]?.init.body));
    expect(requestBody).toMatchObject({
      action: 'JOIN_GAME',
      paymentIntent: 'USE_SUBSCRIPTION',
      target: { id: actor.gameId, expectedRevision: actor.expectedRevision },
    });

    // Owner "CONFIRMED" readback must stay PENDING for LK2: success only via trusted receipt.
    vi.stubGlobal('fetch', async () =>
      jsonResponse(200, {
        contractVersion: 1,
        operationId,
        status: 'CONFIRMED',
        reason: 'OWNER_BOOKING_CONFIRMED',
        asOf: new Date().toISOString(),
      }),
    );
    expect(
      await owner.read({ actor, operationId, correlationId: 'c3-composition-correlation-0002' }),
    ).toEqual({ status: 'PENDING' });

    // An owner 5xx is UNKNOWN, not FAILED and not success.
    vi.stubGlobal('fetch', async () => jsonResponse(500, {}));
    expect(
      await owner.execute({
        actor,
        operationId,
        idempotencyKey: 'c3-composition-idempotency-0002',
        correlationId: 'c3-composition-correlation-0003',
        subscriptionInstanceId: randomUUID(),
        price: {
          amountMinor: 0,
          currency: 'RUB',
          basePriceMinor: 0,
          freeMinutes: 90,
          paidMinutes: 0,
          evaluatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    ).toEqual({ status: 'UNKNOWN' });
  });

  it('P0-GATEe: an unmapped or inadmissible target is rejected before any owner call', async () => {
    const fetchDouble = vi.fn();
    vi.stubGlobal('fetch', fetchDouble);
    const noTarget = createBookedOperationOwner({
      baseUrl: 'http://127.0.0.1:59999',
      timeoutMs: 1_000,
      environment: 'development',
      boundary: boundary({
        targetRepository: {
          async resolve() {
            return null;
          },
        },
      }),
      targetRepository: {
        async resolve() {
          return null;
        },
      },
    });
    const serviceBlocked = createBookedOperationOwner({
      baseUrl: 'http://127.0.0.1:59999',
      timeoutMs: 1_000,
      environment: 'development',
      boundary: boundary({
        targetRepository: {
          async resolve() {
            return target({ admissible: false });
          },
        },
      }),
      targetRepository: {
        async resolve() {
          return target({ admissible: false });
        },
      },
    });
    const execute = (owner: ReturnType<typeof createBookedOperationOwner>) =>
      owner.execute({
        actor,
        operationId: randomUUID(),
        idempotencyKey: 'c3-composition-idempotency-0003',
        correlationId: 'c3-composition-correlation-0004',
        subscriptionInstanceId: randomUUID(),
        price: {
          amountMinor: 0,
          currency: 'RUB',
          basePriceMinor: 0,
          freeMinutes: 90,
          paidMinutes: 0,
          evaluatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      });
    expect(await execute(noTarget)).toEqual({
      status: 'REJECTED',
      code: 'GAME_PAYMENT_REQUIRED',
    });
    expect(await execute(serviceBlocked)).toEqual({
      status: 'REJECTED',
      code: 'GAME_SERVICE_BLOCKED',
    });
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('P0-GATEf: an unproven actor context keeps the attempt UNKNOWN without a booking', async () => {
    const fetchDouble = vi.fn();
    vi.stubGlobal('fetch', fetchDouble);
    const owner = createBookedOperationOwner({
      baseUrl: 'http://127.0.0.1:59999',
      timeoutMs: 1_000,
      environment: 'development',
      boundary: boundary({
        actorContextRepository: {
          async resolve() {
            return { outcome: 'provider_mapping_unavailable' } as never;
          },
        },
      }),
      targetRepository: boundary().targetRepository!,
    });
    expect(
      await owner.execute({
        actor,
        operationId: randomUUID(),
        idempotencyKey: 'c3-composition-idempotency-0004',
        correlationId: 'c3-composition-correlation-0005',
        subscriptionInstanceId: randomUUID(),
        price: {
          amountMinor: 0,
          currency: 'RUB',
          basePriceMinor: 0,
          freeMinutes: 90,
          paidMinutes: 0,
          evaluatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
    ).toEqual({ status: 'UNKNOWN' });
    expect(fetchDouble).not.toHaveBeenCalled();
  });
});
