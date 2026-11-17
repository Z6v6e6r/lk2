import { createHash } from 'node:crypto';
import {
  attestExactRosterPlayerMappings,
  exactRosterParticipations,
  exactRosterValueSha256,
  readExactRosterUiIdentityPreimage,
  readFinishedUnscoredUiPreimage,
  withTenantTransaction,
  type LegacyGameExactPlayerMapping,
  type LegacyGameImportRepository,
  type LegacyGameUiObservationFence,
} from '@phub/database';
import type { LegacyGamesMongoAdapter, LegacyGameSourceSnapshot } from '@phub/legacy-games-adapter';
import type { Pool, QueryResultRow } from 'pg';
import {
  parseUiObservationProof,
  verifyUiObservationMembership,
  assertUiObservationFresh,
  UI_OBSERVATION_POLICY,
} from './roster-ui-observation-proof.js';

interface TargetRow extends QueryResultRow {
  game_id: string;
  revision: string | number;
  lifecycle_state: string;
  mode: string | null;
  conflict_code: string | null;
  sync_revision: string | number | null;
  sync_version: string | null;
  source_aliases: string[];
  participations: unknown;
  starts_at?: Date | string;
  ends_at?: Date | string;
  capacity?: number;
  before_start?: boolean;
  active_reservations?: boolean;
  active_waitlist?: boolean;
  previous_audits: {
    revision: number;
    playerMappingsSha256: string;
    replacement?: ReplacementAudit;
    correlationId?: string;
  }[];
}
export interface ExactRosterRepairReport {
  schema:
    | 'PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1'
    | 'PHUB_EXACT_LEGACY_ROSTER_REPLACEMENT_V1'
    | 'PHUB_EXACT_LEGACY_ROSTER_UI_OBSERVATION_REPLACEMENT_V1';
  status: 'PLAN' | 'REPAIRED' | 'ALREADY_REPAIRED' | 'DEFERRED';
  gameId: string;
  operationId: string;
  planSha256: string;
  sourceParticipants: number;
  allowLocalRemovals: boolean;
  uiObservation?: LegacyGameUiObservationFence;
  replacement?: {
    retainedParticipationCount: number;
    retainedPaidParticipationCount: number;
    participationsBeforeSha256: string;
    retainedParticipationIdsSha256: string;
    existingAccountsAndProfilesOnly: true;
    visibleHistoryGuaranteed: false;
  };
  authorizesDeploy: false;
}
interface ReplacementAudit {
  participationsBeforeSha256: string;
  participationsAfterSha256: string;
  retainedParticipationIdsSha256: string;
  retainedParticipationCount: number;
  retainedPaidParticipationCount: number;
  uiObservation?: LegacyGameUiObservationFence;
}
export const EXACT_SOURCE_REPLACEMENT_CONFIRMATION =
  'REPLACE_SOURCE_ROSTER_KEEP_ACCOUNTS_AND_PAYMENTS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
function need(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`LEGACY_GAME_EXACT_REPAIR_${code}`);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function replacementReport(value: Omit<ReplacementAudit, 'participationsAfterSha256'>) {
  return {
    retainedParticipationCount: value.retainedParticipationCount,
    retainedPaidParticipationCount: value.retainedPaidParticipationCount,
    participationsBeforeSha256: value.participationsBeforeSha256,
    retainedParticipationIdsSha256: value.retainedParticipationIdsSha256,
    existingAccountsAndProfilesOnly: true as const,
    visibleHistoryGuaranteed: false as const,
  };
}

/** One canonical game per invocation. Source aliases and full snapshots stay in memory.
 * This is the existing audited rebaseline path, with an exact read-only plan and revision fence.
 * The deployment owner supplies backup, immutable image and preimage custody before apply.
 */
