/**
 * C3 independent acceptance fixtures for the LK2 participation-eligibility contour.
 *
 * Ownership: C3 (independent acceptance tests). TEST-ONLY.
 *
 * This module only writes SYNTHETIC rows into the isolated C3 PostgreSQL database
 * (`C3_ACCEPTANCE_DATABASE_URL`) and reads saved state back. It never changes product code,
 * never touches shared/live databases and never calls a provider. Every row it creates carries
 * the `C3 SYNTHETIC` marker so it can never be mistaken for a live account, tenant or tariff.
 *
 * Evidence level: LOCAL only.
 */

import { createHash, randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import { Pool } from 'pg';
import { describe } from 'vitest';

/** Bumped whenever synthetic fixture shapes/timestamps make earlier results non-comparable. */
export const C3_FIXTURE_VERSION = 'c3-2026-10-21.1';

/** Marker for every synthetic row created by the C3 acceptance suites. */
export const SYNTHETIC = 'C3 SYNTHETIC';

const connectionString = process.env.C3_ACCEPTANCE_DATABASE_URL;

/**
 * Suites that need the isolated PostgreSQL database use this guard. It skips only when the
 * isolated database is absent (NOT RUN — never PASS); it must never be skipped for a semantic
 * reason.
 */
export const describeDb = connectionString ? describe : describe.skip;

export function c3DatabaseUrl(): string | undefined {
  const value = process.env.C3_ACCEPTANCE_DATABASE_URL;
  return value && value.trim() !== '' ? value : undefined;
}

export function createC3Pool(max = 6): Pool {
  const url = c3DatabaseUrl();
  if (!url) throw new Error('C3_ACCEPTANCE_DATABASE_URL is required');
  return new Pool({ connectionString: url, max });
}

/** Canonical PadlHub PADEL level scale v1 seeded by migration 0084. */
export const PADEL_LEVELS = [
  { code: 'D', rank: 1 },
  { code: 'D+', rank: 2 },
  { code: 'C', rank: 3 },
  { code: 'C+', rank: 4 },
  { code: 'B', rank: 5 },
  { code: 'B+', rank: 6 },
  { code: 'A', rank: 7 },
] as const;

export type LevelCode = (typeof PADEL_LEVELS)[number]['code'];

export const LEVEL_RANK: Readonly<Record<LevelCode, number>> = Object.fromEntries(
  PADEL_LEVELS.map((level) => [level.code, level.rank]),
) as Record<LevelCode, number>;

export interface C3Actor {
  readonly userId: string;
  readonly sessionId: string;
}

export interface SyntheticTenant {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly organizer: C3Actor;
  /** Non-organizer member accounts, created in order. */
  readonly players: readonly C3Actor[];
  /** Organizer first, then `players`. */
  readonly members: readonly C3Actor[];
  /** sport_code -> level code -> canonical level row. */
  readonly levels: Readonly<Record<string, Readonly<Record<string, { id: string; rank: number }>>>>;
}

export function playerLevelId(
  tenant: SyntheticTenant,
  code: LevelCode,
  sportCode = 'PADEL',
): string {
  const level = tenant.levels[sportCode]?.[code];
  if (!level) throw new Error(`C3_FIXTURE_LEVEL_MISSING:${sportCode}:${code}`);
  return level.id;
}

export interface SeedTenantOptions {
  readonly label?: string;
  readonly playerCount?: number;
  readonly sportCodes?: readonly string[];
}

/**
 * Creates one synthetic tenant with ACTIVE users, refresh sessions (so the server can verify a
 * session) and the canonical PADEL level scale for that tenant.
 */
export async function seedTenant(
  pool: Pool,
  options: SeedTenantOptions = {},
): Promise<SyntheticTenant> {
  const label = options.label ?? 'case';
  const playerCount = options.playerCount ?? 6;
  const sportCodes = options.sportCodes ?? ['PADEL'];
  const tenantId = randomUUID();
  const tenantKey = `c3-${label.toLowerCase()}-${tenantId.slice(0, 8)}`;
  const sessionToken = (sessionId: string): string => `c3-synthetic-session-${sessionId}`;
  const actor = (): C3Actor => ({ userId: randomUUID(), sessionId: randomUUID() });
  const organizer = actor();
  const players = Array.from({ length: playerCount }, () => actor());
  const members = [organizer, ...players];
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name, active)
     values ($1, $2, $3, true)`,
    [tenantId, tenantKey, `${SYNTHETIC} tenant ${label}`],
  );
  const levels: Record<string, Record<string, { id: string; rank: number }>> = {};
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
          createHash('sha256').update(sessionToken(member.sessionId)).digest('hex'),
        ],
      );
    }
    for (const sportCode of sportCodes) {
      levels[sportCode] = await insertCanonicalLevels(client, tenantId, sportCode);
    }
  });
  return { tenantId, tenantKey, organizer, players, members, levels };
}

async function insertCanonicalLevels(
  client: Parameters<Parameters<typeof withTenantTransaction>[2]>[0],
  tenantId: string,
  sportCode: string,
  scaleVersion = 1,
): Promise<Record<string, { id: string; rank: number }>> {
  const result = await client.query<{ code: string; id: string; rank: number }>(
    `insert into eligibility.canonical_levels (
       tenant_id, sport_code, code, title, rank, sort_order, scale_version
     )
     select $1, $2, level.code, level.title, level.rank, level.rank, $3
       from (values ${PADEL_LEVELS.map(
         (_, index) => `($${4 + index * 2}::text, $${5 + index * 2}::text, ${index + 1})`,
       ).join(', ')}) as level(code, title, rank)
     returning code, id, rank`,
    [
      tenantId,
      sportCode,
      scaleVersion,
      ...PADEL_LEVELS.flatMap((level) => [level.code, level.code]),
    ],
  );
  const levels: Record<string, { id: string; rank: number }> = {};
  for (const row of result.rows) levels[row.code] = { id: row.id, rank: row.rank };
  return levels;
}

/** Ensures a canonical level scale exists for a synthetic tenant. Returns code -> level row. */
export async function seedCanonicalLevels(
  pool: Pool,
  tenantId: string,
  sportCode = 'PADEL',
  scaleVersion = 1,
): Promise<Record<string, { id: string; rank: number }>> {
  return withTenantTransaction(pool, tenantId, (client) =>
    insertCanonicalLevels(client, tenantId, sportCode, scaleVersion),
  );
}

export interface LevelPolicyInput {
  readonly tenantId: string;
  readonly sportCode?: string;
  readonly activityType?: 'GAME' | 'TOURNAMENT' | 'TRAINING';
  readonly mode: 'OFF' | 'SHADOW' | 'WARN' | 'BLOCK';
  readonly version: number;
  readonly lowerToleranceSteps?: number;
  readonly upperToleranceSteps?: number;
  readonly missingActivityConstraintAction?: 'ALLOW' | 'WARN' | 'BLOCK';
  readonly legacyTextConstraintAction?: 'ALLOW' | 'WARN';
  readonly changeComment?: string;
}

/**
 * Activates one level policy for the synthetic tenant, deactivating the previous active policy
 * of the same sport/activity (migration 0084 enforces one active policy per tuple).
 */
export async function upsertLevelPolicy(
  pool: Pool,
  input: LevelPolicyInput,
): Promise<{ policyId: string; version: number }> {
  const sportCode = input.sportCode ?? 'PADEL';
  const activityType = input.activityType ?? 'GAME';
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query(
      `update eligibility.level_policies
          set active = false
        where tenant_id = $1 and sport_code = $2 and activity_type = $3 and active`,
      [input.tenantId, sportCode, activityType],
    );
    const created = await client.query<{ id: string; version: number }>(
      `insert into eligibility.level_policies (
         tenant_id, sport_code, activity_type, mode, lower_tolerance_steps,
         upper_tolerance_steps, missing_activity_constraint_action,
         legacy_text_constraint_action, version, active, change_comment
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
       returning id, version`,
      [
        input.tenantId,
        sportCode,
        activityType,
        input.mode,
        input.lowerToleranceSteps ?? 0,
        input.upperToleranceSteps ?? 0,
        input.missingActivityConstraintAction ?? 'ALLOW',
        input.legacyTextConstraintAction ?? 'ALLOW',
        input.version,
        input.changeComment ?? `${SYNTHETIC} policy fixture`,
      ],
    );
    const row = created.rows[0];
    if (!row) throw new Error('C3_FIXTURE_POLICY_WRITE_LOST');
    return { policyId: row.id, version: row.version };
  });
}

export interface SetPlayerLevelInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly code: LevelCode;
  readonly sportCode?: string;
  readonly source?: 'SELF_DECLARED' | 'ONBOARDING' | 'MANUAL' | 'CALCULATED' | 'VIVA' | 'MIGRATED';
  readonly scaleVersion?: number;
}

/** Sets (or replaces) the synthetic player's declared sport level. */
export async function setPlayerLevel(pool: Pool, input: SetPlayerLevelInput): Promise<void> {
  const sportCode = input.sportCode ?? 'PADEL';
  const scaleVersion = input.scaleVersion ?? 1;
  await withTenantTransaction(pool, input.tenantId, async (client) => {
    const level = await client.query<{ id: string }>(
      `select id from eligibility.canonical_levels
        where tenant_id = $1 and sport_code = $2 and scale_version = $3 and code = $4`,
      [input.tenantId, sportCode, scaleVersion, input.code],
    );
    const levelId = level.rows[0]?.id;
    if (!levelId) throw new Error(`C3_FIXTURE_PLAYER_LEVEL_UNKNOWN:${sportCode}:${input.code}`);
    await client.query(
      `insert into eligibility.player_sport_levels (
         tenant_id, player_id, sport_code, level_id, source, scale_version, updated_at
       ) values ($1, $2, $3, $4, $5, $6, now())
       on conflict (tenant_id, player_id, sport_code) do update
         set level_id = excluded.level_id,
             source = excluded.source,
             scale_version = excluded.scale_version,
             updated_at = now()`,
      [
        input.tenantId,
        input.userId,
        sportCode,
        levelId,
        input.source ?? 'CALCULATED',
        scaleVersion,
      ],
    );
  });
}

export type C3PaymentMode = 'NO_PAYMENT' | 'SPLIT' | 'SUBSCRIPTION' | 'ORGANIZER_PAYS';

export interface SeedGameInput {
  readonly tenantId: string;
  readonly organizerUserId: string;
  readonly startsAt: Date;
  readonly endsAt?: Date;
  readonly joinCutoffAt?: Date | null;
  readonly timezone?: string;
  readonly paymentMode?: C3PaymentMode;
  readonly capacity?: number;
  readonly lifecycleState?: 'DRAFT' | 'SCHEDULED';
  readonly visibility?: 'PUBLIC' | 'PRIVATE';
  /** Inclusive level range as legacy code columns; canonical ids are resolved automatically. */
  readonly levelFrom?: LevelCode;
  readonly levelTo?: LevelCode;
  readonly minLevelId?: string;
  readonly maxLevelId?: string;
  readonly sportCode?: string;
  readonly revision?: number;
  readonly scaleVersion?: number;
  readonly title?: string;
}

export interface SeededGame {
  readonly gameId: string;
  readonly revision: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly joinCutoffAt: string | null;
  readonly timezone: string;
  readonly minLevelId: string | null;
  readonly maxLevelId: string | null;
}

/**
 * Inserts one synthetic, station-less `games.games` row (random station id without a station
 * profile) so the eligibility/roster writer can be exercised without venue fixtures.
 */
export async function seedGame(pool: Pool, input: SeedGameInput): Promise<SeededGame> {
  const gameId = randomUUID();
  const timezone = input.timezone ?? 'Europe/Moscow';
  const startsAt = input.startsAt;
  const endsAt = input.endsAt ?? new Date(startsAt.getTime() + 90 * 60_000);
  const joinCutoffAt =
    input.joinCutoffAt === undefined
      ? new Date(startsAt.getTime() - 30 * 60_000)
      : input.joinCutoffAt;
  const paymentMode = input.paymentMode ?? 'NO_PAYMENT';
  const capacity = input.capacity ?? 4;
  const lifecycleState = input.lifecycleState ?? 'SCHEDULED';
  const sportCode = input.sportCode ?? 'PADEL';
  const revision = input.revision ?? 1;
  const scaleVersion = input.scaleVersion ?? 1;
  const stationId = randomUUID();
  let minLevelId = input.minLevelId ?? null;
  let maxLevelId = input.maxLevelId ?? null;
  if (input.levelFrom && input.levelTo && (!minLevelId || !maxLevelId)) {
    const resolved = await withTenantTransaction(pool, input.tenantId, (client) =>
      client.query<{ code: string; id: string }>(
        `select code, id from eligibility.canonical_levels
          where tenant_id = $1 and sport_code = $2 and scale_version = $3 and active
            and code = any($4::text[])`,
        [input.tenantId, sportCode, scaleVersion, [input.levelFrom, input.levelTo]],
      ),
    );
    minLevelId = resolved.rows.find((row) => row.code === input.levelFrom)?.id ?? null;
    maxLevelId = resolved.rows.find((row) => row.code === input.levelTo)?.id ?? null;
    if (!minLevelId || !maxLevelId) throw new Error('C3_FIXTURE_GAME_LEVEL_UNKNOWN');
  }
  await withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query(
      `insert into games.games (
         tenant_id, id, revision, organizer_user_id, title, kind, visibility,
         lifecycle_state, station_id, court_id, starts_at, ends_at, timezone,
         capacity, waitlist_enabled, join_cutoff_at, payment_mode,
         level_from, level_to, sport_code, min_level_id, max_level_id
       ) values (
         $1, $2, $3, $4, $5, 'FRIENDLY', $6,
         $7, $8, null, $9, $10, $11,
         $12, false, $13, $14,
         $15, $16, $17, $18, $19
       )`,
      [
        input.tenantId,
        gameId,
        revision,
        input.organizerUserId,
        input.title ?? `${SYNTHETIC} game ${gameId}`,
        input.visibility ?? 'PUBLIC',
        lifecycleState,
        stationId,
        startsAt.toISOString(),
        endsAt.toISOString(),
        timezone,
        capacity,
        joinCutoffAt === null ? null : joinCutoffAt.toISOString(),
        paymentMode,
        input.levelFrom ?? null,
        input.levelTo ?? null,
        sportCode,
        minLevelId,
        maxLevelId,
      ],
    );
  });
  return {
    gameId,
    revision,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    joinCutoffAt: joinCutoffAt === null ? null : joinCutoffAt.toISOString(),
    timezone,
    minLevelId,
    maxLevelId,
  };
}

export interface SeedInvitationInput {
  readonly tenantId: string;
  readonly gameId: string;
  readonly recipientPlayerId: string;
  readonly createdBy: string;
  readonly status?: 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';
  readonly maxUses?: number;
  readonly useCount?: number;
  readonly createdAt?: Date;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date | null;
  readonly usedAt?: Date | null;
}

/** Inserts one synthetic personal GAME invitation row. */
export async function seedInvitation(pool: Pool, input: SeedInvitationInput): Promise<string> {
  const invitationId = randomUUID();
  const createdAt = input.createdAt ?? new Date(Date.now() - 60_000);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 2 * 86_400_000);
  await withTenantTransaction(pool, input.tenantId, async (client) => {
    await client.query(
      `insert into eligibility.personal_invitations (
         tenant_id, id, activity_type, activity_id, invitation_type, recipient_player_id,
         status, max_uses, use_count, expires_at, revoked_at, used_at, created_by, created_at
       ) values ($1, $2, 'GAME', $3, 'PERSONAL', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.tenantId,
        invitationId,
        input.gameId,
        input.recipientPlayerId,
        input.status ?? 'ACTIVE',
        input.maxUses ?? 1,
        input.useCount ?? 0,
        expiresAt.toISOString(),
        input.revokedAt === null || input.revokedAt === undefined
          ? null
          : input.revokedAt.toISOString(),
        input.usedAt === null || input.usedAt === undefined ? null : input.usedAt.toISOString(),
        input.createdBy,
        createdAt.toISOString(),
      ],
    );
  });
  return invitationId;
}

