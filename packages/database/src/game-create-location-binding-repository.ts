import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenantTransaction } from './connection.js';

export interface CreateLocationMapping {
  id: string;
  entity_type: 'game' | 'game_station' | 'game_court';
  internal_id: string;
  external_id: string;
  external_version: string | null;
  sync_status: string;
  sync_error_code: string | null;
  last_synced_at: string | null;
}
export interface CreateLocationGame {
  id: string;
  station_id: string;
  court_id: string;
}
export interface CreateLocationLineage {
  mappings: CreateLocationMapping[];
  games: CreateLocationGame[];
  digest: string;
}
export interface GameCreateLocationBinding {
  id: string;
  court_id: string;
  station_id: string;
  court_mapping_id: string;
  provider_tenant_key: 'iSkq6G';
  provider_studio_id: string;
  provider_room_id: string;
  revision: string;
  state: 'ACTIVE' | 'REVOKED';
  lineage_digest: string;
  evidence_digest: string;
  verified_at: Date;
  expires_at: Date;
  last_command_id: string;
  last_command_hash: string;
}
export interface CreateLocationCandidate {
  courtId: string;
  stationId: string;
  courtMappingId: string;
  studioId: string;
  roomId: string;
  lineageDigest: string;
  evidenceDigest: string;
  verifiedAt: string;
}
export const createLocationDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;

async function available(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>(
    "select to_regclass('integration.game_create_location_bindings')::text as relation",
  );
  return result.rows[0]?.relation === 'integration.game_create_location_bindings';
}
/** Full tenant lineage, including historical games and every alias. Never a first-match lookup. */
export async function readCreateLocationLineage(
  client: PoolClient,
  tenantId: string,
): Promise<CreateLocationLineage> {
  const result = await client.query<{
    mappings: CreateLocationMapping[];
    games: CreateLocationGame[];
  }>(
    `select
      (select coalesce(jsonb_agg(m order by m.id),'[]'::jsonb) from
        (select id,entity_type,internal_id,external_id,external_version,sync_status,sync_error_code,last_synced_at
         from integration.external_entity_map where tenant_id=$1 and external_system='LK_LEGACY_SNAPSHOT'
         and entity_type in ('game','game_station','game_court') order by id limit 10001) m) as mappings,
      (select coalesce(jsonb_agg(g order by g.id),'[]'::jsonb) from
        (select id,station_id,court_id from games.games where tenant_id=$1 and court_id is not null order by id limit 10001) g) as games`,
    [tenantId],
  );
  const { mappings, games } = result.rows[0] ?? { mappings: [], games: [] };
  if (mappings.length > 10_000 || games.length > 10_000)
    throw new Error('CREATE_LOCATION_LINEAGE_LIMIT');
  return {
    mappings,
    games,
    digest: createLocationDigest(['CREATE_LOCATION_LINEAGE_V1', mappings, games]),
  };
}

