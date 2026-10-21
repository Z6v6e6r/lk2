/**
 * C3 independent acceptance helpers — paid JOIN concurrency/recovery (scenario D) and
 * authorization/entitlement (scenario E, including the personal-invitation bypass case E7).
 *
 * Ownership: C3 (independent acceptance tests). This module is TEST-ONLY. It writes only synthetic
 * `C3 SYNTHETIC` rows into the isolated C3 PostgreSQL database, wraps the Lead-owned harness doubles
 * and never changes product behaviour. The commercial owner (executor) and the LK1 conditions owner
 * stay local doubles, so every result is LOCAL evidence only. No provider, staging or production
 * traffic is involved.
 */

import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import type { LightMyRequestResponse } from 'fastify';
import type { Pool, PoolClient } from 'pg';

import type { GameJoinConditionsOwner } from '../games/game-join-conditions.js';
import {
  c3Headers,
  createConditionsDouble,
  seedSyntheticGame,
  type C3App,
  type ConditionsDouble,
  type ConditionsQuoteFixture,
  type SeededGame,
  type SyntheticTenant,
} from './harness.js';

export type { ConditionsDouble };

/** The real Fastify instance returned by `buildC3App(...).app` (the harness wrapper is C3App). */
export type C3FastifyApp = C3App['app'];

/** SYNTHETIC fixture amounts. Never a live tariff. */
export const C3_SYNTHETIC_BASE_PRICE_MINOR = 150_000;
export const C3_SYNTHETIC_SURCHARGE_PRICE_MINOR = 90_000;
export const C3_SYNTHETIC_FREE_MINUTES = 60;
export const C3_SYNTHETIC_PAID_MINUTES = 30;
export const C3_SYNTHETIC_FREE_GAME_MINUTES = 90;

// ---------------------------------------------------------------------------------------------
// Conditions (LK1 price preview) doubles
// ---------------------------------------------------------------------------------------------

export interface SyntheticQuoteInput {
  readonly amountMinor?: number | null;
  readonly basePriceMinor?: number;
  readonly freeMinutes?: number;
  readonly paidMinutes?: number;
  readonly status?: ConditionsQuoteFixture['status'];
  readonly reasonCode?: string | null;
}

/** Builds one advisory price quote. Every number is a SYNTHETIC fixture, not a live tariff. */
export function syntheticQuote(input: SyntheticQuoteInput = {}): ConditionsQuoteFixture {
  const status = input.status ?? 'AVAILABLE';
  if (status !== 'AVAILABLE') {
    return {
      status,
      basePriceMinor: input.basePriceMinor ?? C3_SYNTHETIC_BASE_PRICE_MINOR,
      amountMinor: null,
      freeMinutes: 0,
      paidMinutes: 0,
      reasonCode: input.reasonCode ?? 'C3_SYNTHETIC_NOT_AVAILABLE',
    };
  }
  const amountMinor = input.amountMinor ?? 0;
  const freeMinutes =
    input.freeMinutes ?? (amountMinor > 0 ? C3_SYNTHETIC_FREE_MINUTES : C3_SYNTHETIC_FREE_GAME_MINUTES);
  const paidMinutes = input.paidMinutes ?? C3_SYNTHETIC_FREE_GAME_MINUTES - freeMinutes;
  return {
    status: 'AVAILABLE',
    basePriceMinor: input.basePriceMinor ?? C3_SYNTHETIC_BASE_PRICE_MINOR,
    amountMinor,
    freeMinutes,
    paidMinutes,
    reasonCode: null,
  };
}

/** A fully covered subscription game: the server amount is zero. */
export function zeroSurchargeQuote(): ConditionsQuoteFixture {
  return syntheticQuote({ amountMinor: 0 });
}

/** A split surcharge: the server amount is the synthetic surcharge. */
export function surchargeQuote(): ConditionsQuoteFixture {
  return syntheticQuote({
    amountMinor: C3_SYNTHETIC_SURCHARGE_PRICE_MINOR,
    freeMinutes: C3_SYNTHETIC_FREE_MINUTES,
    paidMinutes: C3_SYNTHETIC_PAID_MINUTES,
  });
}

export interface ConditionsForGameOptions {
  readonly quote?: ConditionsQuoteFixture;
  readonly subscriptionInstanceId?: string;
  readonly revision?: number;
  readonly previewTtlMs?: number;
}

/** Composes the Lead-owned LK1 preview double for one seeded game. */
export function conditionsForGame(
  game: SeededGame,
  options: ConditionsForGameOptions = {},
): ConditionsDouble {
  return createConditionsDouble({
    revision: options.revision ?? game.revision,
    legacyGameId: game.legacyGameId,
    startsAt: game.startsAt,
    subscriptionInstanceId: options.subscriptionInstanceId ?? randomUUID(),
    quote: options.quote ?? zeroSurchargeQuote(),
    ...(options.previewTtlMs === undefined ? {} : { previewTtlMs: options.previewTtlMs }),
  });
}

