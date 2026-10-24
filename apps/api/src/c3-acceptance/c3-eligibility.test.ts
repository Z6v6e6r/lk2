/**
 * C3 independent acceptance tests — scenario B, LK2 participation-eligibility part.
 *
 * Real writer: the production `GameRosterRepository.join` (`packages/database/src/game-roster-repository.ts`)
 * over the real isolated PostgreSQL, plus the real pure join policy
 * (`assertCanJoinGameFacts`, `packages/games/src/index.ts`) and the real pure level rule
 * (`evaluateLevelEligibility`, `packages/domain/src/participation-eligibility.ts`).
 *
 * Every case asserts saved business state (eligibility.decisions, games.participations,
 * games.seat_reservations, games.command_idempotency, audit/outbox rows, aggregate revision),
 * not only the returned value. Refusals may write audit/command rows but must never create a
 * participation, a reservation or an outbox event.
 *
 * Evidence level: LOCAL. No provider/staging/production calls and no live data.
 * All fixtures are SYNTHETIC (`C3 SYNTHETIC`); no numeric product threshold from a live tariff
 * is asserted here. Level boundaries come from the synthetic game's own configured range.
 */

import { randomUUID } from 'node:crypto';

import {
  evaluateLevelEligibility,
  levelResultAllowsParticipation,
  type LevelEligibilityPolicy,
} from '@phub/domain';
import { createGameRosterRepository, withTenantTransaction } from '@phub/database';
import { GameDomainError, assertCanJoinGameFacts, type GameRosterCommandFacts } from '@phub/games';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';

import {
  C3_FIXTURE_VERSION,
  c3DatabaseUrl,
  commandMeta,
  describeDb,
  readAuditRows,
  readEligibilityDecisions,
  readGame,
  readGameState,
  readInvitation,
  readPaymentSnapshots,
  sampleDatabaseNow,
  seedGame,
  seedInvitation,
  seedTenant,
  setPlayerLevel,
  upsertLevelPolicy,
  type C3Actor,
  type C3PaymentMode,
  type LevelCode,
  type SeededGame,
  type SyntheticTenant,
} from './c3-db-fixtures.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Fail-closed policy used by the synthetic tenant: no tolerance, BLOCK mode, version 1. */
const BLOCK_POLICY: LevelEligibilityPolicy = {
  mode: 'BLOCK',
  lowerToleranceSteps: 0,
  upperToleranceSteps: 0,
  missingActivityConstraintAction: 'ALLOW',
  legacyTextConstraintAction: 'ALLOW',
  version: 1,
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function domainErrorCode(operation: () => void): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    if (error instanceof GameDomainError) return error.code;
    throw error;
  }
}

/** Moscow wall clock with explicit +03:00 offset (Europe/Moscow has no DST since 2014). */
function moscowWallClock(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}+03:00`;
}

function moscowDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addIsoDays(isoDate: string, days: number): string {
  const shifted = new Date(`${isoDate}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function defaultWindow(): { startsAt: Date; joinCutoffAt: Date } {
  const startsAt = new Date(Date.now() + 2 * HOUR_MS);
  return { startsAt, joinCutoffAt: new Date(startsAt.getTime() - HOUR_MS) };
}

