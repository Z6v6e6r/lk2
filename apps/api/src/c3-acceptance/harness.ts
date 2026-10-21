/**
 * C3 independent acceptance harness for the commercial CREATE/JOIN contour.
 *
 * Ownership: C3 (independent acceptance tests). This file is TEST-ONLY. It never
 * changes product behaviour; it composes the real LK2 app with real PostgreSQL
 * repositories and replaces only the external owners (LK1 price preview / commercial
 * executor) with countable local doubles. A double proves LOCAL behaviour only.
 *
 * Evidence levels: LOCAL (this harness). No provider, staging or production calls.
 */

import { createHash, randomUUID } from 'node:crypto';

import { loadConfig, type AppConfig } from '@phub/config';
import {
  createGameRepository,
  createGameRosterRepository,
  withTenantTransaction,
  type GameRepository,
  type GameRosterRepository,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { describe } from 'vitest';

import { buildApp } from '../app.js';
import type {
  CommercialJoinOwnerOutcome,
  CommercialJoinOwnerPort,
} from '../games/game-commercial-join.js';
import type {
  GameJoinConditionsOwner,
  Lk1GamePreviewSelection,
} from '../games/game-join-conditions.js';
import type { GameCommercialJoinOptions } from '../games/game-routes.js';

/** Bumped whenever synthetic fixtures/timestamps change in a way that invalidates results. */
export const C3_FIXTURE_VERSION = 'c3-2026-10-21.1';

/** Every row this suite creates is synthetic and must never be read as a live tariff/account. */
export const C3_SYNTHETIC_MARKER = 'C3 SYNTHETIC';

export const C3_JWT_ISSUER = 'phub-identity';
export const C3_JWT_AUDIENCE = 'phub-api';
const C3_JWT_SECRET = 'c3-independent-acceptance-secret-at-least-32-chars';
const C3_JWT_REFRESH_SECRET = 'c3-independent-acceptance-refresh-secret-32-chars';

export function c3DatabaseUrl(): string | undefined {
  const value = process.env.C3_ACCEPTANCE_DATABASE_URL;
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Suites that need the isolated PostgreSQL database use this guard. When the isolated
 * database is absent the suite is NOT RUN (never reported as PASS); the team matrix records
 * that honestly.
 */
export const c3DatabaseDescribe = c3DatabaseUrl() ? describe : describe.skip;

export function loadC3Config(): AppConfig {
  return loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: c3DatabaseUrl() ?? 'postgresql://c3:absent@127.0.0.1:1/absent',
    REDIS_URL: 'redis://127.0.0.1:6399',
    RABBITMQ_URL: 'amqp://127.0.0.1:5699',
    JWT_ISSUER: C3_JWT_ISSUER,
    JWT_AUDIENCE: C3_JWT_AUDIENCE,
    JWT_ACCESS_SECRET: C3_JWT_SECRET,
    JWT_REFRESH_SECRET: C3_JWT_REFRESH_SECRET,
  });
}

export function silentLogger() {
  return createLogger('c3-acceptance', 'silent');
}

export interface SyntheticActor {
  readonly userId: string;
  readonly sessionId: string;
}

