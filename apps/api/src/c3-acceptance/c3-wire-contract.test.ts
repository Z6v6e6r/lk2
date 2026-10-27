/**
 * C3 independent acceptance tests — commercial JOIN wire contract (actor token + provider
 * subscription mapping), LK2 head `9dd937e7`.
 *
 * This is new since the previous C3 matrix and is deliberately independent of C1's unit tests:
 *   - the app is composed through the shipped `createGameCommercialJoinRuntime` factory (not a
 *     hand-assembled options object), so the real HTTP route runs the production composition;
 *   - the delegation issuer, the admission transport, the actor-token issuer and the
 *     provider-subscription resolver are countable doubles; one case replaces the delegation
 *     issuer and transport with the REAL adapter so the actual wire names are asserted
 *     (`X-Subscription-Actor-Token`, `sha256:<64hex>` binding, `actor_token_expires_at`,
 *     `provider_client_subscription_id`);
 *   - negatives prove the fail-closed branches create no reservation/snapshot/command row;
 *   - the token value and the provider client subscription id must appear in neither the HTTP
 *     response bodies nor the PostgreSQL rows read here.
 *
 * Everything is synthetic: an isolated local PostgreSQL, backend doubles, no provider traffic.
 * Evidence level: LOCAL only.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import {
  createGameRosterRepository,
  withTenantTransaction,
  type GameRosterRepository,
} from '@phub/database';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createGameCommercialJoinRuntime,
  type BookedOperationAdmissionTransport,
  type CommercialJoinActorToken,
  type GameCommercialJoinOwnerBoundary,
  type GameCommercialJoinRuntimeOptions,
} from '../games/game-commercial-join-runtime.js';
import type { GameJoinConditionsOwner } from '../games/game-join-conditions.js';
import { SubscriptionRuntimeActorDelegationIssuer } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import {
  buildC3App,
  c3AccessToken,
  c3DatabaseDescribe,
  c3Headers,
  c3IdempotencyKey,
  createC3Pool,
  createConditionsDouble,
  createOwnerDouble,
  loadC3Config,
  readCommandRows,
  readReservations,
  readSavedState,
  seedSyntheticGame,
  seedSyntheticTenant,
  C3_FIXTURE_VERSION,
  type C3App,
  type SeededGame,
  type SyntheticTenant,
} from './harness.js';

const OWNER_BASE_URL = 'http://127.0.0.1:59999';
const SYNTHETIC_BASE_PRICE_MINOR = 150_000; // SYNTHETIC fixture, not a live tariff
const SYNTHETIC_PROVIDER_CLIENT_ID = 'c3-synthetic-provider-client';
const ACTOR_TOKEN_PATTERN = /^sha256:[0-9a-f]{64}$/;

const headersPattern = /^[!-~]{1,4096}$/;

function wireConfig(): AppConfig {
  return {
    ...loadC3Config(),
    APP_ENV: 'ci',
    GAME_COMMERCIAL_JOIN_ENABLED: true,
    GAME_COMMERCIAL_JOIN_OWNER_BASE_URL: OWNER_BASE_URL,
    GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: 1_000,
  } as AppConfig;
}

function actorTokenSha256(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

type DelegationIssuerPort = Pick<
  SubscriptionRuntimeActorDelegationIssuer,
  'issueBookedOperationAdmission' | 'issueBookedOperationRead'
>;
type AdmissionInput = Parameters<DelegationIssuerPort['issueBookedOperationAdmission']>[0];
type ReadInput = Parameters<DelegationIssuerPort['issueBookedOperationRead']>[0];
type TransportCall = Parameters<BookedOperationAdmissionTransport['admit']>;
type ActorTokenInput = Parameters<
  NonNullable<GameCommercialJoinRuntimeOptions['issueActorToken']>
>[0];
type ResolverInput = Parameters<
  NonNullable<GameCommercialJoinOwnerBoundary['resolveProviderClientSubscriptionId']>
>[0];

interface WireIssuerDouble {
  readonly port: DelegationIssuerPort;
  readonly admissionInputs: AdmissionInput[];
  readonly readInputs: ReadInput[];
}

/**
 * Captures the exact delegation input the runtime hands to the issuer. This is what the real
 * issuer would bind into the signed claims; capturing it keeps the assertion independent of C1's
 * own issuer tests.
 */