/**
 * Simulates an owner that cannot map the requested subscription product to this actor (a foreign or
 * non-owned subscription instance): no selection is returned, so nothing may be reserved.
 */
export function conditionsWithoutOwnedSelection(base: ConditionsDouble): ConditionsDouble {
  const owner: GameJoinConditionsOwner = {
    async resolveSelection(): Promise<null> {
      return null;
    },
    readPreview: (selection, signal, correlationId) =>
      base.owner.readPreview(selection, signal, correlationId),
  };
  return { ...base, owner };
}

/**
 * Simulates a rules/usage-induced owner revision advance: the owner echoes the actor's
 * `expectedRevision` (as the real owner does) but reports a newer current revision. The advisory
 * conditions read must refuse it before any reservation.
 */
export function conditionsWithAdvancedRevision(
  base: ConditionsDouble,
  advancedRevision: number,
): ConditionsDouble {
  const owner: GameJoinConditionsOwner = {
    async resolveSelection(actor, signal) {
      const selection = await base.owner.resolveSelection(actor, signal);
      if (!selection) return null;
      return {
        ...selection,
        expectedRevision: actor.expectedRevision,
        revision: advancedRevision,
      };
    },
    readPreview: (selection, signal, correlationId) =>
      base.owner.readPreview(selection, signal, correlationId),
  };
  return { ...base, owner };
}

// ---------------------------------------------------------------------------------------------
// HTTP request builders (real app, real JWTs; only the external owners are doubles)
// ---------------------------------------------------------------------------------------------

export interface PaidJoinBodyInput {
  readonly expectedRevision: number;
  readonly subscriptionInstanceId?: string;
  readonly amountMinor?: number;
  readonly currency?: 'RUB';
  readonly invitationId?: string;
  readonly extra?: Record<string, unknown>;
}

export function paidJoinBody(input: PaidJoinBodyInput): Record<string, unknown> {
  return {
    expectedRevision: input.expectedRevision,
    ...(input.subscriptionInstanceId === undefined
      ? {}
      : { subscriptionInstanceId: input.subscriptionInstanceId }),
    ...(input.amountMinor === undefined
      ? {}
      : { priceConsent: { amountMinor: input.amountMinor, currency: input.currency ?? 'RUB' } }),
    ...(input.invitationId === undefined ? {} : { invitationId: input.invitationId }),
    ...(input.extra ?? {}),
  };
}