export interface SyntheticTenant {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly organizer: SyntheticActor;
  readonly playerA: SyntheticActor;
  readonly playerB: SyntheticActor;
  readonly outsider: SyntheticActor;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Creates an isolated synthetic tenant with four members in the C3 test database. */
export async function seedSyntheticTenant(pool: Pool, label = 'base'): Promise<SyntheticTenant> {
  const tenantId = randomUUID();
  const tenantKey = `c3-${label}-${tenantId.slice(0, 8)}`;
  const actor = (): SyntheticActor => ({ userId: randomUUID(), sessionId: randomUUID() });
  const organizer = actor();
  const playerA = actor();
  const playerB = actor();
  const outsider = actor();
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name, active)
     values ($1, $2, $3, true)`,
    [tenantId, tenantKey, `${C3_SYNTHETIC_MARKER} tenant ${label}`],
  );
  const members = [organizer, playerA, playerB, outsider];
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into identity.users (tenant_id, id, status)
       select $1, member_id, 'ACTIVE' from unnest($2::uuid[]) as members(member_id)`,
      [tenantId, members.map((member) => member.userId)],
    );
    for (const member of members) {
      await client.query(
        `insert into identity.refresh_sessions (
           id, tenant_id, user_id, family_id, token_hash, expires_at
         ) values ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [
          member.sessionId,
          tenantId,
          member.userId,
          randomUUID(),
          createHash('sha256').update(`c3-synthetic-token-${member.sessionId}`).digest('hex'),
        ],
      );
    }
  });
  return { tenantId, tenantKey, organizer, playerA, playerB, outsider };
}

export interface SeedGameInput {
  readonly tenantId: string;
  readonly organizerUserId: string;
  readonly paymentMode: 'NO_PAYMENT' | 'SPLIT' | 'SUBSCRIPTION' | 'ORGANIZER_PAYS';
  readonly capacity?: number;
  readonly startsAt?: Date;
  readonly durationMinutes?: number;
  readonly joinCutoffAt?: Date;
  readonly title?: string;
  readonly visibility?: 'PUBLIC' | 'PRIVATE';
  readonly lifecycleState?: 'SCHEDULED' | 'DRAFT';
  readonly timezone?: string;
}

export interface SeededGame {
  readonly gameId: string;
  readonly revision: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly joinCutoffAt: string;
  readonly legacyGameId: string;
}

/** Inserts one synthetic paid/free game row in the C3 test database. */
export async function seedSyntheticGame(pool: Pool, input: SeedGameInput): Promise<SeededGame> {
  const gameId = randomUUID();
  const startsAt = input.startsAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + (input.durationMinutes ?? 90) * 60_000);
  const joinCutoffAt = input.joinCutoffAt ?? new Date(startsAt.getTime() - 30 * 60_000);
  const stationId = randomUUID();
  await withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query(
      `insert into games.games (
         tenant_id, id, revision, organizer_user_id, title, kind, visibility,
         lifecycle_state, station_id, court_id, starts_at, ends_at, timezone,
         capacity, waitlist_enabled, join_cutoff_at, payment_mode
       ) values (
         $1, $2, 1, $3, $4, 'FRIENDLY', $5,
         $6, $7, null, $8, $9, $10,
         $11, false, $12, $13
       )`,
      [
        input.tenantId,
        gameId,
        input.organizerUserId,
        input.title ?? `${C3_SYNTHETIC_MARKER} game ${gameId}`,
        input.visibility ?? 'PUBLIC',
        input.lifecycleState ?? 'SCHEDULED',
        stationId,
        startsAt.toISOString(),
        endsAt.toISOString(),
        input.timezone ?? 'Europe/Moscow',
        input.capacity ?? 4,
        joinCutoffAt.toISOString(),
        input.paymentMode,
      ],
    );
  });
  return {
    gameId,
    revision: 1,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    joinCutoffAt: joinCutoffAt.toISOString(),
    legacyGameId: `c3-legacy-${gameId}`,
  };
}

/** Signs a real PadlHub access token; identity/tenant/price remain server-owned. */
export async function c3AccessToken(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly permissions?: readonly string[];
  readonly roles?: readonly string[];
}): Promise<string> {
  return new SignJWT({
    tenants: [input.tenantId],
    roles: input.roles ?? ['client'],
    permissions: input.permissions ?? ['games.play'],
    sid: input.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(C3_JWT_ISSUER)
    .setAudience(C3_JWT_AUDIENCE)
    .setSubject(input.userId)
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(C3_JWT_SECRET));
}

export function c3Headers(input: {
  readonly token: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.token}`,
    'idempotency-key': input.idempotencyKey,
    'x-correlation-id': input.correlationId ?? randomUUID(),
    'content-type': 'application/json',
  };
}

export function c3IdempotencyKey(label: string): string {
  return `c3-${label}-${randomUUID()}`;
}

/**
 * LK1 price-preview double. Represents the approved owner contract shape, but every
 * amount/status below is a SYNTHETIC fixture, not a live tariff.
 */
export interface ConditionsQuoteFixture {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE' | 'LIMIT_USED';
  readonly basePriceMinor: number;
  readonly amountMinor: number | null;
  readonly freeMinutes: number;
  readonly paidMinutes: number;
  readonly reasonCode: string | null;
  readonly basePriceOffsetMinor?: number;
}

