import { createHash } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type ContactType = 'PHONE' | 'EMAIL';
export type ContactSourceKind = 'LOCAL' | 'VIVA';

/** The actor and correlation are supplied by a trusted server context, never by a browser DTO. */
interface ContactCommandContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface CreateContactInput extends ContactCommandContext {
  readonly userId: string;
  readonly type: ContactType;
  /** Already normalized. This repository validates but never rewrites an address. */
  readonly normalizedValue: string;
  readonly sourceKind: ContactSourceKind;
  readonly sourceUpdatedAt?: string;
}

export interface UpdateContactProvenanceInput extends ContactCommandContext {
  readonly contactId: string;
  readonly expectedVersion: number;
  readonly sourceKind: ContactSourceKind;
  readonly sourceUpdatedAt?: string;
}

export interface Contact {
  readonly id: string;
  readonly userId: string;
  readonly type: ContactType;
  readonly normalizedValue: string;
  readonly sourceKind: ContactSourceKind;
  readonly sourceUpdatedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CreateContactResult =
  | {
      readonly outcome: 'created' | 'existing';
      readonly contactId: string;
      readonly version: number;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export type UpdateContactProvenanceResult =
  | {
      readonly outcome: 'updated';
      readonly contactId: string;
      readonly version: number;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'conflict' | 'source_stale' | 'idempotency_conflict' };

interface ContactRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly type: ContactType;
  readonly normalized_value: string;
  readonly source_kind: ContactSourceKind;
  readonly source_updated_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly operation: 'CREATE' | 'UPDATE_PROVENANCE';
  readonly contact_id: string;
  readonly outcome: 'created' | 'existing' | 'updated';
  readonly result_version: number;
}

const CONTACT_COLUMNS = `id, user_id, type, normalized_value, source_kind, source_updated_at,
  version, created_at, updated_at`;

function assertKeys(input: object, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error('CONTACT_INPUT_INVALID');
  }
}

function assertContext(input: ContactCommandContext): void {
  if (
    !input.tenantId ||
    !input.actorId ||
    !input.correlationId ||
    !/^[A-Za-z0-9:_-]{16,128}$/.test(input.idempotencyKey)
  ) {
    throw new Error('CONTACT_INPUT_INVALID');
  }
}

function assertSource(kind: ContactSourceKind, updatedAt?: string): void {
  if (kind !== 'LOCAL' && kind !== 'VIVA') throw new Error('CONTACT_INPUT_INVALID');
  if (kind === 'VIVA' && !updatedAt) throw new Error('CONTACT_INPUT_INVALID');
  if (
    updatedAt &&
    (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(updatedAt) ||
      !Number.isFinite(Date.parse(updatedAt)))
  ) {
    throw new Error('CONTACT_INPUT_INVALID');
  }
}

function assertNormalized(type: ContactType, value: string): void {
  if (
    typeof value !== 'string' ||
    !(
      (type === 'PHONE' && /^\+[1-9][0-9]{7,14}$/.test(value)) ||
      (type === 'EMAIL' &&
        value.length >= 3 &&
        value.length <= 254 &&
        value === value.toLowerCase() &&
        /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))
    )
  ) {
    throw new Error('CONTACT_VALUE_NOT_NORMALIZED');
  }
}

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    normalizedValue: row.normalized_value,
    sourceKind: row.source_kind,
    sourceUpdatedAt: row.source_updated_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function lockCommand(client: PoolClient, input: ContactCommandContext): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `contact-command:${input.tenantId}:${input.actorId}:${input.idempotencyKey}`,
  ]);
}

async function readCommand(
  client: PoolClient,
  input: ContactCommandContext,
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select request_hash, operation, contact_id, outcome, result_version
       from profile.contact_commands
      where tenant_id = $1 and actor_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.actorId, input.idempotencyKey],
  );
}

async function recordCommand(
  client: PoolClient,
  input: ContactCommandContext,
  hash: string,
  operation: CommandRow['operation'],
  contactId: string,
  outcome: CommandRow['outcome'],
  version: number,
): Promise<void> {
  await client.query(
    `insert into profile.contact_commands
       (tenant_id, actor_id, idempotency_key, request_hash, operation, contact_id, outcome, result_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.actorId,
      input.idempotencyKey,
      hash,
      operation,
      contactId,
      outcome,
      version,
    ],
  );
}

async function recordChange(
  client: PoolClient,
  input: ContactCommandContext,
  contactId: string,
  userId: string,
  type: ContactType,
  action: 'CREATED' | 'PROVENANCE_UPDATED',
  oldVersion: number | null,
  version: number,
): Promise<void> {
  // No address, source payload, or proof is copied into audit or the outbox.
  const payload = { contactId, userId, type, actorId: input.actorId, oldVersion, version };
  await client.query(
    `insert into audit.audit_log
       (tenant_id, actor_id, action, resource_type, resource_id, result,
        correlation_id, old_value, new_value)
     values ($1, $2, $3, 'PROFILE_CONTACT', $4, 'SUCCESS', $5, $6::jsonb, $7::jsonb)`,
    [
      input.tenantId,
      input.actorId,
      `PROFILE_CONTACT_${action}`,
      contactId,
      input.correlationId,
      JSON.stringify(oldVersion === null ? null : { version: oldVersion }),
      JSON.stringify(payload),
    ],
  );
  await client.query(
    `insert into audit.outbox_events
       (tenant_id, event_type, aggregate_id, correlation_id, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      action === 'CREATED' ? 'profile.contact.created.v1' : 'profile.contact.provenance_updated.v1',
      contactId,
      input.correlationId,
      JSON.stringify(payload),
    ],
  );
}