export interface JoinPostInput {
  readonly app: C3FastifyApp;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly token: string;
  readonly idempotencyKey: string;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

export function postJoin(input: JoinPostInput): Promise<LightMyRequestResponse> {
  return input.app.inject({
    method: 'POST',
    url: `/user/api/v1/${input.tenantKey}/games/${input.gameId}/join`,
    headers: {
      ...c3Headers({ token: input.token, idempotencyKey: input.idempotencyKey }),
      ...(input.headers ?? {}),
    },
    payload: input.body,
  });
}

export interface JoinOperationReadInput {
  readonly app: C3FastifyApp;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly token: string;
  readonly idempotencyKey: string;
}

/** Recovery read by the ORIGINAL Idempotency-Key (never a replacement POST). */
export function getJoinOperation(input: JoinOperationReadInput): Promise<LightMyRequestResponse> {
  return input.app.inject({
    method: 'GET',
    url: `/user/api/v1/${input.tenantKey}/games/${input.gameId}/join-operation`,
    headers: {
      authorization: `Bearer ${input.token}`,
      'idempotency-key': input.idempotencyKey,
    },
  });
}

export interface GameOperationReadInput {
  readonly app: C3FastifyApp;
  readonly tenantKey: string;
  readonly operationId: string;
  readonly token: string;
}

export function getGameOperation(input: GameOperationReadInput): Promise<LightMyRequestResponse> {
  return input.app.inject({
    method: 'GET',
    url: `/user/api/v1/${input.tenantKey}/game-operations/${input.operationId}`,
    headers: { authorization: `Bearer ${input.token}` },
  });
}

export interface JoinConditionsReadInput {
  readonly app: C3FastifyApp;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly token: string;
  readonly expectedRevision: number;
  readonly subscriptionInstanceId: string;
}

export function getJoinConditions(
  input: JoinConditionsReadInput,
): Promise<LightMyRequestResponse> {
  const query =
    `?expectedRevision=${input.expectedRevision}` +
    `&subscriptionInstanceId=${input.subscriptionInstanceId}`;
  return input.app.inject({
    method: 'GET',
    url: `/user/api/v1/${input.tenantKey}/games/${input.gameId}/join-conditions${query}`,
    headers: { authorization: `Bearer ${input.token}` },
  });
}

export interface LeaveGameInput {
  readonly app: C3FastifyApp;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly token: string;
  readonly idempotencyKey: string;
}

export function leaveGame(input: LeaveGameInput): Promise<LightMyRequestResponse> {
  return input.app.inject({
    method: 'DELETE',
    url: `/user/api/v1/${input.tenantKey}/games/${input.gameId}/participants/me`,
    headers: c3Headers({ token: input.token, idempotencyKey: input.idempotencyKey }),
  });
}

// ---------------------------------------------------------------------------------------------
// Synthetic PostgreSQL fixtures/readers on the isolated C3 database
// ---------------------------------------------------------------------------------------------

/** Inserts one ACTIVE synthetic participant so a game already has one taken seat. */
export async function insertSyntheticParticipant(
  pool: Pool,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly userId: string;
    readonly role?: 'PLAYER' | 'ORGANIZER';
  },
): Promise<string> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into games.participations (tenant_id, game_id, user_id, role, state, payment_state)
       values ($1, $2, $3, $4, 'ACTIVE', 'PAID')
       returning id`,
      [input.tenantId, input.gameId, input.userId, input.role ?? 'PLAYER'],
    );
    return result.rows[0]!.id;
  });
}

export async function readGameRevision(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<number> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{ revision: string }>(
      `select revision::text from games.games where tenant_id = $1 and id = $2`,
      [input.tenantId, input.gameId],
    );
    return Number(result.rows[0]?.revision);
  });
}

/** Simulates a rules/usage-induced game revision advance without a roster write. */
export async function bumpSyntheticGameRevision(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<number> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{ revision: string }>(
      `update games.games set revision = revision + 1, updated_at = now()
        where tenant_id = $1 and id = $2
        returning revision::text`,
      [input.tenantId, input.gameId],
    );
    return Number(result.rows[0]?.revision);
  });
}

export interface SeatOccupancy {
  readonly capacity: number;
  readonly activeParticipations: number;
  readonly activeReservations: number;
}

/** Counts the seats actually consumed by ACTIVE participations plus unexpired ACTIVE reservations. */
export async function readSeatOccupancy(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<SeatOccupancy> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      capacity: number;
      active_participations: number;
      active_reservations: number;
    }>(
      `select game.capacity,
              (select count(*)::integer from games.participations participant
                where participant.tenant_id = $1 and participant.game_id = $2
                  and participant.state = 'ACTIVE') as active_participations,
              (select count(*)::integer from games.seat_reservations reservation
                where reservation.tenant_id = $1 and reservation.game_id = $2
                  and reservation.state = 'ACTIVE' and reservation.expires_at > now())
                as active_reservations
         from games.games game
        where game.tenant_id = $1 and game.id = $2`,
      [input.tenantId, input.gameId],
    );
    const row = result.rows[0]!;
    return {
      capacity: Number(row.capacity),
      activeParticipations: Number(row.active_participations),
      activeReservations: Number(row.active_reservations),
    };
  });
}

export interface LevelBlockedGameFixture {
  readonly game: SeededGame;
  readonly playerLevelId: string;
  readonly minLevelId: string;
  readonly maxLevelId: string;
  readonly levelPolicyId: string;
}

/**
 * Seeds a synthetic paid game whose canonical level range EXCLUDES the player's level, with an
 * ACTIVE BLOCK level policy, so a JOIN without a valid personal invitation is denied.
 */
export async function seedLevelBlockedPaidGame(
  pool: Pool,
  input: {
    readonly tenant: SyntheticTenant;
    readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
    readonly capacity?: number;
    readonly playerRank?: number;
    readonly minRank?: number;
    readonly maxRank?: number;
  },
): Promise<LevelBlockedGameFixture> {
  const game = await seedSyntheticGame(pool, {
    tenantId: input.tenant.tenantId,
    organizerUserId: input.tenant.organizer.userId,
    paymentMode: input.paymentMode,
    capacity: input.capacity ?? 4,
  });
  const playerRank = input.playerRank ?? 1;
  const minRank = input.minRank ?? 6;
  const maxRank = input.maxRank ?? 7;
  const seedLevel = async (client: PoolClient, rank: number): Promise<string> => {
    const result = await client.query<{ id: string }>(
      `insert into eligibility.canonical_levels (
         tenant_id, sport_code, code, title, rank, sort_order, aliases, scale_version, active
       ) values ($1, 'PADEL', $2, $3, $4, $4, '{}', 1, true)
       returning id`,
      [input.tenant.tenantId, `C3L${rank}`, `C3 SYNTHETIC level ${rank}`, rank],
    );
    return result.rows[0]!.id;
  };
  return withTenantTransaction(pool, input.tenant.tenantId, async (client) => {
    const playerLevelId = await seedLevel(client, playerRank);
    const minLevelId = await seedLevel(client, minRank);
    const maxLevelId = await seedLevel(client, maxRank);
    await client.query(
      `update games.games
          set min_level_id = $3, max_level_id = $4, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [input.tenant.tenantId, game.gameId, minLevelId, maxLevelId],
    );
    const policy = await client.query<{ id: string }>(
      `insert into eligibility.level_policies (
         tenant_id, sport_code, activity_type, mode, lower_tolerance_steps,
         upper_tolerance_steps, missing_activity_constraint_action,
         legacy_text_constraint_action, version, active
       ) values ($1, 'PADEL', 'GAME', 'BLOCK', 0, 0, 'ALLOW', 'ALLOW', 1, true)
       returning id`,
      [input.tenant.tenantId],
    );
    await client.query(
      `insert into eligibility.player_sport_levels (
         tenant_id, player_id, sport_code, level_id, source, scale_version
       ) values ($1, $2, 'PADEL', $3, 'MANUAL', 1)`,
      [input.tenant.tenantId, input.tenant.playerA.userId, playerLevelId],
    );
    return {
      game,
      playerLevelId,
      minLevelId,
      maxLevelId,
      levelPolicyId: policy.rows[0]!.id,
    };
  });
}