export interface ConditionsDoubleOptions {
  readonly revision: number;
  readonly legacyGameId: string;
  readonly startsAt: string;
  readonly quote: ConditionsQuoteFixture;
  readonly subscriptionInstanceId: string;
  readonly previewTtlMs?: number;
  readonly sourceVersion?: string;
  readonly providerMode?: 'MOCK' | 'LIVE';
}

export interface ConditionsDouble {
  readonly owner: GameJoinConditionsOwner;
  readonly calls: { resolveSelection: number; readPreview: number };
  readonly lastQuote: () => ConditionsQuoteFixture;
  readonly setQuote: (quote: ConditionsQuoteFixture) => void;
  readonly setRevision: (revision: number) => void;
  readonly setPreviewFault: (fault: 'NONE' | 'TIMEOUT' | 'INVALID') => void;
}

const PREVIEW_FAULT_MESSAGE: Record<'TIMEOUT' | 'INVALID', string> = {
  TIMEOUT: 'C3_SYNTHETIC_PREVIEW_TIMEOUT',
  INVALID: 'C3_SYNTHETIC_PREVIEW_INVALID',
};

/**
 * Builds an LK1 game-price-preview double. It validates the server-owned selection exactly
 * like the real owner would: the response is bound to the actor and the game revision, and it
 * must be re-read before use. No client field is trusted.
 */
export function createConditionsDouble(options: ConditionsDoubleOptions): ConditionsDouble {
  const calls = { resolveSelection: 0, readPreview: 0 };
  let revision = options.revision;
  let quote = options.quote;
  let previewFault: 'NONE' | 'TIMEOUT' | 'INVALID' = 'NONE';
  const expiresInMs = options.previewTtlMs ?? 30_000;
  const owner: GameJoinConditionsOwner = {
    async resolveSelection(actor, _signal): Promise<Lk1GamePreviewSelection | null> {
      calls.resolveSelection += 1;
      return {
        tenantKey: actor.tenantKey,
        correlationId: actor.correlationId,
        tenantId: actor.tenantId,
        userId: actor.userId,
        sessionId: actor.sessionId,
        gameId: actor.gameId,
        expectedRevision: revision,
        subscriptionInstanceId: options.subscriptionInstanceId,
        revision,
        sourceVersion: options.sourceVersion ?? 'c3-synthetic-source-v1',
        legacyGameId: options.legacyGameId,
        legacySubscriptionId: options.subscriptionInstanceId,
        providerClientId: 'c3-synthetic-provider-client',
        providerTenantKey: 'c3synthetic',
        startsAt: options.startsAt,
        durationMinutes: 90,
        authorization: 'Bearer c3-synthetic-owner-delegation',
        providerMode: options.providerMode ?? 'MOCK',
      };
    },
    async readPreview(selection, _signal, _correlationId): Promise<unknown> {
      calls.readPreview += 1;
      if (previewFault !== 'NONE') {
        throw new Error(PREVIEW_FAULT_MESSAGE[previewFault]);
      }
      const now = Date.now();
      return {
        quotes: [
          {
            subscriptionId: selection.legacySubscriptionId,
            selectionKey: JSON.stringify([
              'EXISTING_GAME',
              selection.legacyGameId,
              selection.startsAt,
              90,
            ]),
            status: quote.status,
            basePriceMinor: quote.basePriceMinor + (quote.basePriceOffsetMinor ?? 0),
            amountMinor: quote.amountMinor,
            freeMinutes: quote.freeMinutes,
            paidMinutes: quote.paidMinutes,
            reasonCode: quote.reasonCode,
            evaluatedAt: now,
            expiresAt: now + expiresInMs,
          },
        ],
      };
    },
  };
  return {
    owner,
    calls,
    lastQuote: () => quote,
    setQuote: (next) => {
      quote = next;
    },
    setRevision: (next) => {
      revision = next;
    },
    setPreviewFault: (fault) => {
      previewFault = fault;
    },
  };
}

/**
 * Commercial executor double (existing owner of booking/entitlement). It is idempotent by
 * operation id, counts every execute/read call and can simulate pending/unknown/rejection.
 * It never proves a real payment; only a trusted receipt can.
 */
