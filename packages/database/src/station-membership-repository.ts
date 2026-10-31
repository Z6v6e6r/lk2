import type { Pool, PoolClient } from 'pg';
import {
  parseStationLocationEvidence,
  parseStationMarker,
  stationCanonical,
  stationUuid,
  type StationLocationEvidence,
  type StationMarker,
} from '@phub/subscription-runtime-adapter';
import { withTenantTransaction } from './connection.js';
import { resolveGameCreateLocationBinding } from './game-create-location-binding-repository.js';
import type { PaidJoinProviderBinding } from './game-roster-repository.js';

/** Uses the verified studio/room binding, never ambiguous legacy station aliases. */
export async function resolveStationJoinLocation(
  client: PoolClient,
  input: {
    tenantId: string;
    gameId: string;
    expectedRevision: number;
    providerBinding: PaidJoinProviderBinding;
  },
): Promise<StationLocationEvidence | null> {
  const games = await client.query<{ station_id: string; court_id: string }>(
    `select g.station_id,g.court_id from games.games g
     join integration.external_entity_map m on m.tenant_id=g.tenant_id and m.internal_id=g.id
       and m.external_system='VIVA' and m.entity_type='exercise' and m.id=$4 and m.external_id=$5 and m.external_version=$6
       and m.sync_status='synced' and m.sync_error_code is null and m.last_synced_at is not null
     where g.tenant_id=$1 and g.id=$2 and g.revision=$3 and g.court_id is not null
     for share of g,m`,
    [
      input.tenantId,
      input.gameId,
      input.expectedRevision,
      input.providerBinding.targetMappingId,
      input.providerBinding.providerExerciseId,
      input.providerBinding.targetVersion,
    ],
  );
  if (games.rows.length !== 1) return null;
  const game = games.rows[0]!;
  const binding = await resolveGameCreateLocationBinding(client, {
    tenantId: input.tenantId,
    stationId: game.station_id,
    courtId: game.court_id,
  });
  if (!binding || binding.provider_tenant_key !== 'iSkq6G') return null;
  // Require this exact imported game's source lineage, not another court's coincidental location.
  const imported = await client.query(
    `select 1 from integration.external_entity_map where tenant_id=$1 and internal_id=$2
     and external_system='LK_LEGACY_SNAPSHOT' and entity_type='game' and external_id=$3
     and sync_status='synced' and sync_error_code is null and last_synced_at is not null`,
    [input.tenantId, input.gameId, input.providerBinding.providerExerciseId],
  );
  if (imported.rowCount !== 1) return null;
  return parseStationLocationEvidence({
    bindingId: binding.id,
    revision: String(binding.revision),
    stationId: game.station_id,
    courtId: game.court_id,
    providerStationId: binding.provider_studio_id,
    providerRoomId: binding.provider_room_id,
    lineageDigest: binding.lineage_digest,
    evidenceDigest: binding.evidence_digest,
    targetMappingId: input.providerBinding.targetMappingId,
    targetVersion: input.providerBinding.targetVersion,
    providerExerciseId: input.providerBinding.providerExerciseId,
  });
}
export async function fenceStationMarker(
  client: PoolClient,
  input: {
    tenantId: string;
    actorUserId: string;
    gameId: string;
    operationId: string;
    expectedRevision: number;
    providerBinding?: PaidJoinProviderBinding;
  },
  raw: StationMarker,
): Promise<StationMarker> {
  const marker = parseStationMarker(raw);
  if (marker.outcome === 'NO_ENROLLMENT') return marker;
  if (
    marker.actor.tenantId !== input.tenantId ||
    marker.actor.canonicalUserId !== input.actorUserId ||
    marker.request.operationId !== input.operationId ||
    marker.request.activity.id !== input.gameId ||
    marker.actor.playerId !== input.providerBinding?.providerClientId ||
    marker.actor.providerMappingId !== input.providerBinding.providerMappingId
  )
    throw new Error('STATION_MEMBERSHIP_BINDING_INVALID');
  const current = await resolveStationJoinLocation(client, {
    ...input,
    providerBinding: input.providerBinding,
  });
  return current && stationCanonical(current) === stationCanonical(marker.location)
    ? marker
    : { version: 1, outcome: 'NO_ENROLLMENT', reason: 'STATION_BINDING_CHANGED' };
}
export interface StationConfirmedFact {
  actor: Extract<StationMarker, { outcome: 'OWNER_ADMISSION' }>['actor'];
  request: {
    contractVersion: 1;
    operationId: string;
    admissionId: string;
    admissionBindingSha256: string;
    confirmation: { kind: 'GAME_PARTICIPATION'; generationId: string; activityId: string };
  };
  correlationId: string;
}
export function createStationMembershipRepository(pool: Pool) {
  return {
    resolveLocation: (input: Parameters<typeof resolveStationJoinLocation>[1]) =>
      withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local statement_timeout='3000ms'");
        return resolveStationJoinLocation(client, input);
      }),
    async loadConfirmedFact(input: {
      tenantId: string;
      eventId: string;
      gameId: string;
      userId: string;
      participationId: string;
    }): Promise<StationConfirmedFact | null> {
      if (
        ![input.tenantId, input.eventId, input.gameId, input.userId, input.participationId].every(
          stationUuid,
        )
      )
        throw new Error('STATION_MEMBERSHIP_EVENT_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local statement_timeout='3000ms'");
        const rows = await client.query<{
          snapshot: unknown;
          operation_id: string;
          eligibility_decision_id: string;
          correlation_id: string;
        }>(
          `select s.snapshot,s.operation_id,p.eligibility_decision_id,o.correlation_id
           from audit.outbox_events o
           join games.participations p on p.tenant_id=o.tenant_id and p.game_id=o.aggregate_id and p.id=$5 and p.user_id=$4
           join eligibility.payment_snapshots s on s.tenant_id=p.tenant_id and s.decision_id=p.eligibility_decision_id
             and s.player_id=p.user_id and s.activity_type='GAME' and s.activity_id=p.game_id
           where o.tenant_id=$1 and o.id=$2 and o.aggregate_id=$3 and o.event_type='game.participation.confirmed.v1'
             and o.payload->>'participationId'=$5::text and o.payload->>'userId'=$4::text`,
          [input.tenantId, input.eventId, input.gameId, input.userId, input.participationId],
        );
        if (rows.rows.length !== 1) return null;
        const row = rows.rows[0]!,
          snapshot = row.snapshot as Record<string, unknown>;
        if (!snapshot?.stationMembership) return null; // Permanent pre-adoption no-enrollment.
        const marker = parseStationMarker(snapshot.stationMembership);
        if (
          marker.outcome !== 'OWNER_ADMISSION' ||
          marker.response.admission.outcome !== 'ADMITTED'
        )
          return null;
        // Dynamic import avoids the roster->fence->roster cycle at module initialization.
        const { loadManagedSelfLeaveJoinAuthority } = await import('./game-roster-repository.js');
        const authority = await loadManagedSelfLeaveJoinAuthority(client, {
          ...input,
          actorUserId: input.userId,
          eligibilityDecisionId: row.eligibility_decision_id,
          allowSplitSubscription: true,
        });
        const managed = snapshot.managedJoin as { requestFingerprint?: string } | undefined;
        if (marker.request.requestSha256 !== 'sha256:' + managed?.requestFingerprint)
          throw new Error('STATION_MEMBERSHIP_FACT_INVALID');
        const provider = snapshot.providerBinding as PaidJoinProviderBinding | undefined;
        if (
          !authority ||
          authority.receipt.operationId !== row.operation_id ||
          marker.request.operationId !== row.operation_id ||
          marker.request.activity.id !== input.gameId ||
          marker.actor.tenantId !== input.tenantId ||
          marker.actor.canonicalUserId !== input.userId ||
          marker.actor.playerId !== provider?.providerClientId ||
          marker.actor.providerMappingId !== provider.providerMappingId ||
          marker.location.providerExerciseId !== provider.providerExerciseId ||
          marker.location.targetMappingId !== provider.targetMappingId ||
          marker.location.targetVersion !== provider.targetVersion
        )
          throw new Error('STATION_MEMBERSHIP_FACT_INVALID');
        return {
          actor: marker.actor,
          correlationId: row.correlation_id,
          request: {
            contractVersion: 1,
            operationId: row.operation_id,
            admissionId: marker.response.admission.admissionId,
            admissionBindingSha256: marker.response.admission.bindingSha256,
            confirmation: {
              kind: 'GAME_PARTICIPATION',
              generationId: input.participationId,
              activityId: input.gameId,
            },
          },
        };
      });
    },
  };
}