export function createGameCreateLocationBindingRepository(pool: Pool) {
  return {
    async snapshot(
      tenantId: string,
    ): Promise<{ lineage: CreateLocationLineage; bindings: GameCreateLocationBinding[] } | null> {
      return withTenantTransaction(pool, tenantId, async (client) => {
        await client.query("set local statement_timeout = '3000ms'");
        if (!(await available(client))) return null;
        const identity = await client.query(
          `select 1 from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA' and provider_tenant_key='iSkq6G'`,
          [tenantId],
        );
        if (identity.rowCount !== 1) return null;
        const lineage = await readCreateLocationLineage(client, tenantId);
        const bindings = await client.query<GameCreateLocationBinding>(
          'select * from integration.game_create_location_bindings where tenant_id=$1 order by court_id limit 10001',
          [tenantId],
        );
        if (bindings.rows.length > 10_000) throw new Error('CREATE_LOCATION_BINDING_LIMIT');
        return { lineage, bindings: bindings.rows };
      });
    },
    async publish(input: {
      tenantId: string;
      candidate: CreateLocationCandidate;
      expectedRevision: string | null;
      commandId: string;
    }): Promise<'APPLIED' | 'REPLAYED' | 'CONFLICT'> {
      const c = input.candidate;
      if (
        ![input.tenantId, c.courtId, c.stationId, c.courtMappingId, input.commandId].every((v) =>
          uuidPattern.test(v),
        ) ||
        ![c.studioId, c.roomId].every((v) => idPattern.test(v) && !/[\r\n]/.test(v)) ||
        ![c.lineageDigest, c.evidenceDigest].every((v) => digestPattern.test(v)) ||
        !Number.isFinite(Date.parse(c.verifiedAt))
      )
        throw new Error('CREATE_LOCATION_BINDING_INPUT_INVALID');
      const requestHash = createLocationDigest([
        'CREATE_LOCATION_PUBLISH_V1',
        input.tenantId,
        c,
        input.expectedRevision,
      ]);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local statement_timeout = '3000ms'");
        // Serializes all producers, including reverse room claims. Existing import writers need not
        // cooperate: the reader independently rechecks the entire manifest on every consumption.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `create-location:${input.tenantId}`,
        ]);
        if (!(await available(client))) return 'CONFLICT';
        const old = (
          await client.query<GameCreateLocationBinding>(
            'select * from integration.game_create_location_bindings where tenant_id=$1 and court_id=$2 for update',
            [input.tenantId, c.courtId],
          )
        ).rows[0];
        if (old?.last_command_id === input.commandId)
          return old.last_command_hash === requestHash ? 'REPLAYED' : 'CONFLICT';
        if ((old?.revision ?? null) !== input.expectedRevision) return 'CONFLICT';
        const lineage = await readCreateLocationLineage(client, input.tenantId);
        if (
          lineage.digest !== c.lineageDigest ||
          !lineage.mappings.some(
            (m) =>
              m.id === c.courtMappingId &&
              m.internal_id === c.courtId &&
              m.entity_type === 'game_court',
          )
        )
          return 'CONFLICT';
        const eligible = await client.query(
          `select 1 from locations.profiles where tenant_id=$1 and id=$2 and publication_status='PUBLISHED'
            and $3::timestamptz <= clock_timestamp() and $3::timestamptz > clock_timestamp()-interval '5 minutes'
            and exists(select 1 from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA' and provider_tenant_key='iSkq6G')`,
          [input.tenantId, c.stationId, c.verifiedAt],
        );
        if (eligible.rowCount !== 1) return 'CONFLICT';
        const collision = await client.query(
          `select 1 from integration.game_create_location_bindings where tenant_id=$1 and court_id<>$2 and provider_tenant_key='iSkq6G' and provider_room_id=$3 and state='ACTIVE'`,
          [input.tenantId, c.courtId, c.roomId],
        );
        if (collision.rowCount !== 0) return 'CONFLICT';
        const result = await client.query<GameCreateLocationBinding>(
          `insert into integration.game_create_location_bindings(tenant_id,court_id,station_id,court_mapping_id,provider_tenant_key,provider_studio_id,provider_room_id,revision,state,lineage_digest,evidence_digest,verified_at,expires_at,last_command_id,last_command_hash)
           values($1,$2,$3,$4,'iSkq6G',$5,$6,1,'ACTIVE',$7,$8,$9::timestamptz,$9::timestamptz+interval '5 minutes',$10,$11)
           on conflict(tenant_id,court_id) do update set station_id=excluded.station_id,court_mapping_id=excluded.court_mapping_id,
            provider_studio_id=excluded.provider_studio_id,provider_room_id=excluded.provider_room_id,
            revision=game_create_location_bindings.revision+1,state='ACTIVE',revoked_at=null,
            lineage_digest=excluded.lineage_digest,evidence_digest=excluded.evidence_digest,verified_at=excluded.verified_at,expires_at=excluded.expires_at,
            last_command_id=excluded.last_command_id,last_command_hash=excluded.last_command_hash returning *`,
          [
            input.tenantId,
            c.courtId,
            c.stationId,
            c.courtMappingId,
            c.studioId,
            c.roomId,
            c.lineageDigest,
            c.evidenceDigest,
            c.verifiedAt,
            input.commandId,
            requestHash,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('CREATE_LOCATION_BINDING_WRITE_FAILED');
        await record(client, input.tenantId, row, input.commandId);
        return 'APPLIED';
      });
    },
    async revoke(input: {
      tenantId: string;
      courtId: string;
      expectedRevision: string;
      correlationId: string;
    }): Promise<boolean> {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<GameCreateLocationBinding>(
          `update integration.game_create_location_bindings set state='REVOKED',revoked_at=clock_timestamp(),revision=revision+1
           where tenant_id=$1 and court_id=$2 and revision=$3 and state='ACTIVE' returning *`,
          [input.tenantId, input.courtId, input.expectedRevision],
        );
        if (!result.rows[0]) return false;
        await record(client, input.tenantId, result.rows[0], input.correlationId);
        return true;
      });
    },
  };
}
async function record(
  client: PoolClient,
  tenantId: string,
  row: GameCreateLocationBinding,
  correlationId: string,
) {
  // Audit/outbox intentionally contain only public identifiers and hashes, never provider IDs.
  const payload = JSON.stringify({
    bindingId: row.id,
    courtId: row.court_id,
    stationId: row.station_id,
    revision: row.revision,
    state: row.state,
  });
  await client.query(
    `insert into audit.audit_log(tenant_id,action,resource_type,resource_id,result,correlation_id,new_value)
    values($1,'GAME_CREATE_LOCATION_BINDING_CHANGED','GAME_CREATE_LOCATION_BINDING',$2,'SUCCESS',$3,$4::jsonb)`,
    [tenantId, row.id, correlationId, payload],
  );
  await client.query(
    `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload)
    values($1,'games.create_location_binding.changed.v1',$2,$3,$4::jsonb)`,
    [tenantId, row.id, correlationId, payload],
  );
}