export interface OwnerDouble {
  readonly owner: CommercialJoinOwnerPort;
  readonly calls: { execute: number; read: number };
  readonly executed: Array<Parameters<CommercialJoinOwnerPort['execute']>[0]>;
  readonly readCalls: Array<Parameters<CommercialJoinOwnerPort['read']>[0]>;
  readonly pushOutcome: (outcome: CommercialJoinOwnerOutcome) => void;
  readonly setThrowOnExecute: (error: Error | undefined) => void;
  readonly setReadOutcome: (outcome: CommercialJoinOwnerOutcome | null) => void;
}

export function createOwnerDouble(
  initialOutcomes: readonly CommercialJoinOwnerOutcome[] = [{ status: 'PENDING' }],
): OwnerDouble {
  const outcomes = [...initialOutcomes];
  const calls = { execute: 0, read: 0 };
  const executed: Array<Parameters<CommercialJoinOwnerPort['execute']>[0]> = [];
  const readCalls: Array<Parameters<CommercialJoinOwnerPort['read']>[0]> = [];
  let throwOnExecute: Error | undefined;
  let readOutcome: CommercialJoinOwnerOutcome | null = null;
  const owner: CommercialJoinOwnerPort = {
    async execute(input) {
      calls.execute += 1;
      executed.push(input);
      if (throwOnExecute) throw throwOnExecute;
      const next = outcomes.length > 0 ? outcomes.shift()! : { status: 'PENDING' as const };
      return next;
    },
    async read(input) {
      calls.read += 1;
      readCalls.push(input);
      return readOutcome;
    },
  };
  return {
    owner,
    calls,
    executed,
    readCalls,
    pushOutcome: (outcome) => {
      outcomes.push(outcome);
    },
    setThrowOnExecute: (error) => {
      throwOnExecute = error;
    },
    setReadOutcome: (outcome) => {
      readOutcome = outcome;
    },
  };
}

export interface C3AppOptions {
  readonly conditions: ConditionsDouble;
  readonly owner: OwnerDouble;
  /** Omit to keep the previously shipped fail-closed behaviour (no commercial composition). */
  readonly commercialJoin?: boolean;
  /**
   * Exact composition built by the shipped `createGameCommercialJoinRuntime` factory. When given it
   * is wired as-is, so the real HTTP route runs the production factory output instead of a
   * hand-assembled test object.
   */
  readonly commercialJoinRuntime?: GameCommercialJoinOptions;
  readonly rosterRepository?: GameRosterRepository;
  readonly managementRepository?: GameRepository;
}

export interface C3App {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly rosterRepository: GameRosterRepository;
  readonly managementRepository: GameRepository;
  readonly close: () => Promise<void>;
}

/** Composes the real LK2 app over the C3 isolated database with countable owner doubles. */
export async function buildC3App(pool: Pool, options: C3AppOptions): Promise<C3App> {
  const config = loadC3Config();
  const rosterRepository = options.rosterRepository ?? createGameRosterRepository(pool);
  const managementRepository = options.managementRepository ?? createGameRepository(pool);
  const gameCommercialJoin: GameCommercialJoinOptions | undefined =
    options.commercialJoinRuntime ??
    (options.commercialJoin === false
      ? undefined
      : {
          repository: rosterRepository as unknown as GameCommercialJoinOptions['repository'],
          conditionsOwner: options.conditions.owner,
          owner: options.owner.owner,
        });
  const app = await buildApp({
    config,
    logger: silentLogger(),
    pool,
    gameRosterRepository: rosterRepository,
    gameCommandRepository: managementRepository,
    gameJoinConditionsOwner: options.conditions.owner,
    accessSessionChecker: async ({ tenantId, userId, sessionId }) => {
      const result = await pool.query(
        `select 1 from identity.refresh_sessions
          where id = $3 and tenant_id = $1 and user_id = $2
            and revoked_at is null and expires_at > now()`,
        [tenantId, userId, sessionId],
      );
      return result.rowCount === 1;
    },
    ...(gameCommercialJoin ? { gameCommercialJoin } : {}),
  });
  return {
    app,
    rosterRepository,
    managementRepository,
    close: () => app.close(),
  };
}

export async function createC3Pool(): Promise<Pool> {
  const connectionString = c3DatabaseUrl();
  if (!connectionString) throw new Error('C3_ACCEPTANCE_DATABASE_URL is required');
  return new Pool({ connectionString, max: 8 });
}

