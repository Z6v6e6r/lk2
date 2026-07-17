import {
  DEFAULT_PROFILE_PRIVACY_SETTINGS,
  PROFILE_ACTION_POLICIES,
  PROFILE_PRIVACY_CHANGED_EVENT,
  type ProfileActionPolicy,
  type ProfilePrivacySettings,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type ProfilePrivacyCommandResult =
  | {
      readonly outcome: 'applied';
      readonly settings: ProfilePrivacySettings;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'version_conflict'; readonly current: ProfilePrivacySettings };

export interface ProfilePrivacyRepository {
  get(tenantId: string, userId: string): Promise<ProfilePrivacySettings>;
  update(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly expectedVersion: number;
    readonly contactPolicy: ProfileActionPolicy;
    readonly chatPolicy: ProfileActionPolicy;
  }): Promise<ProfilePrivacyCommandResult>;
}

interface PrivacyRow extends QueryResultRow {
  readonly contact_policy: ProfileActionPolicy;
  readonly chat_policy: ProfileActionPolicy;
  readonly version: number;
  readonly updated_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly result_payload: unknown;
}

const PRIVACY_COLUMNS = 'contact_policy, chat_policy, version, updated_at';

function isPolicy(value: unknown): value is ProfileActionPolicy {
  return (
    typeof value === 'string' && PROFILE_ACTION_POLICIES.includes(value as ProfileActionPolicy)
  );
}

function mapRow(row: PrivacyRow): ProfilePrivacySettings {
  return {
    contactPolicy: row.contact_policy,
    chatPolicy: row.chat_policy,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function parseStoredSettings(value: unknown): ProfilePrivacySettings {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('contactPolicy' in value) ||
    !isPolicy(value.contactPolicy) ||
    !('chatPolicy' in value) ||
    !isPolicy(value.chatPolicy) ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 0 ||
    !('updatedAt' in value) ||
    (value.updatedAt !== null && typeof value.updatedAt !== 'string')
  ) {
    throw new Error('PROFILE_PRIVACY_COMMAND_RESULT_INVALID');
  }
  return {
    contactPolicy: value.contactPolicy,
    chatPolicy: value.chatPolicy,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

async function currentCommand(
  client: PoolClient,
  input: { readonly tenantId: string; readonly userId: string; readonly idempotencyKey: string },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select request_hash, result_payload
       from profile.privacy_commands
      where tenant_id = $1 and user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.userId, input.idempotencyKey],
  );
}

function replayCommand(
  command: CommandRow | undefined,
  requestHash: string,
): ProfilePrivacyCommandResult | undefined {
  if (!command) return undefined;
  if (command.request_hash !== requestHash) return { outcome: 'idempotency_conflict' };
  return {
    outcome: 'applied',
    settings: parseStoredSettings(command.result_payload),
    replayed: true,
  };
}

async function currentSettings(
  client: PoolClient,
  tenantId: string,
  userId: string,
  lock = false,
): Promise<ProfilePrivacySettings> {
  const row = await queryOne<PrivacyRow>(
    client,
    `select ${PRIVACY_COLUMNS}
       from profile.privacy_settings
      where tenant_id = $1 and user_id = $2${lock ? ' for update' : ''}`,
    [tenantId, userId],
  );
  return row ? mapRow(row) : { ...DEFAULT_PROFILE_PRIVACY_SETTINGS };
}

async function recordChange(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly previous: ProfilePrivacySettings;
    readonly settings: ProfilePrivacySettings;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, 'PROFILE_PRIVACY_UPDATED', 'PROFILE_PRIVACY', $3,
               'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.userId,
      input.correlationId,
      JSON.stringify(input.previous),
      JSON.stringify(input.settings),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      PROFILE_PRIVACY_CHANGED_EVENT,
      input.userId,
      input.correlationId,
      JSON.stringify({
        userId: input.userId,
        version: input.settings.version,
        contactPolicy: input.settings.contactPolicy,
        chatPolicy: input.settings.chatPolicy,
      }),
    ],
  );
}

export function createProfilePrivacyRepository(pool: Pool): ProfilePrivacyRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, (client) =>
        currentSettings(client, tenantId, userId),
      );
    },

    update(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `profile-privacy:${input.tenantId}:${input.userId}`,
        ]);
        const replay = replayCommand(await currentCommand(client, input), input.requestHash);
        if (replay) return replay;

        const previous = await currentSettings(client, input.tenantId, input.userId, true);
        if (previous.version !== input.expectedVersion) {
          return { outcome: 'version_conflict', current: previous };
        }

        const row = await queryOne<PrivacyRow>(
          client,
          `insert into profile.privacy_settings (
             tenant_id, user_id, contact_policy, chat_policy, version, updated_by
           ) values ($1, $2, $3, $4, 1, $5)
           on conflict (tenant_id, user_id) do update set
             contact_policy = excluded.contact_policy,
             chat_policy = excluded.chat_policy,
             version = profile.privacy_settings.version + 1,
             updated_by = excluded.updated_by,
             updated_at = now()
           where profile.privacy_settings.version = $6
           returning ${PRIVACY_COLUMNS}`,
          [
            input.tenantId,
            input.userId,
            input.contactPolicy,
            input.chatPolicy,
            input.actorUserId,
            input.expectedVersion,
          ],
        );
        if (!row) {
          const current = await currentSettings(client, input.tenantId, input.userId, true);
          return { outcome: 'version_conflict', current };
        }
        const settings = mapRow(row);
        await client.query(
          `insert into profile.privacy_commands (
             tenant_id, user_id, idempotency_key, request_hash, expected_version, result_payload
           ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            input.tenantId,
            input.userId,
            input.idempotencyKey,
            input.requestHash,
            input.expectedVersion,
            JSON.stringify(settings),
          ],
        );
        await recordChange(client, { ...input, previous, settings });
        return { outcome: 'applied', settings, replayed: false };
      });
    },
  };
}