function createWireIssuerDouble(): WireIssuerDouble {
  const admissionInputs: AdmissionInput[] = [];
  const readInputs: ReadInput[] = [];
  return {
    port: {
      async issueBookedOperationAdmission(input) {
        admissionInputs.push(input);
        return 'c3-synthetic-delegation-admission-v1';
      },
      async issueBookedOperationRead(input) {
        readInputs.push(input);
        return 'c3-synthetic-delegation-read-v1';
      },
    },
    admissionInputs,
    readInputs,
  };
}

interface WireTransportDouble {
  readonly port: BookedOperationAdmissionTransport;
  readonly calls: TransportCall[];
}

/** Captures the admission envelope; defaults to the owner's PENDING answer. */
function createWireTransportDouble(): WireTransportDouble {
  const calls: TransportCall[] = [];
  return {
    port: {
      async admit(request, envelope) {
        calls.push([request, envelope]);
        return {
          contractVersion: 1,
          operationId: envelope.operationId,
          status: 'PENDING',
          reason: 'OWNER_PENDING',
          asOf: new Date().toISOString(),
        };
      },
    },
    calls,
  };
}

interface WireComposition {
  readonly runtime: NonNullable<ReturnType<typeof createGameCommercialJoinRuntime>>;
  /** Server-verified target mapping id the owner binding froze before the reservation. */
  readonly targetMappingId: string;
  readonly issuedToken: CommercialJoinActorToken;
  readonly providerSubscriptionId: string;
  readonly actorTokenInputs: ActorTokenInput[];
  readonly resolverInputs: ResolverInput[];
  readonly issuerDouble: WireIssuerDouble;
  readonly transportDouble: WireTransportDouble | undefined;
}

/**
 * Builds the production composition (`createGameCommercialJoinRuntime`) over the real roster
 * repository with the wire-level doubles above.
 */