export interface CommandMeta {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

/** Deterministic-shape synthetic idempotency metadata for a roster command. */
export function commandMeta(label: string): CommandMeta {
  const idempotencyKey = `c3-${label}-${randomUUID()}`;
  return {
    idempotencyKey,
    requestHash: createHash('sha256').update(idempotencyKey).digest('hex'),
    correlationId: `c3-corr-${label}-${randomUUID()}`,
  };
}

export async function sampleDatabaseNow(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: Date }>('select now() as now');
  const value = result.rows[0]?.now;
  if (!value) throw new Error('C3_FIXTURE_CLOCK_MISSING');
  return value instanceof Date ? value : new Date(value);
}

export interface GameRowSnapshot {
  readonly revision: number;
  readonly lifecycleState: string;
  readonly paymentMode: string;
  readonly sportCode: string;
  readonly timezone: string;
  readonly capacity: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly joinCutoffAt: string | null;
  /** `starts_at` rendered in the game's own timezone. */
  readonly startsLocal: string;
  /** `join_cutoff_at` rendered in the game's own timezone, or null. */
  readonly joinCutoffLocal: string | null;
  readonly levelFrom: string | null;
  readonly levelTo: string | null;
  readonly minLevelId: string | null;
  readonly maxLevelId: string | null;
}