/** Saved-state readers: acceptance cases assert these, not only HTTP status codes. */
export interface SavedState {
  readonly participations: number;
  readonly activeReservations: number;
  readonly reservations: number;
  readonly commandRows: number;
  readonly paymentSnapshots: number;
  readonly eligibilityDecisions: number;
  readonly paymentEvidence: number;
  readonly auditEvents: number;
  readonly outboxEvents: number;
}

export async function readSavedState(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId?: string },
): Promise<SavedState> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const gameFilter = input.gameId ?? null;
    const result = await client.query<{
      participations: string;
      active_reservations: string;
      reservations: string;
      command_rows: string;
      payment_snapshots: string;
      eligibility_decisions: string;
      payment_evidence: string;
      audit_events: string;
      outbox_events: string;
    }>(
      `select
         (select count(*) from games.participations
           where tenant_id = $1 and ($2::uuid is null or game_id = $2))::text as participations,
         (select count(*) from games.seat_reservations
           where tenant_id = $1 and ($2::uuid is null or game_id = $2)
             and state = 'ACTIVE')::text as active_reservations,
         (select count(*) from games.seat_reservations
           where tenant_id = $1 and ($2::uuid is null or game_id = $2))::text as reservations,
         (select count(*) from games.command_idempotency
           where tenant_id = $1 and ($2::uuid is null or aggregate_id = $2))::text as command_rows,
         (select count(*) from eligibility.payment_snapshots
           where tenant_id = $1 and ($2::uuid is null or activity_id = $2))::text
             as payment_snapshots,
         (select count(*) from eligibility.decisions
           where tenant_id = $1 and ($2::uuid is null or activity_id = $2))::text
             as eligibility_decisions,
         (select count(*) from games.payment_confirmation_evidence
           where tenant_id = $1 and ($2::uuid is null or game_id = $2))::text
             as payment_evidence,
         (select count(*) from audit.audit_log
           where tenant_id = $1)::text as audit_events,
         (select count(*) from audit.outbox_events
           where tenant_id = $1)::text as outbox_events`,
      [input.tenantId, gameFilter],
    );
    const row = result.rows[0]!;
    const asNumber = (value: string): number => Number(value);
    return {
      participations: asNumber(row.participations),
      activeReservations: asNumber(row.active_reservations),
      reservations: asNumber(row.reservations),
      commandRows: asNumber(row.command_rows),
      paymentSnapshots: asNumber(row.payment_snapshots),
      eligibilityDecisions: asNumber(row.eligibility_decisions),
      paymentEvidence: asNumber(row.payment_evidence),
      auditEvents: asNumber(row.audit_events),
      outboxEvents: asNumber(row.outbox_events),
    };
  });
}

export interface ReservationRow {
  readonly id: string;
  readonly state: string;
  readonly payment_state: string;
  readonly user_id: string;
  readonly eligibility_decision_id: string | null;
}

export async function readReservations(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<ReservationRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<ReservationRow>(
      `select id, state, payment_state, user_id, eligibility_decision_id
         from games.seat_reservations
        where tenant_id = $1 and game_id = $2
        order by created_at`,
      [input.tenantId, input.gameId],
    );
    return result.rows;
  });
}

export interface CommandRow {
  readonly id: string;
  readonly state: string;
  readonly request_hash: string;
  readonly idempotency_key: string;
  readonly command_type: string;
  readonly error_code: string | null;
}

export async function readCommandRows(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<CommandRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<CommandRow>(
      `select id, state, request_hash, idempotency_key, command_type, error_code
         from games.command_idempotency
        where tenant_id = $1 and aggregate_id = $2
        order by created_at`,
      [input.tenantId, input.gameId],
    );
    return result.rows;
  });
}

export interface ParticipationRow {
  readonly id: string;
  readonly user_id: string;
  readonly state: string;
  readonly payment_state: string;
}

export async function readParticipations(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<ParticipationRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<ParticipationRow>(
      `select id, user_id, state, payment_state
         from games.participations
        where tenant_id = $1 and game_id = $2
        order by joined_at`,
      [input.tenantId, input.gameId],
    );
    return result.rows;
  });
}

export function assertSyntheticTenant(tenant: SyntheticTenant): void {
  if (!UUID.test(tenant.tenantId)) throw new Error('C3_SYNTHETIC_TENANT_INVALID');
  if (tenant.tenantKey.includes(' ')) throw new Error('C3_SYNTHETIC_TENANT_KEY_INVALID');
}