export async function exactLegacyGameRosterRepair(input: {
  readonly pool: Pool;
  readonly repository: Pick<LegacyGameImportRepository, 'rebaselineParticipants'>;
  readonly source: Pick<LegacyGamesMongoAdapter, 'readRosterByExternalIds'> &
    Partial<Pick<LegacyGamesMongoAdapter, 'readRosterMembershipByExternalIds'>>;
  readonly tenantKey: string;
  readonly gameId: string;
  readonly operationId: string;
  readonly planOnly: boolean;
  readonly expectedPlanSha256?: string;
  readonly now?: Date;
  readonly replaceSourceRoster?: boolean;
  readonly replacementConfirmed?: boolean;
  readonly uiObservationBytes?: Uint8Array;
  readonly reviewedUiObservationSha256?: string;
  readonly providerTenantKey?: string;
  readonly finishedUnscoredUi?: boolean;
}): Promise<ExactRosterRepairReport> {
  const replacing = input.replaceSourceRoster === true;
  need(
    input.uiObservationBytes
      ? replacing &&
          HASH.test(input.reviewedUiObservationSha256 ?? '') &&
          input.providerTenantKey &&
          typeof input.source.readRosterMembershipByExternalIds === 'function'
      : input.reviewedUiObservationSha256 === undefined,
    'UI_OBSERVATION_SCOPE',
  );
  const ui = input.uiObservationBytes
    ? parseUiObservationProof(input.uiObservationBytes, input.reviewedUiObservationSha256!)
    : undefined;
  need(!input.finishedUnscoredUi || ui, 'UI_OBSERVATION_SCOPE');
  need(
    replacing
      ? input.planOnly
        ? !input.replacementConfirmed
        : input.replacementConfirmed === true
      : !input.replacementConfirmed,
    'CONFIRMATION',
  );
  need(UUID.test(input.gameId), 'TARGET');
  need(/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/u.test(input.operationId), 'OPERATION');
  need(
    input.planOnly
      ? input.expectedPlanSha256 === undefined
      : HASH.test(input.expectedPlanSha256 ?? ''),
    'PLAN_HASH',
  );
  const tenant = (
    await input.pool.query<{ id: string }>(
      'select id from identity.tenants where tenant_key = $1 and active = true',
      [input.tenantKey],
    )
  ).rows[0];
  need(tenant, 'TENANT');
  const expectedCorrelation = input.expectedPlanSha256
    ? `legacy-roster-repair:${input.operationId}:${input.expectedPlanSha256}`
    : '';
  const row = await withTenantTransaction(
    input.pool,
    tenant.id,
    async (client) =>
      (
        await client.query<TargetRow>(
          `select g.id as game_id, g.revision, g.lifecycle_state, g.starts_at, g.ends_at, g.capacity,
            g.starts_at > clock_timestamp() as before_start, s.mode, s.conflict_code,
            exists(select 1 from games.seat_reservations r where r.tenant_id=g.tenant_id and r.game_id=g.id and r.state='ACTIVE') as active_reservations,
            exists(select 1 from games.waitlist_entries w where w.tenant_id=g.tenant_id and w.game_id=g.id and w.state='ACTIVE') as active_waitlist,
            s.last_synced_game_revision as sync_revision, s.source_external_version as sync_version,
            array(select m.external_id from integration.external_entity_map m
                   where m.tenant_id=g.tenant_id and m.internal_id=g.id
                     and m.external_system='LK_LEGACY_SNAPSHOT' and m.entity_type='game'
                   order by m.external_id) as source_aliases,
            (select coalesce(jsonb_agg(jsonb_build_array(p.id,p.user_id,p.role,p.state,p.payment_state)
                      order by p.id),'[]'::jsonb) from games.participations p
              where p.tenant_id=g.tenant_id and p.game_id=g.id) as participations,
            (select coalesce(jsonb_agg(jsonb_build_object('revision',(a.new_value->>'revision')::int,'playerMappingsSha256',a.new_value->>'playerMappingsSha256','replacement',a.new_value->'replacement','correlationId',a.correlation_id)),'[]'::jsonb)
               from audit.audit_log a where a.tenant_id=g.tenant_id and a.resource_id=g.id
                and a.action='GAME_PARTICIPANTS_REBASELINED_FROM_LEGACY_SNAPSHOT'
                and a.result='SUCCESS' and (a.correlation_id=$3 or ($4<>'' and left(a.correlation_id,char_length($4))=$4))) as previous_audits
       from games.games g left join integration.legacy_game_roster_sync_state s
         on s.tenant_id=g.tenant_id and s.game_id=g.id
      where g.tenant_id=$1 and g.id=$2 and not exists (
        select 1 from integration.legacy_game_merge_redirects r
         where r.tenant_id=g.tenant_id and r.source_game_id=g.id)`,
          [
            tenant.id,
            input.gameId,
            expectedCorrelation,
            replacing ? `legacy-roster-repair:${input.operationId}:` : '',
          ],
        )
      ).rows[0],
  );
  need(
    row &&
      row.game_id === input.gameId &&
      row.lifecycle_state === (input.finishedUnscoredUi ? 'FINISHED' : 'SCHEDULED'),
    'TARGET',
  );
  need(row.source_aliases.length > 0 && row.source_aliases.length <= 30, 'SOURCE_MAPPING');
  const snapshots = ui
    ? await input.source.readRosterMembershipByExternalIds!({
        externalIds: row.source_aliases,
        limit: 1,
      })
    : await input.source.readRosterByExternalIds({
        externalIds: row.source_aliases,
        limit: 1,
        ...(replacing ? { requirePaidRosterProof: true } : {}),
      });
  need(snapshots.length === 1, 'SOURCE_CARDINALITY');
  const observedSnapshot = snapshots[0]!;
  need(
    [observedSnapshot.externalId, ...(observedSnapshot.externalAliases ?? [])].some((id) =>
      row.source_aliases.includes(id),
    ),
    'SOURCE_MAPPING',
  );
  need(
    !observedSnapshot.cancelled &&
      observedSnapshot.participants.length > 0 &&
      observedSnapshot.participants.length <= observedSnapshot.capacity,
    'SOURCE_ROSTER',
  );
  need(HASH.test(observedSnapshot.externalVersion), 'SOURCE_VERSION');
  const playerAliases = [
    ...new Set(
      observedSnapshot.participants.flatMap((p) => [p.externalId, ...(p.externalAliases ?? [])]),
    ),
  ].sort();
  const mappings = await withTenantTransaction(
    input.pool,
    tenant.id,
    async (client) =>
      (
        await client.query<LegacyGameExactPlayerMapping & QueryResultRow>(
          `select external_id,internal_id,sync_status,sync_error_code from integration.external_entity_map
      where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game_player'
        and external_id=any($2::text[]) order by external_id`,
          [tenant.id, playerAliases],
        )
      ).rows,
  );
  const identity = attestExactRosterPlayerMappings(observedSnapshot, mappings);
  let snapshot: LegacyGameSourceSnapshot;
  let uiObservation: LegacyGameUiObservationFence | undefined;
  if (ui) {
    need('sourceObservationSha256' in observedSnapshot, 'UI_OBSERVATION_SOURCE');
    const verified = verifyUiObservationMembership({
      envelope: ui.envelope,
      source: observedSnapshot,
      mappings,
      tenantKey: input.tenantKey,
      gameId: input.gameId,
      operationId: input.operationId,
      providerTenantKey: input.providerTenantKey!,
    });
    snapshot = verified.snapshot;
    const binding = await withTenantTransaction(input.pool, tenant.id, (client) =>
      readExactRosterUiIdentityPreimage(client, {
        tenantId: tenant.id,
        gameId: input.gameId,
        source: snapshot,
        mappings,
        lock: false,
      }),
    );
    uiObservation = {
      policy: UI_OBSERVATION_POLICY,
      originAuthenticated: false,
      proofSha256: ui.proofSha256,
      reviewSha256: ui.reviewSha256,
      captureSetSha256: ui.envelope.body.captureSetSha256,
      observationSetSha256: verified.observationSetSha256,
      sourceObservationSha256: observedSnapshot.sourceObservationSha256,
      ...binding,
      capturedAt: ui.envelope.body.capturedAt,
      reviewedAt: ui.envelope.review.reviewedAt,
      expiresAt: ui.envelope.body.expiresAt,
    };
  } else {
    need(!('sourceObservationSha256' in observedSnapshot), 'UI_OBSERVATION_SCOPE');
    snapshot = observedSnapshot;
  }
  // Stable operation/correlation evidence permits a lost-ACK readback without reapplying.
  if (row.previous_audits.length > 0) {
    need(
      row.previous_audits.length === 1 &&
        row.mode === 'MIRROR' &&
        row.conflict_code === null &&
        Number(row.revision) === row.previous_audits[0]!.revision &&
        Number(row.sync_revision) === Number(row.revision) &&
        row.sync_version === snapshot.externalVersion &&
        row.previous_audits[0]!.playerMappingsSha256 === identity.sha256,
      'PREVIOUS_OUTCOME_DRIFT',
    );
    if (replacing) {
      const audit = row.previous_audits[0]!.replacement;
      need(
        !input.planOnly &&
          row.previous_audits[0]!.correlationId === expectedCorrelation &&
          audit &&
          exactRosterValueSha256(exactRosterParticipations(row.participations)) ===
            audit.participationsAfterSha256,
        'PREVIOUS_OUTCOME_DRIFT',
      );
      need(
        Boolean(audit.uiObservation?.finishedUnscored) === Boolean(input.finishedUnscoredUi),
        'PREVIOUS_OUTCOME_DRIFT',
      );
      need(
        uiObservation
          ? audit.uiObservation?.proofSha256 === uiObservation.proofSha256 &&
              audit.uiObservation.reviewSha256 === uiObservation.reviewSha256 &&
              audit.uiObservation.legacySourceIdentityPreimageSha256 ===
                uiObservation.legacySourceIdentityPreimageSha256 &&
              audit.uiObservation.exerciseMappingSha256 === uiObservation.exerciseMappingSha256
          : !audit.uiObservation,
        'PREVIOUS_OUTCOME_DRIFT',
      );
    } else need(!row.previous_audits[0]!.replacement, 'PREVIOUS_OUTCOME_DRIFT');
    return {
      schema: uiObservation
        ? 'PHUB_EXACT_LEGACY_ROSTER_UI_OBSERVATION_REPLACEMENT_V1'
        : replacing
          ? 'PHUB_EXACT_LEGACY_ROSTER_REPLACEMENT_V1'
          : 'PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1',
      status: 'ALREADY_REPAIRED',
      gameId: input.gameId,
      operationId: input.operationId,
      planSha256: input.expectedPlanSha256!,
      sourceParticipants: snapshot.participants.length,
      allowLocalRemovals: replacing,
      authorizesDeploy: false,
      ...(uiObservation
        ? { uiObservation: row.previous_audits[0]!.replacement!.uiObservation! }
        : {}),
      ...(replacing
        ? { replacement: replacementReport(row.previous_audits[0]!.replacement!) }
        : {}),
    };
  }
  if (ui) assertUiObservationFresh(ui.envelope, input.now ?? new Date());
  const finished = input.finishedUnscoredUi
    ? await withTenantTransaction(input.pool, tenant.id, (client) =>
        readFinishedUnscoredUiPreimage(client, {
          tenantId: tenant.id,
          gameId: input.gameId,
          lock: false,
        }),
      )
    : undefined;
  if (finished) {
    need(
      finished.revision === Number(row.revision) &&
        finished.syncRevision === Number(row.sync_revision),
      'FINISHED_PHASE_DRIFT',
    );
    need(uiObservation, 'UI_OBSERVATION_SCOPE');
    uiObservation = {
      ...uiObservation,
      finishedUnscored: {
        policy: 'EXACT_UI_PROOF_FINISHED_UNSCORED',
        preimageSha256: finished.sha256,
      },
    };
  }
  need(
    row.mode === 'CONFLICT' &&
      (row.conflict_code === 'LEGACY_GAME_ROSTER_BASELINE_MISMATCH' ||
        (replacing && row.conflict_code === 'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL')) &&
      (finished
        ? Number(row.sync_revision) + 2 === Number(row.revision)
        : Number(row.sync_revision) === Number(row.revision)),
    'QUARANTINE',
  );
  let replacement: Omit<ReplacementAudit, 'participationsAfterSha256'> | undefined;
  if (replacing) {
    need(
      (finished || row.before_start === true) &&
        Date.parse(snapshot.startsAt) === new Date(row.starts_at!).getTime() &&
        Date.parse(snapshot.endsAt) === new Date(row.ends_at!).getTime() &&
        snapshot.capacity === row.capacity,
      'SCHEDULE',
    );
    need(row.active_reservations === false && row.active_waitlist === false, 'PENDING_CAPACITY');
    const participations = exactRosterParticipations(row.participations);
    const users = new Set(identity.users.values());
    const retired = participations.filter((p) => p[3] === 'ACTIVE' && !users.has(p[1]));
    need(retired.length > 0, 'REPLACEMENT_EMPTY');
    need(
      snapshot.participants.every((p) => ['PAID', 'NOT_REQUIRED'].includes(p.paymentState)) &&
        participations
          .filter((p) => p[3] === 'ACTIVE')
          .every((p) => ['PAID', 'NOT_REQUIRED'].includes(p[4])),
      'PAYMENT_STATE',
    );
    const existing = await withTenantTransaction(input.pool, tenant.id, async (client) => {
      const ids = [...users].sort();
      const accounts = await client.query<{ id: string }>(
        "select id from identity.users where tenant_id=$1 and id=any($2::uuid[]) and status='ACTIVE' order by id",
        [tenant.id, ids],
      );
      const profiles = await client.query<{ user_id: string }>(
        'select user_id from profile.user_summaries where tenant_id=$1 and user_id=any($2::uuid[]) order by user_id',
        [tenant.id, ids],
      );
      return accounts.rows.length === ids.length && profiles.rows.length === ids.length;
    });
    need(existing, 'IDENTITY');
    replacement = {
      participationsBeforeSha256: exactRosterValueSha256(participations),
      retainedParticipationIdsSha256: exactRosterValueSha256(retired.map((p) => p[0]).sort()),
      retainedParticipationCount: retired.length,
      retainedPaidParticipationCount: retired.filter((p) => p[4] === 'PAID').length,
      ...(uiObservation ? { uiObservation } : {}),
    };
  }
  const planSha256 = digest({
    schema: 1,
    tenantId: tenant.id,
    gameId: input.gameId,
    operationId: input.operationId,
    revision: Number(row.revision),
    syncVersion: row.sync_version,
    participations: row.participations,
    sourceVersion: snapshot.externalVersion,
    playerMappingsSha256: identity.sha256,
    sourceSnapshot: digest(snapshot),
    ...(replacement
      ? {
          mode: 'REPLACE_SOURCE_ROSTER',
          replacement,
          startsAt: snapshot.startsAt,
          endsAt: snapshot.endsAt,
          capacity: snapshot.capacity,
          activeReservations: row.active_reservations,
          activeWaitlist: row.active_waitlist,
        }
      : {}),
  });
  const base = {
    schema: uiObservation
      ? ('PHUB_EXACT_LEGACY_ROSTER_UI_OBSERVATION_REPLACEMENT_V1' as const)
      : replacing
        ? ('PHUB_EXACT_LEGACY_ROSTER_REPLACEMENT_V1' as const)
        : ('PHUB_EXACT_LEGACY_ROSTER_REPAIR_V1' as const),
    gameId: input.gameId,
    operationId: input.operationId,
    planSha256,
    sourceParticipants: snapshot.participants.length,
    allowLocalRemovals: replacing,
    authorizesDeploy: false as const,
    ...(uiObservation ? { uiObservation } : {}),
    ...(replacement ? { replacement: replacementReport(replacement) } : {}),
  };
  if (input.planOnly) return { ...base, status: 'PLAN' };
  need(input.expectedPlanSha256 === planSha256, 'PLAN_DRIFT');
  const result = await input.repository.rebaselineParticipants({
    tenantKey: input.tenantKey,
    snapshots: [snapshot],
    correlationId: `legacy-roster-repair:${input.operationId}:${planSha256}`,
    allowLocalRemovals: replacing,
    expected: {
      gameId: input.gameId,
      revision: Number(row.revision),
      sourceVersion: snapshot.externalVersion,
      syncSourceVersion: row.sync_version!,
      playerMappingsSha256: identity.sha256,
      ...(replacement
        ? {
            replacement: {
              participationsSha256: replacement.participationsBeforeSha256,
              retainedParticipationIdsSha256: replacement.retainedParticipationIdsSha256,
              ...(uiObservation ? { uiObservation } : {}),
            },
          }
        : {}),
    },
    now: input.now ?? new Date(),
  });
  need(
    result.skipped === 0 &&
      result.rebaselined.length + result.deferred.length === 1 &&
      [...result.rebaselined, ...result.deferred].every((item) => item.gameId === input.gameId),
    'RESULT',
  );
  return { ...base, status: result.rebaselined.length === 1 ? 'REPAIRED' : 'DEFERRED' };
}