describeDb(
  'C3 acceptance — scenario B: LK2 eligibility (level / invitation / term / day / revision)',
  () => {
    const pool = new Pool({ connectionString: c3DatabaseUrl(), max: 6 });
    const roster = createGameRosterRepository(pool);
    afterAll(async () => {
      await pool.end();
    });

    it('records fixture version for comparability', () => {
      expect(C3_FIXTURE_VERSION).toBe('c3-2026-10-21.1');
    });

    interface CaseContext {
      readonly tenant: SyntheticTenant;
      readonly game: SeededGame;
      readonly policyVersion: number;
    }

    async function blockedCase(options: {
      label: string;
      levelFrom?: LevelCode;
      levelTo?: LevelCode;
      playerCount?: number;
      sportCodes?: readonly string[];
      startsAt?: Date;
      joinCutoffAt?: Date | null;
      lifecycleState?: 'DRAFT' | 'SCHEDULED';
      paymentMode?: C3PaymentMode;
    }): Promise<CaseContext> {
      const tenant = await seedTenant(pool, {
        label: options.label,
        playerCount: options.playerCount ?? 4,
        ...(options.sportCodes === undefined ? {} : { sportCodes: options.sportCodes }),
      });
      const policy = await upsertLevelPolicy(pool, {
        tenantId: tenant.tenantId,
        mode: BLOCK_POLICY.mode,
        version: BLOCK_POLICY.version,
      });
      const window = defaultWindow();
      const startsAt = options.startsAt ?? window.startsAt;
      const joinCutoffAt =
        options.joinCutoffAt === undefined ? window.joinCutoffAt : options.joinCutoffAt;
      const game = await seedGame(pool, {
        tenantId: tenant.tenantId,
        organizerUserId: tenant.organizer.userId,
        startsAt,
        joinCutoffAt,
        ...(options.levelFrom === undefined ? {} : { levelFrom: options.levelFrom }),
        ...(options.levelTo === undefined ? {} : { levelTo: options.levelTo }),
        ...(options.lifecycleState === undefined ? {} : { lifecycleState: options.lifecycleState }),
        ...(options.paymentMode === undefined ? {} : { paymentMode: options.paymentMode }),
      });
      return { tenant, game, policyVersion: policy.version };
    }

    interface JoinOptions {
      label?: string;
      correlationId?: string;
      expectedRevision?: number;
      invitationId?: string;
    }

    async function joinGame(
      context: CaseContext,
      actor: C3Actor,
      options: JoinOptions = {},
    ): Promise<Awaited<ReturnType<typeof roster.join>>> {
      const meta = commandMeta(options.label ?? 'case');
      return roster.join({
        tenantId: context.tenant.tenantId,
        actorUserId: actor.userId,
        gameId: context.game.gameId,
        idempotencyKey: meta.idempotencyKey,
        requestHash: meta.requestHash,
        correlationId: options.correlationId ?? meta.correlationId,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
        ...(options.invitationId === undefined ? {} : { invitationId: options.invitationId }),
      });
    }

    /**
     * SYNTHETIC server-side price echo for the paid-JOIN writer. The amounts below are fixture
     * values, not a live tariff; the free-minute length only mirrors the approved 60 min/day rule.
     */
    function syntheticPrice(): {
      amountMinor: number;
      currency: 'RUB';
      basePriceMinor: number;
      freeMinutes: number;
      paidMinutes: number;
      evaluatedAt: string;
      expiresAt: string;
    } {
      return {
        amountMinor: 0,
        currency: 'RUB',
        basePriceMinor: 350_000,
        freeMinutes: 60,
        paidMinutes: 0,
        evaluatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    }

    async function beginPaidJoin(
      context: CaseContext,
      actor: C3Actor,
      options: { label?: string; operationId?: string; expectedRevision?: number } = {},
    ): Promise<Awaited<ReturnType<typeof roster.beginPaidJoin>>> {
      const meta = commandMeta(options.label ?? 'paid');
      return roster.beginPaidJoin({
        tenantId: context.tenant.tenantId,
        actorUserId: actor.userId,
        gameId: context.game.gameId,
        idempotencyKey: meta.idempotencyKey,
        requestHash: meta.requestHash,
        correlationId: meta.correlationId,
        expectedRevision: options.expectedRevision ?? 1,
        operationId: options.operationId ?? randomUUID(),
        subscriptionInstanceId: randomUUID(),
        price: syntheticPrice(),
        reservationTtlSeconds: 300,
      });
    }

    function expectApplied(
      result: Awaited<ReturnType<typeof roster.join>>,
      revision: number,
    ): void {
      expect(result).toMatchObject({ outcome: 'applied', revision, replayed: false });
    }

    function expectRejected(
      result: Awaited<ReturnType<typeof roster.join>>,
      code: string,
      currentRevision: number,
    ): void {
      expect(result).toMatchObject({ outcome: 'rejected', code, currentRevision, replayed: false });
    }

    async function decisionsForGame(
      tenant: SyntheticTenant,
      game: SeededGame,
    ): Promise<Awaited<ReturnType<typeof readEligibilityDecisions>>> {
      return readEligibilityDecisions(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    }

    // ---------------------------------------------------------------------------------------------
    // B1 — level boundaries through the real writer
    // ---------------------------------------------------------------------------------------------

    it('B1a allows a player exactly at the configured levelFrom edge (inclusive) and persists the decision', async () => {
      const context = await blockedCase({ label: 'b1a', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
      });

      const result = await joinGame(context, player, { label: 'b1a' });
      expectApplied(result, 2);

      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(2);
      expect(state.participations).toHaveLength(1);
      expect(state.participations[0]).toMatchObject({
        userId: player.userId,
        state: 'ACTIVE',
        role: 'PLAYER',
      });
      expect(state.reservations).toHaveLength(0);
      expect(state.decisions).toHaveLength(1);
      const decision = state.decisions[0]!;
      expect(decision).toMatchObject({
        playerId: player.userId,
        action: 'JOIN',
        status: 'ALLOWED',
        outcome: 'PASS',
        reasonCode: 'LEVEL_ALLOWED',
        policyVersion: context.policyVersion,
        levelScaleVersion: 1,
        constraintSource: 'CANONICAL',
        invitationId: null,
      });
      expect(decision.details).toMatchObject({
        configuredMinRank: 3,
        configuredMaxRank: 4,
        effectiveMinRank: 3,
        effectiveMaxRank: 4,
        playerRank: 3,
      });
      expect(state.participations[0]!.eligibilityDecisionId).toBe(decision.id);
      expect(state.outbox.map((event) => event.eventType)).toEqual([
        'game.participation.confirmed.v1',
      ]);
      expect(state.commands.map((row) => row.state)).toEqual(['COMPLETED']);
    });

    it('B1b allows a player exactly at the configured levelTo edge (inclusive)', async () => {
      const context = await blockedCase({ label: 'b1b', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C+',
      });

      expectApplied(await joinGame(context, player, { label: 'b1b' }), 2);
      const [decision] = await decisionsForGame(context.tenant, context.game);
      expect(decision).toMatchObject({
        playerId: player.userId,
        status: 'ALLOWED',
        outcome: 'PASS',
        reasonCode: 'LEVEL_ALLOWED',
      });
      expect(decision?.details).toMatchObject({ playerRank: 4 });
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([player.userId]);
      expect(state.game?.revision).toBe(2);
    });

    it('B1c denies one level below the configured range with LEVEL_NOT_ALLOWED and no roster write', async () => {
      const context = await blockedCase({ label: 'b1c', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'D+',
      });
      const correlationId = `c3-corr-b1c-${context.game.gameId}`;

      expectRejected(
        await joinGame(context, player, { label: 'b1c', correlationId }),
        'LEVEL_NOT_ALLOWED',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(1);
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        playerId: player.userId,
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
        policyVersion: context.policyVersion,
      });
      expect(state.decisions[0]!.details).toMatchObject({
        configuredMinRank: 3,
        configuredMaxRank: 4,
        effectiveMinRank: 3,
        effectiveMaxRank: 4,
        playerRank: 2,
      });
      expect(
        state.commands.filter((row) => row.state === 'FAILED').map((row) => row.errorCode),
      ).toEqual(['LEVEL_NOT_ALLOWED']);
      const audit = await readAuditRows(pool, { tenantId: context.tenant.tenantId, correlationId });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: player.userId,
        action: 'GAME_JOIN_V1',
        result: 'REJECTED',
        reason: 'LEVEL_NOT_ALLOWED',
        correlationId,
      });
    });

    it('B1d denies one level above the configured range with LEVEL_NOT_ALLOWED and no roster write', async () => {
      const context = await blockedCase({ label: 'b1d', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'B',
      });

      expectRejected(await joinGame(context, player, { label: 'b1d' }), 'LEVEL_NOT_ALLOWED', 1);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(state.decisions[0]).toMatchObject({
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
      });
      expect(state.decisions[0]!.details).toMatchObject({ playerRank: 5 });
    });

    it('B1e denies a player with a missing level with PLAYER_LEVEL_REQUIRED (no crash, no write)', async () => {
      const context = await blockedCase({ label: 'b1e', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;

      expectRejected(await joinGame(context, player, { label: 'b1e' }), 'PLAYER_LEVEL_REQUIRED', 1);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        playerId: player.userId,
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'PLAYER_LEVEL_REQUIRED',
        invitationId: null,
      });
      expect(
        state.commands.filter((row) => row.state === 'FAILED').map((row) => row.errorCode),
      ).toEqual(['PLAYER_LEVEL_REQUIRED']);
    });

    it('B1f does not let a foreign-sport level satisfy the game range (DB) and the domain rule reports LEVEL_SPORT_MISMATCH', async () => {
      const context = await blockedCase({
        label: 'b1f',
        levelFrom: 'C',
        levelTo: 'C+',
        sportCodes: ['PADEL', 'TENNIS'],
      });
      const player = context.tenant.players[0]!;
      // The synthetic player holds a TENNIS level only. The writer resolves the level for the
      // GAME's sport (PADEL), so the foreign level can never be read as a matching one.
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
        sportCode: 'TENNIS',
      });

      const result = await joinGame(context, player, { label: 'b1f' });
      expectRejected(result, 'PLAYER_LEVEL_REQUIRED', 1);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(state.decisions[0]).toMatchObject({
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'PLAYER_LEVEL_REQUIRED',
      });

      // Defense in depth: the pure rule distinguishes an explicitly mismatched sport and fails closed.
      const mismatch = evaluateLevelEligibility(
        {
          action: 'JOIN',
          activityType: 'GAME',
          activityId: context.game.gameId,
          sportId: 'PADEL',
          playerId: player.userId,
          playerLevel: {
            playerId: player.userId,
            sportId: 'TENNIS',
            levelId: 'c3-synthetic-tennis-level',
            rank: 3,
            source: 'CALCULATED',
            scaleVersion: 1,
          },
          activityLevelConstraint: {
            mode: 'RANGE',
            minRank: 3,
            maxRank: 4,
            source: 'CANONICAL',
            dataQuality: 'VALID',
            scaleVersion: 1,
          },
        },
        BLOCK_POLICY,
      );
      expect(mismatch).toMatchObject({ outcome: 'FAIL', reasonCode: 'LEVEL_SPORT_MISMATCH' });
      expect(levelResultAllowsParticipation(mismatch)).toBe(false);
    });

    it('B1g fails closed on a misconfigured policy (domain rule) and the schema refuses to persist one (DB)', async () => {
      const context = await blockedCase({ label: 'b1g', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;

      const misconfiguredPolicy = (
        overrides: Partial<LevelEligibilityPolicy>,
      ): LevelEligibilityPolicy => ({
        ...BLOCK_POLICY,
        ...overrides,
      });
      const levelContext = {
        action: 'JOIN' as const,
        activityType: 'GAME' as const,
        activityId: context.game.gameId,
        sportId: 'PADEL',
        playerId: player.userId,
        playerLevel: {
          playerId: player.userId,
          sportId: 'PADEL',
          levelId: 'c3-synthetic-level',
          rank: 3,
          source: 'CALCULATED' as const,
          scaleVersion: 1,
        },
        activityLevelConstraint: {
          mode: 'RANGE' as const,
          minRank: 3,
          maxRank: 4,
          source: 'CANONICAL' as const,
          dataQuality: 'VALID' as const,
          scaleVersion: 1,
        },
      };
      for (const policy of [
        misconfiguredPolicy({ version: -1 }),
        misconfiguredPolicy({ version: Number.NaN }),
        misconfiguredPolicy({ lowerToleranceSteps: -1 }),
        misconfiguredPolicy({ upperToleranceSteps: Number.NaN }),
      ]) {
        const decision = evaluateLevelEligibility(levelContext, policy);
        expect(decision).toMatchObject({
          outcome: 'FAIL',
          reasonCode: 'LEVEL_POLICY_MISCONFIGURED',
        });
        expect(levelResultAllowsParticipation(decision)).toBe(false);
      }

      // The database schema itself cannot store such a policy, so a misconfiguration cannot reach
      // the join writer through a valid migration/write path.
      await expect(
        withTenantTransaction(pool, context.tenant.tenantId, (client) =>
          client.query(
            `insert into eligibility.level_policies (tenant_id, sport_code, activity_type, mode, version)
           values ($1, 'TENNIS', 'GAME', 'BLOCK', $2)`,
            [context.tenant.tenantId, 0],
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        withTenantTransaction(pool, context.tenant.tenantId, (client) =>
          client.query(
            `insert into eligibility.level_policies (
             tenant_id, sport_code, activity_type, mode, lower_tolerance_steps, version
           ) values ($1, 'TENNIS', 'GAME', 'BLOCK', -1, 2)`,
            [context.tenant.tenantId],
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);

      // No join was attempted above, so the game has no write.
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(1);
      expect(state.participations).toHaveLength(0);
      expect(state.decisions).toHaveLength(0);
    });

    it('B1h allows a game without a level restriction (ACTIVITY_HAS_NO_LEVEL_RESTRICTION) and persists the decision', async () => {
      const context = await blockedCase({ label: 'b1h' });
      const player = context.tenant.players[0]!;

      expectApplied(await joinGame(context, player, { label: 'b1h' }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(1);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        status: 'ALLOWED',
        outcome: 'PASS',
        reasonCode: 'ACTIVITY_HAS_NO_LEVEL_RESTRICTION',
        levelScaleVersion: null,
      });
      expect(state.game?.revision).toBe(2);
    });

    // ---------------------------------------------------------------------------------------------
    // B1 (paid-JOIN writer) — reservation path presence/absence for the same level rule
    // ---------------------------------------------------------------------------------------------

    it('B1i paid-JOIN writer refuses an under-level player with LEVEL_NOT_ALLOWED and creates no reservation', async () => {
      const context = await blockedCase({
        label: 'b1i',
        levelFrom: 'C',
        levelTo: 'C+',
        paymentMode: 'SUBSCRIPTION',
      });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'D+',
      });

      const result = await beginPaidJoin(context, player, { label: 'b1i' });
      expect(result).toMatchObject({
        outcome: 'rejected',
        code: 'LEVEL_NOT_ALLOWED',
        currentRevision: 1,
      });

      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(1);
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        playerId: player.userId,
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
      });
      const snapshots = await readPaymentSnapshots(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(snapshots).toHaveLength(0);
    });

    it('B1j paid-JOIN writer reserves a seat exactly at the levelFrom edge and links decision, snapshot and attempt', async () => {
      const context = await blockedCase({
        label: 'b1j',
        levelFrom: 'C',
        levelTo: 'C+',
        paymentMode: 'SUBSCRIPTION',
      });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
      });
      const operationId = randomUUID();

      const result = await beginPaidJoin(context, player, { label: 'b1j', operationId });
      expect(result).toMatchObject({ outcome: 'reserved', operationId, revision: 2 });
      if (result.outcome !== 'reserved') throw new Error('C3_PAID_JOIN_NOT_RESERVED');

      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(2);
      // A paid JOIN reserves a seat first; the participation appears only after trusted confirmation.
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(1);
      expect(state.reservations[0]).toMatchObject({
        id: result.reservationId,
        userId: player.userId,
        state: 'ACTIVE',
        paymentState: 'PROCESSING',
        eligibilityDecisionId: result.eligibilityDecisionId,
      });
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        id: result.eligibilityDecisionId,
        playerId: player.userId,
        status: 'ALLOWED',
        outcome: 'PASS',
        reasonCode: 'LEVEL_ALLOWED',
      });
      expect(state.commands).toHaveLength(1);
      expect(state.commands[0]).toMatchObject({
        id: operationId,
        actorUserId: player.userId,
        commandType: 'game.join.paid.v1',
        state: 'IN_PROGRESS',
        aggregateId: context.game.gameId,
      });
      expect(state.outbox.map((event) => event.eventType)).toEqual([
        'game.participation.reserved.v1',
      ]);
      const snapshots = await readPaymentSnapshots(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        operationId,
        decisionId: result.eligibilityDecisionId,
        playerId: player.userId,
        activityId: context.game.gameId,
      });
      expect(snapshots[0]!.snapshot).toMatchObject({
        operationId,
        decisionId: result.eligibilityDecisionId,
        paymentMode: 'SUBSCRIPTION',
      });
    });

    it('B1k paid-JOIN writer refuses a player with a missing level with PLAYER_LEVEL_REQUIRED and no reservation', async () => {
      const context = await blockedCase({
        label: 'b1k',
        levelFrom: 'C',
        levelTo: 'C+',
        paymentMode: 'SUBSCRIPTION',
      });
      const player = context.tenant.players[0]!;

      const result = await beginPaidJoin(context, player, { label: 'b1k' });
      expect(result).toMatchObject({
        outcome: 'rejected',
        code: 'PLAYER_LEVEL_REQUIRED',
        currentRevision: 1,
      });
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({
        status: 'DENIED',
        outcome: 'FAIL',
        reasonCode: 'PLAYER_LEVEL_REQUIRED',
      });
      const snapshots = await readPaymentSnapshots(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(snapshots).toHaveLength(0);
    });

    // ---------------------------------------------------------------------------------------------
    // B2 — personal invitation bypass
    // ---------------------------------------------------------------------------------------------

    it('B2a lets a valid personal invitation bypass the level rule exactly once (PERSONAL_INVITE_BYPASS)', async () => {
      const context = await blockedCase({ label: 'b2a', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'D',
      });
      const invitationId = await seedInvitation(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
        recipientPlayerId: player.userId,
        createdBy: context.tenant.organizer.userId,
      });

      expectApplied(await joinGame(context, player, { label: 'b2a', invitationId }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(1);
      expect(state.decisions).toHaveLength(1);
      const decision = state.decisions[0]!;
      expect(decision).toMatchObject({
        playerId: player.userId,
        status: 'ALLOWED',
        outcome: 'BYPASS',
        reasonCode: 'PERSONAL_INVITE_BYPASS',
        invitationId,
      });
      expect(decision.details).toMatchObject({ invitationId });
      expect(state.participations[0]!.eligibilityDecisionId).toBe(decision.id);
      expect(state.game?.revision).toBe(2);

      const invitation = await readInvitationRow(context.tenant.tenantId, invitationId);
      expect(invitation).toMatchObject({
        gameId: context.game.gameId,
        recipientPlayerId: player.userId,
        status: 'USED',
        maxUses: 1,
        useCount: 1,
      });
      expect(invitation?.usedAt).not.toBeNull();
    });

    it('B2b refuses to reuse a personal invitation for a different player and keeps it unconsumed', async () => {
      const context = await blockedCase({ label: 'b2b', levelFrom: 'C', levelTo: 'C+' });
      const owner = context.tenant.players[0]!;
      const foreign = context.tenant.players[1]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: foreign.userId,
        code: 'D+',
      });
      const invitationId = await seedInvitation(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
        recipientPlayerId: owner.userId,
        createdBy: context.tenant.organizer.userId,
      });

      expectRejected(
        await joinGame(context, foreign, { label: 'b2b', invitationId }),
        'LEVEL_NOT_ALLOWED',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(state.decisions[0]).toMatchObject({
        playerId: foreign.userId,
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
        invitationId: null,
      });
      const invitation = await readInvitationRow(context.tenant.tenantId, invitationId);
      expect(invitation).toMatchObject({ status: 'ACTIVE', useCount: 0, usedAt: null });
    });

    it('B2c does not let an expired personal invitation bypass the level rule', async () => {
      const context = await blockedCase({ label: 'b2c', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'D+',
      });
      const invitationId = await seedInvitation(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
        recipientPlayerId: player.userId,
        createdBy: context.tenant.organizer.userId,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      });

      expectRejected(
        await joinGame(context, player, { label: 'b2c', invitationId }),
        'LEVEL_NOT_ALLOWED',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.decisions[0]).toMatchObject({
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
        invitationId: null,
      });
      const invitation = await readInvitationRow(context.tenant.tenantId, invitationId);
      // Expiry is evaluated by the writer; the persisted consumed counter must not move.
      expect(invitation).toMatchObject({ status: 'ACTIVE', useCount: 0 });
    });

    it('B2d cannot reuse an already consumed personal invitation (status USED, use_count 1)', async () => {
      const context = await blockedCase({ label: 'b2d', levelFrom: 'C', levelTo: 'C+' });
      const first = context.tenant.players[0]!;
      const second = context.tenant.players[1]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: first.userId,
        code: 'D',
      });
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: second.userId,
        code: 'D+',
      });
      const invitationId = await seedInvitation(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
        recipientPlayerId: first.userId,
        createdBy: context.tenant.organizer.userId,
      });
      expectApplied(await joinGame(context, first, { label: 'b2d1', invitationId }), 2);

      expectRejected(
        await joinGame(context, second, { label: 'b2d2', invitationId }),
        'LEVEL_NOT_ALLOWED',
        2,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([first.userId]);
      expect(state.game?.revision).toBe(2);
      expect(state.decisions).toHaveLength(2);
      const secondDecision = state.decisions.find((row) => row.playerId === second.userId);
      expect(secondDecision).toMatchObject({
        outcome: 'FAIL',
        reasonCode: 'LEVEL_NOT_ALLOWED',
        invitationId: null,
      });
      const invitation = await readInvitationRow(context.tenant.tenantId, invitationId);
      expect(invitation).toMatchObject({ status: 'USED', useCount: 1, maxUses: 1 });
      expect(invitation?.recipientPlayerId).toBe(first.userId);
    });

    it('B2e does not let an unknown invitation id bypass the level rule (no crash, no write)', async () => {
      const context = await blockedCase({ label: 'b2e', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'D+',
      });
      const unknownInvitationId = '00000000-0000-4000-8000-00000000c3c3';

      expectRejected(
        await joinGame(context, player, { label: 'b2e', invitationId: unknownInvitationId }),
        'LEVEL_NOT_ALLOWED',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(state.decisions[0]).toMatchObject({ outcome: 'FAIL', invitationId: null });
    });

    async function readInvitationRow(
      tenantId: string,
      invitationId: string,
    ): Promise<
      | {
          gameId: string;
          recipientPlayerId: string;
          status: string;
          maxUses: number;
          useCount: number;
          usedAt: string | null;
        }
      | undefined
    > {
      const row = await readInvitation(pool, { tenantId, invitationId });
      if (!row) return undefined;
      return {
        gameId: row.activityId,
        recipientPlayerId: row.recipientPlayerId,
        status: row.status,
        maxUses: row.maxUses,
        useCount: row.useCount,
        usedAt: row.usedAt,
      };
    }

    // ---------------------------------------------------------------------------------------------
    // B_TERM — product term/activity boundaries (join cutoff, starts_at, lifecycle)
    // ---------------------------------------------------------------------------------------------

    it('B_TERMa joins a future game before its cutoff', async () => {
      const context = await blockedCase({ label: 'terma', levelFrom: 'C', levelTo: 'C+' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
      });
      const before = await readGame(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(before?.joinCutoffAt).not.toBeNull();

      expectApplied(await joinGame(context, player, { label: 'terma' }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([player.userId]);
      expect(state.decisions[0]).toMatchObject({ outcome: 'PASS', reasonCode: 'LEVEL_ALLOWED' });
      expect(state.game?.revision).toBe(2);
    });

    it('B_TERMb refuses the join at the recorded cutoff instant and 1 ms after it (GAME_JOIN_CUTOFF_PASSED)', async () => {
      const boundary = await sampleDatabaseNow(pool);
      const context = await blockedCase({ label: 'termb' });
      const atPlayer = context.tenant.players[0]!;
      const afterPlayer = context.tenant.players[1]!;

      // Synthetic boundary game: cutoff at the recorded DB instant (no client clock involved).
      const atBoundary = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(boundary.getTime() + HOUR_MS),
        endsAt: new Date(boundary.getTime() + 2 * HOUR_MS),
        joinCutoffAt: new Date(boundary.getTime()),
      });
      expectRejected(
        await joinGame({ ...context, game: atBoundary }, atPlayer, { label: 'termb-at' }),
        'GAME_JOIN_CUTOFF_PASSED',
        1,
      );

      const oneMsAfter = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(boundary.getTime() + HOUR_MS),
        endsAt: new Date(boundary.getTime() + 2 * HOUR_MS),
        joinCutoffAt: new Date(boundary.getTime() + 1),
      });
      expectRejected(
        await joinGame({ ...context, game: oneMsAfter }, afterPlayer, { label: 'termb-after' }),
        'GAME_JOIN_CUTOFF_PASSED',
        1,
      );
      for (const game of [atBoundary, oneMsAfter]) {
        const state = await readGameState(pool, {
          tenantId: context.tenant.tenantId,
          gameId: game.gameId,
        });
        expect(state.game?.revision).toBe(1);
        expect(state.participations).toHaveLength(0);
        expect(state.reservations).toHaveLength(0);
        expect(state.outbox).toHaveLength(0);
        expect(state.decisions).toHaveLength(0);
        expect(
          state.commands.filter((row) => row.state === 'FAILED').map((row) => row.errorCode),
        ).toEqual(['GAME_JOIN_CUTOFF_PASSED']);
      }

      // Exact equality is the boundary: the shipped policy refuses `now >= cutoff` and `now >= startsAt`.
      const exactFacts: GameRosterCommandFacts = {
        lifecycleState: 'SCHEDULED',
        startsAt: '2026-11-01T00:00:01+03:00',
        joinCutoffAt: '2026-10-31T23:59:59+03:00',
        capacity: 4,
        activeParticipantCount: 0,
        activeReservationCount: 0,
        waitlistEnabled: false,
        viewerRelation: 'NONE',
      };
      expect(
        domainErrorCode(() => assertCanJoinGameFacts(exactFacts, '2026-10-31T23:59:59+03:00')),
      ).toBe('GAME_JOIN_CUTOFF_PASSED');
      expect(
        domainErrorCode(() => assertCanJoinGameFacts(exactFacts, '2026-10-31T23:59:58.999+03:00')),
      ).toBeUndefined();
    });

    it('B_TERMc refuses the join when starts_at is already in the past', async () => {
      const past = new Date(Date.now() - 5 * MINUTE_MS);
      const context = await blockedCase({ label: 'termc' });
      const game = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: past,
        endsAt: new Date(past.getTime() + 90 * MINUTE_MS),
        joinCutoffAt: new Date(past.getTime() - 5 * MINUTE_MS),
      });
      const player = context.tenant.players[0]!;

      expectRejected(
        await joinGame({ ...context, game }, player, { label: 'termc' }),
        'GAME_JOIN_CUTOFF_PASSED',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(state.decisions).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
    });

    it('B_TERMd writes nothing after the cutoff passes (live crossing of the boundary)', async () => {
      const context = await blockedCase({ label: 'termd' });
      const before = context.tenant.players[0]!;
      const after = context.tenant.players[1]!;
      const cutoff = new Date(Date.now() + 1_500);
      const live = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(cutoff.getTime() + HOUR_MS),
        endsAt: new Date(cutoff.getTime() + 2 * HOUR_MS),
        joinCutoffAt: cutoff,
      });
      const liveContext: CaseContext = { ...context, game: live };

      expectApplied(await joinGame(liveContext, before, { label: 'termd-before' }), 2);

      const waitMs = cutoff.getTime() - Date.now() + 300;
      if (waitMs > 0) await sleep(waitMs);

      expectRejected(
        await joinGame(liveContext, after, { label: 'termd-after' }),
        'GAME_JOIN_CUTOFF_PASSED',
        2,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: live.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([before.userId]);
      expect(state.game?.revision).toBe(2);
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({ playerId: before.userId, outcome: 'PASS' });
      expect(state.outbox).toHaveLength(1);
      const failed = state.commands.filter((row) => row.state === 'FAILED');
      expect(failed.map((row) => row.errorCode)).toEqual(['GAME_JOIN_CUTOFF_PASSED']);
      expect(state.commands).toHaveLength(2);
    }, 20_000);

    it('B_TERMe refuses a game that is not SCHEDULED with the stable GAME_NOT_JOINABLE code', async () => {
      const context = await blockedCase({ label: 'terme', lifecycleState: 'DRAFT' });
      const player = context.tenant.players[0]!;

      expectRejected(await joinGame(context, player, { label: 'terme' }), 'GAME_NOT_JOINABLE', 1);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(state.decisions).toHaveLength(0);
      expect(state.game?.revision).toBe(1);
      expect(
        state.commands.filter((row) => row.state === 'FAILED').map((row) => row.errorCode),
      ).toEqual(['GAME_NOT_JOINABLE']);
    });

    it('B_TERMf joins a future game without an explicit cutoff (starts_at is the only boundary)', async () => {
      const context = await blockedCase({ label: 'termf' });
      const game = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(Date.now() + 2 * HOUR_MS),
        endsAt: new Date(Date.now() + 3 * HOUR_MS),
        joinCutoffAt: null,
      });
      expect(
        (await readGame(pool, { tenantId: context.tenant.tenantId, gameId: game.gameId }))
          ?.joinCutoffAt,
      ).toBeNull();
      const player = context.tenant.players[0]!;

      expectApplied(await joinGame({ ...context, game }, player, { label: 'termf' }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: game.gameId,
      });
      expect(state.participations).toHaveLength(1);
      expect(state.decisions).toHaveLength(1);
    });

    // ---------------------------------------------------------------------------------------------
    // B_DAY — business-day / game-timezone boundary (local midnight Europe/Moscow)
    // ---------------------------------------------------------------------------------------------

    it('B_DAYa stores the local-midnight boundary in the game timezone and joins before it', async () => {
      const context = await blockedCase({ label: 'daya' });
      // Local midnight boundary in Europe/Moscow, two days ahead so the game is joinable now.
      const localDay = moscowDate(new Date(Date.now() + 2 * 86_400_000));
      const previousLocalDay = addIsoDays(localDay, -1);
      const joinCutoffLocal = `${previousLocalDay}T23:59:59+03:00`;
      const startsLocal = `${localDay}T00:00:01+03:00`;
      const game = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(startsLocal),
        endsAt: new Date(new Date(startsLocal).getTime() + HOUR_MS),
        joinCutoffAt: new Date(joinCutoffLocal),
        timezone: 'Europe/Moscow',
      });
      const snapshot = await readGame(pool, {
        tenantId: context.tenant.tenantId,
        gameId: game.gameId,
      });
      expect(snapshot).toMatchObject({
        timezone: 'Europe/Moscow',
        startsLocal: `${localDay} 00:00:01`,
        joinCutoffLocal: `${previousLocalDay} 23:59:59`,
      });
      // The same instant must be stored as the UTC equivalent of the Moscow wall clock:
      // local midnight starts at 21:00Z of the previous UTC day.
      expect(snapshot?.startsAt).toBe(`${previousLocalDay}T21:00:01.000Z`);
      expect(snapshot?.joinCutoffAt).toBe(`${previousLocalDay}T20:59:59.000Z`);

      const player = context.tenant.players[0]!;
      expectApplied(await joinGame({ ...context, game }, player, { label: 'daya' }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: game.gameId,
      });
      expect(state.participations).toHaveLength(1);
      expect(state.decisions[0]).toMatchObject({ status: 'ALLOWED', outcome: 'PASS' });
    });

    it('B_DAYb evaluates the cutoff as an absolute instant, not as a UTC wall clock (observed false-pass trap)', async () => {
      const context = await blockedCase({ label: 'dayb' });
      const before = context.tenant.players[0]!;
      const after = context.tenant.players[1]!;
      const reference = await sampleDatabaseNow(pool);
      const cutoff = new Date(reference.getTime() + 1_500);
      const cutoffLocalWallClock = moscowWallClock(cutoff); // e.g. 2026-10-21T11:31:00.500+03:00
      expect(new Date(cutoffLocalWallClock).toISOString()).toBe(cutoff.toISOString());

      // Same instant, two legal spellings: local Moscow wall clock and UTC `Z` form.
      const localGame = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(cutoff.getTime() + HOUR_MS),
        endsAt: new Date(cutoff.getTime() + 2 * HOUR_MS),
        joinCutoffAt: new Date(cutoffLocalWallClock),
        timezone: 'Europe/Moscow',
      });
      const utcGame = await seedGame(pool, {
        tenantId: context.tenant.tenantId,
        organizerUserId: context.tenant.organizer.userId,
        startsAt: new Date(cutoff.getTime() + HOUR_MS),
        endsAt: new Date(cutoff.getTime() + 2 * HOUR_MS),
        joinCutoffAt: cutoff,
        timezone: 'Europe/Moscow',
      });
      const localSnapshot = await readGame(pool, {
        tenantId: context.tenant.tenantId,
        gameId: localGame.gameId,
      });
      const utcSnapshot = await readGame(pool, {
        tenantId: context.tenant.tenantId,
        gameId: utcGame.gameId,
      });
      expect(localSnapshot?.joinCutoffAt).toBe(cutoff.toISOString());
      expect(utcSnapshot?.joinCutoffAt).toBe(cutoff.toISOString());
      expect(localSnapshot?.joinCutoffLocal).toBe(utcSnapshot?.joinCutoffLocal);

      expectApplied(
        await joinGame({ ...context, game: localGame }, before, { label: 'dayb-before' }),
        2,
      );
      const waitMs = cutoff.getTime() - Date.now() + 300;
      if (waitMs > 0) await sleep(waitMs);
      expectRejected(
        await joinGame({ ...context, game: utcGame }, after, { label: 'dayb-after' }),
        'GAME_JOIN_CUTOFF_PASSED',
        1,
      );

      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: utcGame.gameId,
      });
      expect(state.participations).toHaveLength(0);
      expect(state.game?.revision).toBe(1);

      // False-pass trap: a comparator that ignores the +03:00 offset and parses the same wall clock
      // as UTC would place the boundary three hours later and would have allowed this join.
      const naiveUtcCutoff = Date.parse(cutoffLocalWallClock.replace('+03:00', 'Z'));
      expect(naiveUtcCutoff - cutoff.getTime()).toBe(3 * HOUR_MS);
      expect(Date.now()).toBeLessThan(naiveUtcCutoff);
    }, 20_000);

    it('B_DAYc applies the local-midnight boundary deterministically in the game timezone (UTC-naive comparison would pass)', () => {
      const facts = (overrides: Partial<GameRosterCommandFacts> = {}): GameRosterCommandFacts => ({
        lifecycleState: 'SCHEDULED',
        startsAt: '2026-11-01T00:00:01+03:00', // 2026-10-31T21:00:01Z
        joinCutoffAt: '2026-10-31T23:59:59+03:00', // 2026-10-31T20:59:59Z
        capacity: 4,
        activeParticipantCount: 0,
        activeReservationCount: 0,
        waitlistEnabled: false,
        viewerRelation: 'NONE',
        ...overrides,
      });

      // 1 s before local midnight: allowed.
      expect(
        domainErrorCode(() => assertCanJoinGameFacts(facts(), '2026-10-31T23:59:58+03:00')),
      ).toBeUndefined();
      // Exact local-midnight-less-one-second boundary: equality is refused.
      expect(
        domainErrorCode(() => assertCanJoinGameFacts(facts(), '2026-10-31T23:59:59+03:00')),
      ).toBe('GAME_JOIN_CUTOFF_PASSED');
      // Just after local midnight (00:00:00.5 Moscow): refused.
      expect(
        domainErrorCode(() => assertCanJoinGameFacts(facts(), '2026-11-01T00:00:00.500+03:00')),
      ).toBe('GAME_JOIN_CUTOFF_PASSED');

      // False-pass trap: comparing the absolute server instant with the local wall clock parsed as
      // UTC would see the cutoff at 23:59:59Z — three hours later — and allow the join.
      const naiveUtcCutoff = Date.parse('2026-10-31T23:59:59Z');
      const absoluteNow = Date.parse('2026-11-01T00:00:00.500+03:00');
      expect(absoluteNow).toBe(Date.parse('2026-10-31T21:00:00.500Z'));
      expect(absoluteNow).toBeLessThan(naiveUtcCutoff);
      expect(naiveUtcCutoff - Date.parse('2026-10-31T23:59:59+03:00')).toBe(3 * HOUR_MS);
    });

    // ---------------------------------------------------------------------------------------------
    // B_REV — old/new aggregate revision of the join conditions
    // ---------------------------------------------------------------------------------------------

    it('B_REVa rejects a stale expectedRevision with GAME_REVISION_CONFLICT and no side effect', async () => {
      const context = await blockedCase({ label: 'reva' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
      });
      const correlationId = `c3-corr-reva-${context.game.gameId}`;

      expectRejected(
        await joinGame(context, player, { label: 'reva', expectedRevision: 99, correlationId }),
        'GAME_REVISION_CONFLICT',
        1,
      );
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(1);
      expect(state.participations).toHaveLength(0);
      expect(state.reservations).toHaveLength(0);
      expect(state.decisions).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
      expect(
        state.commands.filter((row) => row.state === 'FAILED').map((row) => row.errorCode),
      ).toEqual(['GAME_REVISION_CONFLICT']);
      const audit = await readAuditRows(pool, { tenantId: context.tenant.tenantId, correlationId });
      expect(audit[0]).toMatchObject({ result: 'REJECTED', reason: 'GAME_REVISION_CONFLICT' });
      expect(audit[0]?.newValue).toMatchObject({ currentRevision: 1 });
    });

    it('B_REVb applies the join with the current expectedRevision and bumps the revision', async () => {
      const context = await blockedCase({ label: 'revb' });
      const player = context.tenant.players[0]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: player.userId,
        code: 'C',
      });

      expectApplied(await joinGame(context, player, { label: 'revb', expectedRevision: 1 }), 2);
      const state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.game?.revision).toBe(2);
      expect(state.participations.map((row) => row.userId)).toEqual([player.userId]);
      expect(state.decisions).toHaveLength(1);
    });

    it('B_REVc rejects the old revision after a join and accepts the new one', async () => {
      const context = await blockedCase({ label: 'revc' });
      const first = context.tenant.players[0]!;
      const second = context.tenant.players[1]!;
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: first.userId,
        code: 'C',
      });
      await setPlayerLevel(pool, {
        tenantId: context.tenant.tenantId,
        userId: second.userId,
        code: 'C+',
      });

      expectApplied(await joinGame(context, first, { label: 'revc-1', expectedRevision: 1 }), 2);
      expectRejected(
        await joinGame(context, second, { label: 'revc-old', expectedRevision: 1 }),
        'GAME_REVISION_CONFLICT',
        2,
      );
      let state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([first.userId]);
      expect(state.decisions).toHaveLength(1);
      expect(state.game?.revision).toBe(2);

      expectApplied(await joinGame(context, second, { label: 'revc-2', expectedRevision: 2 }), 3);
      state = await readGameState(pool, {
        tenantId: context.tenant.tenantId,
        gameId: context.game.gameId,
      });
      expect(state.participations.map((row) => row.userId)).toEqual([first.userId, second.userId]);
      expect(state.decisions).toHaveLength(2);
      expect(state.game?.revision).toBe(3);
      expect(state.outbox).toHaveLength(2);
    });
  },
);