/** Inserts one single-use synthetic personal invitation addressed to the player for the game. */
export async function insertPersonalInvitation(
  pool: Pool,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly recipientUserId: string;
    readonly createdByUserId: string;
    readonly expiresInMs?: number;
    readonly maxUses?: number;
  },
): Promise<string> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const expiresAt = new Date(Date.now() + (input.expiresInMs ?? 60 * 60 * 1000));
    const result = await client.query<{ id: string }>(
      `insert into eligibility.personal_invitations (
         tenant_id, activity_type, activity_id, invitation_type, recipient_player_id,
         status, max_uses, use_count, expires_at, created_by
       ) values ($1, 'GAME', $2, 'PERSONAL', $3, 'ACTIVE', $4, 0, $5, $6)
       returning id`,
      [
        input.tenantId,
        input.gameId,
        input.recipientUserId,
        input.maxUses ?? 1,
        expiresAt.toISOString(),
        input.createdByUserId,
      ],
    );
    return result.rows[0]!.id;
  });
}

export interface PersonalInvitationRow {
  readonly id: string;
  readonly status: string;
  readonly useCount: number;
  readonly maxUses: number;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

export async function readPersonalInvitations(
  pool: Pool,
  input: { readonly tenantId: string; readonly invitationId: string },
): Promise<PersonalInvitationRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      status: string;
      use_count: number;
      max_uses: number;
      used_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(
      `select id, status, use_count, max_uses, used_at, revoked_at
         from eligibility.personal_invitations
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.invitationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      useCount: Number(row.use_count),
      maxUses: Number(row.max_uses),
      usedAt: row.used_at === null ? null : new Date(row.used_at).toISOString(),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    }));
  });
}

export interface EligibilityDecisionRow {
  readonly id: string;
  readonly playerId: string;
  readonly status: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly invitationId: string | null;
}

export async function readEligibilityDecisions(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<EligibilityDecisionRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      player_id: string;
      status: string;
      outcome: string;
      reason_code: string;
      invitation_id: string | null;
    }>(
      `select id, player_id, status, outcome, reason_code, invitation_id
         from eligibility.decisions
        where tenant_id = $1 and activity_id = $2 and activity_type = 'GAME'
        order by evaluated_at, id`,
      [input.tenantId, input.gameId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      playerId: row.player_id,
      status: row.status,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      invitationId: row.invitation_id,
    }));
  });
}

/** Synthetic provider identifiers for the trusted legacy confirmation channel. */
export function syntheticTrustedEvidence(amountMinor = 0) {
  return {
    provider: 'VIVA' as const,
    operationType: 'SUBSCRIPTION_BOOKING' as const,
    operationId: `c3-synthetic-provider-op-${randomUUID()}`,
    bookingId: `c3-synthetic-booking-${randomUUID()}`,
    clientPhoneE164: '+79000000009',
    evidenceHash: 'a'.repeat(64),
    verifiedAt: new Date().toISOString(),
    verifiedBy: 'LEGACY_NODE_RED' as const,
    amountMinor,
    currency: 'RUB' as const,
  };
}