/** Integration-only reader. Never spread this result into a public draft or game DTO. */
export async function resolveGameCreateLocationBinding(
  client: PoolClient,
  input: { tenantId: string; courtId: string; stationId: string },
): Promise<GameCreateLocationBinding | null> {
  if (!(await available(client))) return null;
  const result = await client.query<GameCreateLocationBinding>(
    `select binding.* from integration.game_create_location_bindings binding
     join locations.profiles station on station.tenant_id=binding.tenant_id and station.id=binding.station_id and station.publication_status='PUBLISHED'
     join integration.external_entity_map mapping on mapping.tenant_id=binding.tenant_id and mapping.id=binding.court_mapping_id
      and mapping.internal_id=binding.court_id and mapping.external_system='LK_LEGACY_SNAPSHOT' and mapping.entity_type='game_court'
     join integration.identity_provider_bindings identity_binding on identity_binding.tenant_id=binding.tenant_id
      and identity_binding.provider='VIVA' and identity_binding.provider_tenant_key=binding.provider_tenant_key
     where binding.tenant_id=$1 and binding.court_id=$2 and binding.station_id=$3 and binding.state='ACTIVE'
      and binding.verified_at<=clock_timestamp() and binding.expires_at>clock_timestamp()
      for share of binding,station,mapping,identity_binding`,
    [input.tenantId, input.courtId, input.stationId],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const lineage = await readCreateLocationLineage(client, input.tenantId);
  if (lineage.digest !== row.lineage_digest) return null;
  const fresh = await client.query(`select 1 where $1::timestamptz > clock_timestamp()`, [
    row.expires_at,
  ]);
  return fresh.rowCount === 1 ? row : null;
}
