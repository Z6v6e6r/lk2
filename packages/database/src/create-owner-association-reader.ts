import { createHash } from 'node:crypto';

import {
  createOriginalBindingSchema,
  CreateOriginalAssociationReadError,
  type CreateOriginalAssociationReader,
} from '../../games/src/create-financial-proof-resolver.js';
import type { Pool } from 'pg';
import { z } from 'zod';

const revision = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const entity = z
  .object({
    tenantId: z.uuid(),
    id: z.uuid(),
    revision,
    internalId: z.uuid(),
    externalId: z.uuid(),
  })
  .strict();
// Exact ordered C1-v1.2 mapping digest, including private actor/subscription IDs.
// The slot's source must be explicitly selected by the future trusted owner composition.
const privateMappings = z
  .object({
    actor: entity,
    subscription: entity,
    slot: z
      .object({
        tenantId: z.uuid(),
        id: z.uuid(),
        revision,
        internalId: z.uuid(),
        slotVersion: revision,
      })
      .strict(),
  })
  .strict();
export function createMappingBindingSha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(privateMappings.parse(value)))
    .digest('hex')}`;
}

export function createOwnerAssociationReader(
  pool: Pool,
  options: {
    readonly slotSource?: { readonly externalSystem: string; readonly entityType: string };
  } = {},
): CreateOriginalAssociationReader {
  return {
    async load(input) {
      const lookup = z
        .object({ tenantId: z.uuid(), actorUserId: z.uuid(), operationId: z.uuid() })
        .strict()
        .parse(input);
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query('begin isolation level repeatable read read only');
        await client.query("set local statement_timeout = '1500ms'");
        await client.query("select set_config('app.tenant_id', $1, true)", [lookup.tenantId]);
        const rows = await client.query<{
          binding: unknown;
          recorded_at: Date;
          owner_contract_version: string;
          binding_schema_version: number;
        }>(
          `select association.binding, association.recorded_at, association.owner_contract_version, association.binding_schema_version
           from games.create_owner_associations association
           join games.operations op on op.tenant_id=association.tenant_id and op.id=association.operation_id
             and op.kind='CREATE_GAME' and op.game_id=association.game_id
             and op.requested_by_user_id=association.actor_user_id
           join games.games game on game.tenant_id=association.tenant_id and game.id=association.game_id
             and game.organizer_user_id=association.actor_user_id
             and game.payment_mode='SUBSCRIPTION' and game.kind='FRIENDLY'
             and game.visibility='PUBLIC' and game.capacity=4
           join games.command_idempotency command on command.tenant_id=association.tenant_id
             and command.id=association.operation_id and command.aggregate_id=association.game_id
             and command.actor_user_id=association.actor_user_id and command.command_type='game.create.v1'
             and command.state='COMPLETED' and command.request_hash=association.game_request_hash
             and command.principal_key='user:' || association.actor_user_id::text
             and command.result_payload->>'operationId'=association.operation_id::text
             and command.result_payload->>'gameId'=association.game_id::text
             and association.key_sha256='sha256:' || encode(public.digest(command.idempotency_key,'sha256'),'hex')
           where association.tenant_id=$1 and association.actor_user_id=$2 and association.operation_id=$3
           limit 2`,
          [lookup.tenantId, lookup.actorUserId, lookup.operationId],
        );
        const row = rows.rows.length === 1 ? rows.rows[0] : undefined;
        const binding = createOriginalBindingSchema.safeParse(row?.binding);
        if (!row) return null;
        if (row.owner_contract_version !== 'C1-v1.2' || row.binding_schema_version !== 1)
          throw new CreateOriginalAssociationReadError('ORIGINAL_UNSUPPORTED');
        if (!binding.success) throw new CreateOriginalAssociationReadError('ORIGINAL_INVALID');
        if (!options.slotSource)
          throw new CreateOriginalAssociationReadError('MAPPING_UNAVAILABLE');
        const original = binding.data;
        if (
          original.tenantId !== lookup.tenantId ||
          original.actorUserId !== lookup.actorUserId ||
          original.operationId !== lookup.operationId
        )
          return null;
        const current: Record<string, unknown> = {};
        for (const kind of ['actor', 'subscription', 'slot'] as const) {
          const expected = original.mappings[kind];
          const source =
            kind === 'slot'
              ? options.slotSource
              : {
                  externalSystem: 'VIVA',
                  entityType: kind === 'actor' ? 'viva_profile' : 'subscription',
                };
          // Query by canonical owner identity, not only row UUID: detect competing aliases.
          const mappings = await client.query<{
            id: string;
            tenant_id: string;
            internal_id: string;
            external_id: string;
            external_version: string;
          }>(
            `select id, tenant_id, internal_id, external_id, external_version
             from integration.external_entity_map
             where tenant_id=$1 and internal_id=$2 and external_system=$3 and entity_type=$4
               and sync_status='synced' and sync_error_code is null and last_synced_at is not null
             limit 2`,
            [lookup.tenantId, expected.internalId, source.externalSystem, source.entityType],
          );
          const mapping = mappings.rows.length === 1 ? mappings.rows[0] : undefined;
          if (!mapping || !mapping.external_version)
            throw new CreateOriginalAssociationReadError('MAPPING_UNAVAILABLE');
          if (
            mapping.id !== expected.id ||
            mapping.tenant_id !== expected.tenantId ||
            mapping.internal_id !== expected.internalId ||
            mapping.external_version !== expected.revision
          )
            throw new CreateOriginalAssociationReadError('MAPPING_CONFLICT');
          current[kind] = {
            tenantId: mapping.tenant_id,
            id: mapping.id,
            revision: mapping.external_version,
            internalId: mapping.internal_id,
            ...(kind === 'slot'
              ? { slotVersion: original.slotVersion }
              : { externalId: mapping.external_id }),
          };
        }
        if (createMappingBindingSha256(current) !== original.mappingBindingSha256)
          throw new CreateOriginalAssociationReadError('MAPPING_CONFLICT');
        await client.query('commit');
        committed = true;
        return { binding: original, recordedAt: row.recorded_at.toISOString() };
      } finally {
        // Also closes early-return/failed reads; there is no write path or owner dispatch.
        try {
          if (!committed) await client.query('rollback');
        } finally {
          client.release();
        }
      }
    },
  };
}