export function createContactRepository(pool: Pool) {
  return {
    /** Callers must authorize the requested user before using this internal, tenant-scoped read. */
    listForUser(tenantId: string, userId: string): Promise<readonly Contact[]> {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query<ContactRow>(
          `select ${CONTACT_COLUMNS} from profile.contacts
            where tenant_id = $1 and user_id = $2 order by created_at, id`,
          [tenantId, userId],
        );
        return rows.rows.map(toContact);
      });
    },

    async create(input: CreateContactInput): Promise<CreateContactResult> {
      assertKeys(input, [
        'tenantId',
        'actorId',
        'correlationId',
        'idempotencyKey',
        'userId',
        'type',
        'normalizedValue',
        'sourceKind',
        'sourceUpdatedAt',
      ]);
      assertContext(input);
      assertSource(input.sourceKind, input.sourceUpdatedAt);
      assertNormalized(input.type, input.normalizedValue);
      const hash = digest([
        'CREATE',
        input.tenantId,
        input.actorId,
        input.userId,
        input.type,
        input.normalizedValue,
        input.sourceKind,
        input.sourceUpdatedAt ?? null,
      ]);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, input);
        const prior = await readCommand(client, input);
        if (prior) {
          if (prior.request_hash !== hash || prior.operation !== 'CREATE')
            return { outcome: 'idempotency_conflict' };
          return {
            outcome: prior.outcome as 'created' | 'existing',
            contactId: prior.contact_id,
            version: prior.result_version,
            replayed: true,
          };
        }
        const inserted = await queryOne<ContactRow>(
          client,
          `insert into profile.contacts
             (tenant_id, user_id, type, normalized_value, source_kind, source_updated_at,
              created_by_actor_id, updated_by_actor_id)
           values ($1, $2, $3, $4, $5, $6, $7, $7)
           on conflict (tenant_id, user_id, type, normalized_value) do nothing
           returning ${CONTACT_COLUMNS}`,
          [
            input.tenantId,
            input.userId,
            input.type,
            input.normalizedValue,
            input.sourceKind,
            input.sourceUpdatedAt ?? null,
            input.actorId,
          ],
        );
        const contact =
          inserted ??
          (await queryOne<ContactRow>(
            client,
            `select ${CONTACT_COLUMNS} from profile.contacts
            where tenant_id = $1 and user_id = $2 and type = $3 and normalized_value = $4`,
            [input.tenantId, input.userId, input.type, input.normalizedValue],
          ));
        if (!contact) throw new Error('CONTACT_CREATE_CONFLICT_UNRESOLVED');
        const outcome = inserted ? 'created' : 'existing';
        await recordCommand(client, input, hash, 'CREATE', contact.id, outcome, contact.version);
        if (inserted)
          await recordChange(
            client,
            input,
            contact.id,
            input.userId,
            input.type,
            'CREATED',
            null,
            contact.version,
          );
        return { outcome, contactId: contact.id, version: contact.version, replayed: false };
      });
    },

    async updateProvenance(
      input: UpdateContactProvenanceInput,
    ): Promise<UpdateContactProvenanceResult> {
      assertKeys(input, [
        'tenantId',
        'actorId',
        'correlationId',
        'idempotencyKey',
        'contactId',
        'expectedVersion',
        'sourceKind',
        'sourceUpdatedAt',
      ]);
      assertContext(input);
      assertSource(input.sourceKind, input.sourceUpdatedAt);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error('CONTACT_INPUT_INVALID');
      }
      const hash = digest([
        'UPDATE_PROVENANCE',
        input.tenantId,
        input.actorId,
        input.contactId,
        input.expectedVersion,
        input.sourceKind,
        input.sourceUpdatedAt ?? null,
      ]);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await lockCommand(client, input);
        const prior = await readCommand(client, input);
        if (prior) {
          if (prior.request_hash !== hash || prior.operation !== 'UPDATE_PROVENANCE') {
            return { outcome: 'idempotency_conflict' };
          }
          return {
            outcome: 'updated',
            contactId: prior.contact_id,
            version: prior.result_version,
            replayed: true,
          };
        }
        const current = await queryOne<ContactRow>(
          client,
          `select ${CONTACT_COLUMNS} from profile.contacts
            where tenant_id = $1 and id = $2 for update`,
          [input.tenantId, input.contactId],
        );
        if (!current || current.version !== input.expectedVersion) return { outcome: 'conflict' };
        if (
          current.source_kind === input.sourceKind &&
          current.source_updated_at &&
          input.sourceUpdatedAt &&
          Date.parse(input.sourceUpdatedAt) < current.source_updated_at.getTime()
        ) {
          return { outcome: 'source_stale' };
        }
        const sourceUpdatedAt =
          input.sourceUpdatedAt ??
          (current.source_kind === input.sourceKind ? current.source_updated_at : null);
        const updated = await queryOne<ContactRow>(
          client,
          `update profile.contacts
              set source_kind = $3, source_updated_at = $4, updated_by_actor_id = $5,
                  version = version + 1, updated_at = now()
            where tenant_id = $1 and id = $2 and version = $6
            returning ${CONTACT_COLUMNS}`,
          [
            input.tenantId,
            input.contactId,
            input.sourceKind,
            sourceUpdatedAt,
            input.actorId,
            input.expectedVersion,
          ],
        );
        if (!updated) return { outcome: 'conflict' };
        await recordCommand(
          client,
          input,
          hash,
          'UPDATE_PROVENANCE',
          updated.id,
          'updated',
          updated.version,
        );
        await recordChange(
          client,
          input,
          updated.id,
          updated.user_id,
          updated.type,
          'PROVENANCE_UPDATED',
          current.version,
          updated.version,
        );
        return {
          outcome: 'updated',
          contactId: updated.id,
          version: updated.version,
          replayed: false,
        };
      });
    },
  };
}