function composeWireRuntime(input: {
  readonly pool: Pool;
  readonly rosterRepository: GameRosterRepository;
  readonly conditionsOwner: GameJoinConditionsOwner;
  readonly startsAt: string;
  readonly mapped?: boolean;
  readonly tokenUnavailable?: boolean;
  readonly useTransportDouble?: boolean;
  readonly issuer?: DelegationIssuerPort;
}): WireComposition {
  const providerSubscriptionId = randomUUID();
  const issuedToken: CommercialJoinActorToken = {
    token: `c3-synthetic-actor-token-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  };
  const actorTokenInputs: ActorTokenInput[] = [];
  const resolverInputs: ResolverInput[] = [];
  const issuerDouble = createWireIssuerDouble();
  const transportDouble =
    input.useTransportDouble === false ? undefined : createWireTransportDouble();
  const targetMappingId = randomUUID();
  const providerMappingId = randomUUID();

  const ownerBoundary: GameCommercialJoinOwnerBoundary = {
    delegationIssuer: input.issuer ?? issuerDouble.port,
    actorContextRepository: {
      async resolve() {
        return {
          outcome: 'ok' as const,
          providerClientId: SYNTHETIC_PROVIDER_CLIENT_ID,
          providerMappingId,
        };
      },
    },
    targetRepository: {
      async resolve() {
        return {
          providerExerciseId: 'c3-synthetic-exercise',
          targetMappingId,
          targetVersion: 'v1',
          startsAt: input.startsAt,
          durationMinutes: 90,
          capacity: 4,
          admissible: true,
        };
      },
    },
    ...(transportDouble ? { admissionTransport: transportDouble.port } : {}),
    async resolveProviderClientSubscriptionId(captured) {
      resolverInputs.push(captured);
      return input.mapped === false ? undefined : providerSubscriptionId;
    },
  };

  const runtime = createGameCommercialJoinRuntime({
    config: wireConfig(),
    pool: input.pool,
    rosterRepository: input.rosterRepository,
    conditionsOwner: input.conditionsOwner,
    ownerBoundary,
    async issueActorToken(captured) {
      actorTokenInputs.push(captured);
      if (input.tokenUnavailable) throw new Error('C3_SYNTHETIC_ACTOR_TOKEN_UNAVAILABLE');
      return issuedToken;
    },
  });
  if (!runtime) throw new Error('C3_WIRE_COMPOSITION_MISSING');
  return {
    runtime,
    targetMappingId,
    issuedToken,
    providerSubscriptionId,
    actorTokenInputs,
    resolverInputs,
    issuerDouble,
    transportDouble,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A real RS256 issuer: proves the claim names/values the LK1 receiver contract expects. */
function realIssuer(): DelegationIssuerPort {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2_048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: privateKey,
    keyId: 'c3-synthetic-key-1',
    issuer: 'c3-synthetic-issuer',
    audience: 'c3-synthetic-owner',
    ttlSeconds: 30,
  });
}

/** Every saved row touched by one commercial JOIN; read as raw JSON so a leak cannot hide. */
async function readRawWireRows(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<string[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const queries: Array<[string, unknown[]]> = [
      [
        `select row_to_json(t)::text as row from games.command_idempotency t
          where t.tenant_id = $1 and t.aggregate_id = $2`,
        [input.tenantId, input.gameId],
      ],
      [
        `select row_to_json(t)::text as row from games.seat_reservations t
          where t.tenant_id = $1 and t.game_id = $2`,
        [input.tenantId, input.gameId],
      ],
      [
        `select row_to_json(t)::text as row from eligibility.payment_snapshots t
          where t.tenant_id = $1 and t.activity_id = $2`,
        [input.tenantId, input.gameId],
      ],
      [
        `select row_to_json(t)::text as row from eligibility.decisions t
          where t.tenant_id = $1 and t.activity_id = $2`,
        [input.tenantId, input.gameId],
      ],
      [
        `select row_to_json(t)::text as row from games.payment_confirmation_evidence t
          where t.tenant_id = $1 and t.game_id = $2`,
        [input.tenantId, input.gameId],
      ],
      [
        `select row_to_json(t)::text as row from audit.audit_log t where t.tenant_id = $1`,
        [input.tenantId],
      ],
      [
        `select row_to_json(t)::text as row from audit.outbox_events t where t.tenant_id = $1`,
        [input.tenantId],
      ],
    ];
    const rows: string[] = [];
    for (const [sql, params] of queries) {
      const result = await client.query<{ row: string }>(sql, params);
      for (const row of result.rows) rows.push(row.row);
    }
    return rows;
  });
}

/**
 * Wraps the real roster repository so a case can prove whether a durable attempt was even started.
 * The proxy only observes `beginPaidJoin`; every other method is delegated unchanged.
 */
function withBeginCounter(inner: GameRosterRepository): {
  readonly repository: GameRosterRepository;
  readonly beginCalls: () => number;
} {
  let calls = 0;
  const repository = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'beginPaidJoin' && typeof value === 'function') {
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...innerArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { repository, beginCalls: () => calls };
}

c3DatabaseDescribe(`C3 commercial JOIN wire contract (${C3_FIXTURE_VERSION})`, () => {
  let pool: Pool;
  const apps: C3App[] = [];

  beforeAll(async () => {
    pool = await createC3Pool();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((entry) => entry.close()));
    await pool.end();
  });

  async function seedCase(label: string): Promise<{
    tenant: SyntheticTenant;
    game: SeededGame;
    conditions: ReturnType<typeof createConditionsDouble>;
    subscriptionInstanceId: string;
    rosterRepository: GameRosterRepository;
    beginCalls: () => number;
  }> {
    const tenant = await seedSyntheticTenant(pool, label);
    const game = await seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode: 'SPLIT',
      capacity: 4,
    });
    const subscriptionInstanceId = randomUUID();
    const conditions = createConditionsDouble({
      revision: game.revision,
      legacyGameId: game.legacyGameId,
      startsAt: game.startsAt,
      subscriptionInstanceId,
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_BASE_PRICE_MINOR,
        amountMinor: 0,
        freeMinutes: 90,
        paidMinutes: 0,
        reasonCode: null,
      },
    });
    const counted = withBeginCounter(createGameRosterRepository(pool));
    return {
      tenant,
      game,
      conditions,
      subscriptionInstanceId,
      rosterRepository: counted.repository,
      beginCalls: counted.beginCalls,
    };
  }

  /**
   * Seeds the server-side VIVA exercise mapping that the frozen provider binding is checked
   * against inside the real `beginPaidJoin` writer (merged main, receipt reconciliation #455).
   */
  async function seedExerciseMapping(input: {
    tenantId: string;
    gameId: string;
    mappingId: string;
    startsAt: string;
  }): Promise<void> {
    await withTenantTransaction(pool, input.tenantId, async (client) => {
      await client.query(
        `insert into integration.external_entity_map (
           tenant_id, id, external_system, entity_type, internal_id, external_id,
           external_version, last_synced_at, sync_status, sync_error_code
         ) values ($1, $2, 'VIVA', 'exercise', $3, 'c3-synthetic-exercise', 'v1', now(), 'synced', null)`,
        [input.tenantId, input.mappingId, input.gameId],
      );
    });
  }

  async function wireApp(input: {
    conditions: ReturnType<typeof createConditionsDouble>;
    runtime: NonNullable<ReturnType<typeof createGameCommercialJoinRuntime>>;
    rosterRepository: GameRosterRepository;
  }): Promise<C3App> {
    const composed = await buildC3App(pool, {
      conditions: input.conditions,
      owner: createOwnerDouble(),
      commercialJoinRuntime: input.runtime,
      rosterRepository: input.rosterRepository,
    });
    apps.push(composed);
    return composed;
  }

  function paidJoinPayload(input: {
    game: SeededGame;
    subscriptionInstanceId: string;
  }): Record<string, unknown> {
    return {
      expectedRevision: input.game.revision,
      subscriptionInstanceId: input.subscriptionInstanceId,
      priceConsent: { amountMinor: 0, currency: 'RUB' },
    };
  }

  async function joinAsPlayer(input: {
    app: C3App;
    tenant: SyntheticTenant;
    game: SeededGame;
    key: string;
    payload: Record<string, unknown>;
    correlationId?: string;
  }) {
    const token = await c3AccessToken({
      tenantId: input.tenant.tenantId,
      userId: input.tenant.playerA.userId,
      sessionId: input.tenant.playerA.sessionId,
    });
    return input.app.app.inject({
      method: 'POST',
      url: `/user/api/v1/${input.tenant.tenantKey}/games/${input.game.gameId}/join`,
      headers: c3Headers({
        token,
        idempotencyKey: input.key,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }),
      payload: input.payload,
    });
  }

  it('W1a: composed runtime -> 202 PROCESSING, one dispatch, durable attempt + ACTIVE reservation, bound delegation/transport envelope', async () => {
    const seeded = await seedCase('w1a');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
    });
    await seedExerciseMapping({
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
      mappingId: wire.targetMappingId,
      startsAt: seeded.game.startsAt,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });
    const key = c3IdempotencyKey('w1a');
    const correlationId = randomUUID();

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key,
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
      correlationId,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operation.status).toBe('PROCESSING');
    expect(body.operation.commercial.attemptState).toBe('OWNER_PENDING');

    // Exactly one owner dispatch, no owner read.
    expect(wire.transportDouble?.calls).toHaveLength(1);
    expect(wire.issuerDouble.readInputs).toHaveLength(0);

    // The delegation input carries the raw actor token plus the server-resolved provider mapping.
    expect(wire.resolverInputs).toHaveLength(1);
    expect(wire.resolverInputs[0]).toMatchObject({
      tenantId: seeded.tenant.tenantId,
      userId: seeded.tenant.playerA.userId,
      gameId: seeded.game.gameId,
      subscriptionInstanceId: seeded.subscriptionInstanceId,
    });
    expect(wire.issuerDouble.admissionInputs).toHaveLength(1);
    const delegationInput = wire.issuerDouble.admissionInputs[0]!;
    expect(delegationInput.actorToken).toEqual(wire.issuedToken);
    expect(delegationInput.providerClientSubscriptionId).toBe(wire.providerSubscriptionId);
    expect(delegationInput.correlationId).toBe(correlationId);
    expect(delegationInput.operationId).toBe(body.commandId);

    // The transport envelope carries the same token plus its stable sha256 binding.
    const [, envelope] = wire.transportDouble!.calls[0]!;
    expect(envelope.actorToken).toEqual(wire.issuedToken);
    expect(envelope.actorTokenSha256).toBe(actorTokenSha256(wire.issuedToken.token));
    expect(envelope.actorTokenSha256).toMatch(ACTOR_TOKEN_PATTERN);
    expect(envelope.actorDelegation).toBe('c3-synthetic-delegation-admission-v1');
    expect(envelope.operationId).toBe(body.commandId);
    expect(envelope.correlationId).toBe(correlationId);

    // Durable attempt + ACTIVE reservation exist before/with the external effect, and the
    // durable attempt was started exactly once.
    expect(seeded.beginCalls()).toBe(1);
    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
    expect(saved.activeReservations).toBe(1);
    expect(saved.participations).toBe(0);
    const commands = await readCommandRows(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ state: 'IN_PROGRESS', id: body.commandId });
    const reservations = await readReservations(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.state).toBe('ACTIVE');
    expect(reservations[0]?.user_id).toBe(seeded.tenant.playerA.userId);

    // The raw token is wire-only: it never enters the HTTP response body.
    expect(response.body).not.toContain(wire.issuedToken.token);
    expect(response.body).not.toContain(wire.providerSubscriptionId);
  });

  it('W1b: real adapter + real RS256 issuer put the token header and exact claim names on the wire', async () => {
    const seeded = await seedCase('w1b');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
      useTransportDouble: false,
      issuer: realIssuer(),
    });
    await seedExerciseMapping({
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
      mappingId: wire.targetMappingId,
      startsAt: seeded.game.startsAt,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });

    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      // Answer on the operation the signed delegation names, so the adapter can parse PENDING.
      const claims = decodeJwt(String(headers['X-Subscription-Actor-Delegation']));
      fetchCalls.push({ url: String(url), init });
      return jsonResponse(202, {
        contractVersion: 1,
        operationId: claims.operation_id,
        status: 'PENDING',
        reason: 'OWNER_PENDING',
        asOf: new Date().toISOString(),
      });
    });
    const key = c3IdempotencyKey('w1b');
    const correlationId = randomUUID();

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key,
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
      correlationId,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operation.status).toBe('PROCESSING');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${OWNER_BASE_URL}/lk/integrations/v1/booked-operation-admissions`,
    );

    const wireHeaders = (fetchCalls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(wireHeaders['X-Subscription-Actor-Token']).toBe(wire.issuedToken.token);
    expect(wireHeaders['X-Correlation-ID']).toBe(correlationId);
    expect(wireHeaders['Content-Type']).toBe('application/json');
    const delegation = String(wireHeaders['X-Subscription-Actor-Delegation']);
    expect(delegation).toMatch(headersPattern);
    const claims = decodeJwt(delegation);
    // Exact names the LK1 receiver verifies, joined to one signed delegation.
    expect(claims.actor_token_sha256).toBe(actorTokenSha256(wire.issuedToken.token));
    expect(claims.actor_token_sha256).toMatch(ACTOR_TOKEN_PATTERN);
    expect(claims.actor_token_expires_at).toBe(wire.issuedToken.expiresAt);
    expect(claims.provider_client_subscription_id).toBe(wire.providerSubscriptionId);
    expect(claims.operation_id).toBe(body.commandId);
    expect(claims.scope).toBe('subscription-runtime.booked-operation.admit');
    expect(claims.method).toBe('POST');
    expect(claims.path).toBe('/lk/integrations/v1/booked-operation-admissions');

    // Canonical body is the server-owned request, never client price/identity.
    const posted = JSON.parse(String(fetchCalls[0]?.init.body));
    expect(posted).toEqual({
      action: 'JOIN_GAME',
      target: { id: seeded.game.gameId, expectedRevision: seeded.game.revision },
      paymentIntent: 'USE_SUBSCRIPTION',
    });

    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.activeReservations).toBe(1);
    expect(saved.commandRows).toBe(1);
    expect(response.body).not.toContain(wire.issuedToken.token);
    expect(response.body).not.toContain(wire.providerSubscriptionId);
  });

  it('W2a: no provider-subscription mapping -> 409 GAME_SUBSCRIPTION_SELECTION_REQUIRED with no owner dispatch or live state', async () => {
    const seeded = await seedCase('w2a');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
      mapped: false,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key: c3IdempotencyKey('w2a'),
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
    // Fail closed before the owner: no token issued, no delegation, no dispatch.
    expect(wire.resolverInputs).toHaveLength(1);
    expect(wire.actorTokenInputs).toHaveLength(0);
    expect(wire.issuerDouble.admissionInputs).toHaveLength(0);
    expect(wire.transportDouble?.calls).toHaveLength(0);
    expect(wire.issuerDouble.readInputs).toHaveLength(0);

    // C1 c36877f9: the provider-subscription mapping is resolved BEFORE the durable attempt, so an
    // unmapped selection is a pure refusal: no attempt, no seat, no snapshot, no audit/outbox.
    expect(seeded.beginCalls()).toBe(0);
    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(0);
    expect(saved.reservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.auditEvents).toBe(0);
    expect(saved.outboxEvents).toBe(0);
    expect(saved.participations).toBe(0);
    expect(saved.paymentEvidence).toBe(0);
  });

  it('W2b: an unmapped subscription selection must not create reservation/snapshot/command rows', async () => {
    const seeded = await seedCase('w2b');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
      mapped: false,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key: c3IdempotencyKey('w2b'),
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GAME_SUBSCRIPTION_SELECTION_REQUIRED');

    // Acceptance condition (C1 c36877f9, was C3-WIRE-P2-1 on 9dd937e7): the provider-subscription
    // mapping is resolved before the durable attempt, so an unmapped selection leaves zero rows —
    // no command idempotency row, no reservation in ANY state, no snapshot, no audit REJECTED,
    // no outbox event — and beginPaidJoin is never called.
    expect(seeded.beginCalls()).toBe(0);
    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(0);
    expect(saved.reservations).toBe(0);
    expect(saved.activeReservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.auditEvents).toBe(0);
    expect(saved.outboxEvents).toBe(0);
    expect(saved.participations).toBe(0);
    expect(saved.paymentEvidence).toBe(0);
    const reservations = await readReservations(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(reservations).toHaveLength(0);
    const commands = await readCommandRows(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(commands).toHaveLength(0);
  });

  it('W2c: token unavailable -> 202 UNKNOWN with the durable attempt preserved and no dispatch', async () => {
    const seeded = await seedCase('w2c');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
      tokenUnavailable: true,
    });
    await seedExerciseMapping({
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
      mappingId: wire.targetMappingId,
      startsAt: seeded.game.startsAt,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key: c3IdempotencyKey('w2c'),
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operation.status).toBe('UNKNOWN');
    expect(body.operation.nextAction.type).toBe('WAIT_FOR_RECONCILIATION');
    expect(wire.actorTokenInputs).toHaveLength(1);
    expect(wire.issuerDouble.admissionInputs).toHaveLength(0);
    expect(wire.transportDouble?.calls).toHaveLength(0);
    expect(wire.issuerDouble.readInputs).toHaveLength(0);

    // The attempt and its seat survive: no silent failure, no silent release.
    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(1);
    expect(saved.activeReservations).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
    expect(saved.participations).toBe(0);
    expect(response.body).not.toContain(wire.providerSubscriptionId);
  });

  it('W2d: without composition the paid JOIN keeps the old GAME_PAYMENT_REQUIRED fail-closed behaviour', async () => {
    const seeded = await seedCase('w2d');
    const composed = await buildC3App(pool, {
      conditions: seeded.conditions,
      owner: createOwnerDouble(),
      commercialJoin: false,
      rosterRepository: seeded.rosterRepository,
    });
    apps.push(composed);

    const response = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key: c3IdempotencyKey('w2d'),
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GAME_PAYMENT_REQUIRED');
    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(0);
    expect(saved.reservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.participations).toBe(0);
    expect(seeded.conditions.calls.readPreview).toBe(0);
  });

  it('W3a: the actor token and provider subscription id leak into no response body and no saved row', async () => {
    const seeded = await seedCase('w3a');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
    });
    await seedExerciseMapping({
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
      mappingId: wire.targetMappingId,
      startsAt: seeded.game.startsAt,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });
    const key = c3IdempotencyKey('w3a');

    const joinResponse = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key,
      payload: paidJoinPayload({
        game: seeded.game,
        subscriptionInstanceId: seeded.subscriptionInstanceId,
      }),
    });
    expect(joinResponse.statusCode).toBe(202);
    const operationId = joinResponse.json().commandId;

    // Readback is the only authoritative unresolved-state read; it must not echo the credential.
    vi.stubGlobal('fetch', async () =>
      jsonResponse(200, {
        contractVersion: 1,
        operationId,
        status: 'PENDING',
        reason: 'OWNER_PENDING',
        asOf: new Date().toISOString(),
      }),
    );
    const token = await c3AccessToken({
      tenantId: seeded.tenant.tenantId,
      userId: seeded.tenant.playerA.userId,
      sessionId: seeded.tenant.playerA.sessionId,
    });
    const readback = await composed.app.inject({
      method: 'GET',
      url: `/user/api/v1/${seeded.tenant.tenantKey}/games/${seeded.game.gameId}/join-operation`,
      headers: c3Headers({ token, idempotencyKey: key }),
    });
    expect([200, 202]).toContain(readback.statusCode);

    const rawResponses = [joinResponse.body, readback.body];
    for (const raw of rawResponses) {
      expect(raw).not.toContain(wire.issuedToken.token);
      expect(raw).not.toContain(wire.providerSubscriptionId);
    }
    const savedRows = await readRawWireRows(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    // Non-vacuous probe: the rows that would otherwise carry a leaked id were actually read.
    expect(savedRows.length).toBeGreaterThan(0);
    for (const row of savedRows) {
      expect(row).not.toContain(wire.issuedToken.token);
      expect(row).not.toContain(wire.providerSubscriptionId);
    }
  });

  it('W4a: a repeat of the same key after PENDING dispatches once, reads no owner and changes no row', async () => {
    const seeded = await seedCase('w4a');
    const wire = composeWireRuntime({
      pool,
      rosterRepository: seeded.rosterRepository,
      conditionsOwner: seeded.conditions.owner,
      startsAt: seeded.game.startsAt,
    });
    await seedExerciseMapping({
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
      mappingId: wire.targetMappingId,
      startsAt: seeded.game.startsAt,
    });
    const composed = await wireApp({
      conditions: seeded.conditions,
      runtime: wire.runtime,
      rosterRepository: seeded.rosterRepository,
    });
    const key = c3IdempotencyKey('w4a');
    const payload = paidJoinPayload({
      game: seeded.game,
      subscriptionInstanceId: seeded.subscriptionInstanceId,
    });

    const first = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(wire.transportDouble?.calls).toHaveLength(1);

    // The client lost the first response; it retries with the same key.
    const second = await joinAsPlayer({
      app: composed,
      tenant: seeded.tenant,
      game: seeded.game,
      key,
      payload,
    });
    expect([200, 202]).toContain(second.statusCode);
    expect(second.json().replayed).toBe(true);
    expect(second.json().operation.status).toBe('UNKNOWN');
    expect(second.json().commandId).toBe(first.json().commandId);
    expect(wire.transportDouble?.calls).toHaveLength(1);
    expect(wire.issuerDouble.admissionInputs).toHaveLength(1);
    // A repeat is purely local: no owner read (D3a semantics).
    expect(wire.issuerDouble.readInputs).toHaveLength(0);

    const saved = await readSavedState(pool, {
      tenantId: seeded.tenant.tenantId,
      gameId: seeded.game.gameId,
    });
    expect(saved.commandRows).toBe(1);
    expect(saved.activeReservations).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
  });
});