export async function readGame(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<GameRowSnapshot | undefined> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      revision: string;
      lifecycle_state: string;
      payment_mode: string;
      sport_code: string;
      timezone: string;
      capacity: number;
      starts_at: Date;
      ends_at: Date;
      join_cutoff_at: Date | null;
      starts_local: string;
      join_cutoff_local: string | null;
      level_from: string | null;
      level_to: string | null;
      min_level_id: string | null;
      max_level_id: string | null;
    }>(
      `select revision, lifecycle_state, payment_mode, sport_code, timezone, capacity,
              starts_at, ends_at, join_cutoff_at,
              to_char(starts_at at time zone timezone, 'YYYY-MM-DD HH24:MI:SS') as starts_local,
              to_char(join_cutoff_at at time zone timezone, 'YYYY-MM-DD HH24:MI:SS')
                as join_cutoff_local,
              level_from, level_to, min_level_id, max_level_id
         from games.games
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.gameId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      revision: Number(row.revision),
      lifecycleState: row.lifecycle_state,
      paymentMode: row.payment_mode,
      sportCode: row.sport_code,
      timezone: row.timezone,
      capacity: row.capacity,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      joinCutoffAt: row.join_cutoff_at === null ? null : new Date(row.join_cutoff_at).toISOString(),
      startsLocal: row.starts_local,
      joinCutoffLocal: row.join_cutoff_local,
      levelFrom: row.level_from,
      levelTo: row.level_to,
      minLevelId: row.min_level_id,
      maxLevelId: row.max_level_id,
    };
  });
}

export interface DecisionRow {
  readonly id: string;
  readonly playerId: string;
  readonly action: string;
  readonly status: string;
  readonly ruleCode: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly policyVersion: number;
  readonly levelScaleVersion: number | null;
  readonly constraintSource: string | null;
  readonly invitationId: string | null;
  readonly details: Record<string, unknown>;
}

export async function readEligibilityDecisions(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId?: string },
): Promise<DecisionRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      player_id: string;
      action: string;
      status: string;
      rule_code: string;
      outcome: string;
      reason_code: string;
      policy_version: number;
      level_scale_version: number | null;
      constraint_source: string | null;
      invitation_id: string | null;
      details: Record<string, unknown>;
    }>(
      `select id, player_id, action, status, rule_code, outcome, reason_code,
              policy_version, level_scale_version, constraint_source, invitation_id, details
         from eligibility.decisions
        where tenant_id = $1 and ($2::uuid is null or activity_id = $2)
        order by evaluated_at, id`,
      [input.tenantId, input.gameId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      playerId: row.player_id,
      action: row.action,
      status: row.status,
      ruleCode: row.rule_code,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      policyVersion: row.policy_version,
      levelScaleVersion: row.level_scale_version,
      constraintSource: row.constraint_source,
      invitationId: row.invitation_id,
      details: row.details,
    }));
  });
}

export interface ParticipationRow {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly state: string;
  readonly paymentState: string;
  readonly eligibilityDecisionId: string | null;
}

export async function readParticipations(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<ParticipationRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      role: string;
      state: string;
      payment_state: string;
      eligibility_decision_id: string | null;
    }>(
      `select id, user_id, role, state, payment_state, eligibility_decision_id
         from games.participations
        where tenant_id = $1 and game_id = $2
        order by joined_at, id`,
      [input.tenantId, input.gameId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      role: row.role,
      state: row.state,
      paymentState: row.payment_state,
      eligibilityDecisionId: row.eligibility_decision_id,
    }));
  });
}

export interface ReservationRow {
  readonly id: string;
  readonly userId: string;
  readonly state: string;
  readonly paymentState: string;
  readonly eligibilityDecisionId: string | null;
}

export async function readReservations(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<ReservationRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      state: string;
      payment_state: string;
      eligibility_decision_id: string | null;
    }>(
      `select id, user_id, state, payment_state, eligibility_decision_id
         from games.seat_reservations
        where tenant_id = $1 and game_id = $2
        order by created_at, id`,
      [input.tenantId, input.gameId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      state: row.state,
      paymentState: row.payment_state,
      eligibilityDecisionId: row.eligibility_decision_id,
    }));
  });
}

export interface PaymentSnapshotRow {
  readonly operationId: string;
  readonly decisionId: string;
  readonly playerId: string;
  readonly activityId: string;
  readonly snapshot: Record<string, unknown>;
}

/** Trusted payment snapshots linked to an eligibility decision for the paid-JOIN path. */
export async function readPaymentSnapshots(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId?: string },
): Promise<PaymentSnapshotRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      operation_id: string;
      decision_id: string;
      player_id: string;
      activity_id: string;
      snapshot: Record<string, unknown>;
    }>(
      `select operation_id, decision_id, player_id, activity_id, snapshot
         from eligibility.payment_snapshots
        where tenant_id = $1 and ($2::uuid is null or activity_id = $2)
        order by created_at, operation_id`,
      [input.tenantId, input.gameId ?? null],
    );
    return result.rows.map((row) => ({
      operationId: row.operation_id,
      decisionId: row.decision_id,
      playerId: row.player_id,
      activityId: row.activity_id,
      snapshot: row.snapshot,
    }));
  });
}

export interface RosterCommandRow {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly state: string;
  readonly errorCode: string | null;
  readonly aggregateId: string | null;
}

export async function readCommandRows(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId?: string },
): Promise<RosterCommandRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      actor_user_id: string | null;
      idempotency_key: string;
      command_type: string;
      state: string;
      error_code: string | null;
      aggregate_id: string | null;
    }>(
      `select id, actor_user_id, idempotency_key, command_type, state, error_code, aggregate_id
         from games.command_idempotency
        where tenant_id = $1 and ($2::uuid is null or aggregate_id = $2)
        order by created_at, id`,
      [input.tenantId, input.gameId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      idempotencyKey: row.idempotency_key,
      commandType: row.command_type,
      state: row.state,
      errorCode: row.error_code,
      aggregateId: row.aggregate_id,
    }));
  });
}

export interface InvitationRow {
  readonly id: string;
  readonly activityId: string;
  readonly recipientPlayerId: string;
  readonly status: string;
  readonly maxUses: number;
  readonly useCount: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly usedAt: string | null;
}

export async function readInvitation(
  pool: Pool,
  input: { readonly tenantId: string; readonly invitationId: string },
): Promise<InvitationRow | undefined> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      activity_id: string;
      recipient_player_id: string;
      status: string;
      max_uses: number;
      use_count: number;
      expires_at: Date;
      revoked_at: Date | null;
      used_at: Date | null;
    }>(
      `select id, activity_id, recipient_player_id, status, max_uses, use_count,
              expires_at, revoked_at, used_at
         from eligibility.personal_invitations
        where tenant_id = $1 and id = $2`,
      [input.tenantId, input.invitationId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      activityId: row.activity_id,
      recipientPlayerId: row.recipient_player_id,
      status: row.status,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
      usedAt: row.used_at === null ? null : new Date(row.used_at).toISOString(),
    };
  });
}

export interface AuditRow {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceId: string | null;
  readonly result: string;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly newValue: Record<string, unknown> | null;
}

export async function readAuditRows(
  pool: Pool,
  input: { readonly tenantId: string; readonly correlationId?: string },
): Promise<AuditRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      actor_id: string | null;
      action: string;
      resource_id: string | null;
      result: string;
      reason: string | null;
      correlation_id: string;
      new_value: Record<string, unknown> | null;
    }>(
      `select id, actor_id, action, resource_id, result, reason, correlation_id, new_value
         from audit.audit_log
        where tenant_id = $1 and ($2::text is null or correlation_id = $2)
        order by occurred_at, id`,
      [input.tenantId, input.correlationId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceId: row.resource_id,
      result: row.result,
      reason: row.reason,
      correlationId: row.correlation_id,
      newValue: row.new_value,
    }));
  });
}

export interface OutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export async function readOutboxEvents(
  pool: Pool,
  input: { readonly tenantId: string; readonly aggregateId?: string },
): Promise<OutboxRow[]> {
  return withTenantTransaction(pool, input.tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `select id, event_type, aggregate_id, payload
         from audit.outbox_events
        where tenant_id = $1 and ($2::uuid is null or aggregate_id = $2)
        order by occurred_at, id`,
      [input.tenantId, input.aggregateId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
    }));
  });
}

export interface GameState {
  readonly game: GameRowSnapshot | undefined;
  readonly participations: readonly ParticipationRow[];
  readonly reservations: readonly ReservationRow[];
  readonly decisions: readonly DecisionRow[];
  readonly commands: readonly RosterCommandRow[];
  readonly outbox: readonly OutboxRow[];
}

/**
 * Full saved-state snapshot for one synthetic game. Acceptance cases must assert business state
 * (rows, counters, revision) — not only the returned value of the command.
 */
export async function readGameState(
  pool: Pool,
  input: { readonly tenantId: string; readonly gameId: string },
): Promise<GameState> {
  const [game, participations, reservations, decisions, commands, outbox] = await Promise.all([
    readGame(pool, input),
    readParticipations(pool, input),
    readReservations(pool, input),
    readEligibilityDecisions(pool, input),
    readCommandRows(pool, input),
    readOutboxEvents(pool, { tenantId: input.tenantId, aggregateId: input.gameId }),
  ]);
  return { game, participations, reservations, decisions, commands, outbox };
}
