import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { WorkerConfig } from '@phub/config';
import {
  createGameCreateLocationBindingRepository,
  createLocationDigest,
  type CreateLocationLineage,
  type CreateLocationCandidate,
} from '../../../packages/database/src/game-create-location-binding-repository.js';
import {
  LegacyGamesMongoAdapter,
  type LegacyCreateLocationEvidence,
} from '@phub/legacy-games-adapter';
import { VivaCreateLocationSource, CreateLocationProviderContradiction } from '@phub/viva-adapter';
import { readNotificationCredentialFile } from './notification-provider-credentials.js';

const credentials = z
  .object({
    purpose: z.literal('GAME_CREATE_LOCATION_BINDING'),
    providerTenantKey: z.literal('iSkq6G'),
    accessToken: z
      .string()
      .min(20)
      .max(12_000)
      .refine((s) => !/[\r\n]/.test(s)),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Every alias and historical source game must agree; no alias ordering carries authority. */
export function deriveCreateLocationCandidate(
  lineage: CreateLocationLineage,
  evidence: readonly LegacyCreateLocationEvidence[],
  courtId: string,
  verifiedAt: string,
): CreateLocationCandidate | null {
  const court = lineage.mappings.filter(
    (m) => m.entity_type === 'game_court' && m.internal_id === courtId,
  );
  const games = lineage.games.filter((g) => g.court_id === courtId);
  if (!court.length || !games.length || new Set(games.map((g) => g.station_id)).size !== 1)
    return null;
  const stationId = games[0]!.station_id;
  const station = lineage.mappings.filter(
    (m) => m.entity_type === 'game_station' && m.internal_id === stationId,
  );
  if (!station.length) return null;
  // An orphaned historical alias cannot be assigned to any court safely.
  if (
    lineage.mappings.some(
      (m) => m.entity_type === 'game' && !lineage.games.some((g) => g.id === m.internal_id),
    )
  )
    return null;
  const used: LegacyCreateLocationEvidence[] = [];
  for (const game of games) {
    const aliases = lineage.mappings.filter(
      (m) => m.entity_type === 'game' && m.internal_id === game.id,
    );
    if (!aliases.length) continue; // Local drafts supply no provider evidence.
    const matches = evidence.filter((e) =>
      aliases.some((m) => e.gameAliases.includes(m.external_id)),
    );
    if (matches.length !== 1) return null;
    const match = matches[0]!;
    if (
      aliases.some(
        (m) =>
          m.sync_status !== 'synced' ||
          m.sync_error_code !== null ||
          !m.external_version ||
          !m.last_synced_at ||
          !match.gameAliases.includes(m.external_id),
      )
    )
      return null;
    used.push(match);
  }
  if (!used.length) return null;
  const first = used[0]!;
  if (
    used.some(
      (e) =>
        e.studioId !== first.studioId ||
        e.roomId !== first.roomId ||
        Date.parse(e.sourceUpdatedAt) > Date.parse(verifiedAt),
    )
  )
    return null;
  if (
    court.some(
      (m) =>
        m.sync_status !== 'synced' ||
        m.sync_error_code !== null ||
        !m.external_version ||
        !m.last_synced_at ||
        !first.courtAliases.includes(m.external_id),
    ) ||
    station.some(
      (m) =>
        m.sync_status !== 'synced' ||
        m.sync_error_code !== null ||
        !m.external_version ||
        !m.last_synced_at ||
        !first.stationAliases.includes(m.external_id),
    )
  )
    return null;
  // Reverse proof also examines the actual raw source rows behind OTHER canonical games. Their
  // court/station aliases might already be corrupt, so alias equality alone is insufficient.
  for (const source of evidence) {
    const canonicalIds = new Set(
      lineage.mappings
        .filter((m) => m.entity_type === 'game' && source.gameAliases.includes(m.external_id))
        .map((m) => m.internal_id),
    );
    if (canonicalIds.size > 1) return null;
    const referenced = lineage.games.filter((g) => canonicalIds.has(g.id));
    if (
      referenced.some(
        (g) =>
          (source.roomId === first.roomId && g.court_id !== courtId) ||
          (source.studioId === first.studioId && g.station_id !== stationId),
      )
    )
      return null;
  }
  if (
    lineage.mappings.some(
      (m) =>
        (m.entity_type === 'game_court' &&
          m.internal_id !== courtId &&
          first.courtAliases.includes(m.external_id)) ||
        (m.entity_type === 'game_station' &&
          m.internal_id !== stationId &&
          first.stationAliases.includes(m.external_id)),
    )
  )
    return null;
  return {
    courtId,
    stationId,
    courtMappingId: [...court].sort((a, b) => a.id.localeCompare(b.id))[0]!.id,
    studioId: first.studioId,
    roomId: first.roomId,
    lineageDigest: lineage.digest,
    evidenceDigest: createLocationDigest([
      'CREATE_LOCATION_EVIDENCE_V1',
      [...used].sort((a, b) => a.gameAliases[0]!.localeCompare(b.gameAliases[0]!)),
    ]),
    verifiedAt,
  };
}

export async function runGameCreateLocationBindingSync(input: {
  pool: Pool;
  config: Pick<
    WorkerConfig,
    | 'GAME_CREATE_LOCATION_BINDING_SYNC_ENABLED'
    | 'GAME_CREATE_LOCATION_BINDING_TENANT_ID'
    | 'GAME_CREATE_LOCATION_BINDING_ADMIN_CREDENTIAL_FILE'
    | 'LEGACY_GAMES_MONGODB_URI'
  >;
  dependencies?: {
    repository?: ReturnType<typeof createGameCreateLocationBindingRepository>;
    readCredentials?: typeof readNotificationCredentialFile;
    source?: Pick<LegacyGamesMongoAdapter, 'readCreateLocationEvidence'>;
    provider?: Pick<VivaCreateLocationSource, 'readRoomStudio'>;
    now?: () => number;
  };
}): Promise<{
  outcome: 'DISABLED' | 'UNAVAILABLE' | 'COMPLETE';
  applied: number;
  revoked: number;
  failed: number;
}> {
  const summary = { applied: 0, revoked: 0, failed: 0 };
  if (!input.config.GAME_CREATE_LOCATION_BINDING_SYNC_ENABLED)
    return { outcome: 'DISABLED', ...summary };
  const tenantId = input.config.GAME_CREATE_LOCATION_BINDING_TENANT_ID;
  const file = input.config.GAME_CREATE_LOCATION_BINDING_ADMIN_CREDENTIAL_FILE;
  const uri = input.config.LEGACY_GAMES_MONGODB_URI;
  if (!tenantId || !file || !uri) return { outcome: 'UNAVAILABLE', ...summary };
  const deps = input.dependencies ?? {};
  const now = deps.now ?? Date.now;
  try {
    const repository = deps.repository ?? createGameCreateLocationBindingRepository(input.pool);
    const snapshot = await repository.snapshot(tenantId);
    if (!snapshot) return { outcome: 'UNAVAILABLE', ...summary };
    const credential = credentials.parse(
      await (deps.readCredentials ?? readNotificationCredentialFile)(file),
    );
    if (Date.parse(credential.expiresAt) <= now() + 30_000)
      return { outcome: 'UNAVAILABLE', ...summary };
    const source = deps.source ?? new LegacyGamesMongoAdapter({ uri });
    const provider = deps.provider ?? new VivaCreateLocationSource();
    const verifiedAt = new Date(now()).toISOString();
    const evidence = await source.readCreateLocationEvidence(
      snapshot.lineage.mappings.filter((m) => m.entity_type === 'game').map((m) => m.external_id),
    );
    const courts = new Set([
      ...snapshot.lineage.mappings
        .filter((m) => m.entity_type === 'game_court')
        .map((m) => m.internal_id),
      ...snapshot.bindings.map((b) => b.court_id),
    ]);
    for (const courtId of courts) {
      const old = snapshot.bindings.find((b) => b.court_id === courtId);
      const candidate = deriveCreateLocationCandidate(
        snapshot.lineage,
        evidence,
        courtId,
        verifiedAt,
      );
      if (!candidate) {
        if (
          old?.state === 'ACTIVE' &&
          (await repository.revoke({
            tenantId,
            courtId,
            expectedRevision: old.revision,
            correlationId: randomUUID(),
          }))
        )
          summary.revoked++;
        continue;
      }
      try {
        // Budget expiry fails closed without renewing prior evidence. Fresh next cycle can retry.
        if (
          now() - Date.parse(verifiedAt) >= 300_000 ||
          Date.parse(credential.expiresAt) <= now() + 30_000
        ) {
          summary.failed++;
          continue;
        }
        const room = await provider.readRoomStudio({
          providerTenantKey: credential.providerTenantKey,
          studioId: candidate.studioId,
          roomId: candidate.roomId,
          accessToken: credential.accessToken,
          correlationId: randomUUID(),
        });
        if (
          room.roomId !== candidate.roomId ||
          room.studioId !== candidate.studioId ||
          Date.parse(room.observedAt) < Date.parse(verifiedAt) ||
          Date.parse(room.observedAt) > now()
        )
          throw new Error('CREATE_LOCATION_PROVIDER_EVIDENCE_INVALID');
        const result = await repository.publish({
          tenantId,
          candidate,
          expectedRevision: old?.revision ?? null,
          commandId: randomUUID(),
        });
        if (result === 'APPLIED') summary.applied++;
        else if (result === 'CONFLICT') summary.failed++;
      } catch (error) {
        summary.failed++;
        if (
          error instanceof CreateLocationProviderContradiction &&
          old?.state === 'ACTIVE' &&
          (await repository.revoke({
            tenantId,
            courtId,
            expectedRevision: old.revision,
            correlationId: randomUUID(),
          }))
        )
          summary.revoked++;
      }
    }
    return { outcome: 'COMPLETE', ...summary };
  } catch {
    return { outcome: 'UNAVAILABLE', ...summary, failed: summary.failed + 1 };
  }
}
