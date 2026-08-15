import { createHash } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import {
  assertMigrationLedgerCompatible,
  CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
  type MigrationLedgerEntry,
} from '@phub/database';

export type ChatPushFoundationPhase = 'pre' | 'drained' | 'post' | 'live';

type QueryClient = Pick<PoolClient, 'query'>;

interface TenantRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly tenant_key: string;
}

interface RuntimeIdentityRow extends QueryResultRow {
  readonly runtime_role: string;
  readonly runtime_pid: number;
}

export interface RuntimeGateSnapshot extends QueryResultRow {
  readonly web_push_enabled: boolean;
  readonly booking_reminders_enabled: boolean;
  readonly booking_binding_present: boolean;
  readonly messaging_http_enabled: boolean;
  readonly messaging_direct_enabled: boolean;
  readonly messaging_realtime_enabled: boolean;
  readonly messaging_contextual_enabled: boolean;
}

export interface EndpointInventorySnapshot extends QueryResultRow {
  readonly endpoint_rows: number;
  readonly suspended_rows: number;
  readonly duplicate_live_owners: number;
  readonly pending_booking_lifecycle_events: number;
}

interface RelationInventoryRow extends QueryResultRow {
  readonly relation_name: string;
  readonly exists: boolean;
}

interface CountRow extends QueryResultRow {
  readonly row_count: number;
}

interface SessionCountRow extends QueryResultRow {
  readonly session_count: number;
}

interface ExistingIsolationRow extends QueryResultRow {
  readonly relation_name: string;
  readonly row_security: boolean;
  readonly force_rls: boolean;
  readonly policy_count: number;
  readonly exact_policy_count: number;
}

interface CatalogPostcheckRow extends QueryResultRow {
  readonly matched_indexes: number;
  readonly ready_indexes: number;
  readonly exact_index_shapes: number;
  readonly matched_constraints: number;
  readonly validated_constraints: number;
  readonly exact_booking_columns: number;
}

export interface ChatPushFoundationVerificationResult {
  readonly tenantCount: number;
  readonly pendingFoundationCount: number;
  readonly appliedFoundationCount: number;
  readonly runtimeSessionCount: number;
  readonly catalogDigest?: string;
}

const foundationRelations = [
  'notifications.booking_notification_projection_fences',
  'notifications.booking_reminder_schedules',
  'notifications.booking_reminder_recipients',
  'messaging.user_blocks',
  'messaging.user_block_commands',
] as const;

const catalogDigestRelations = [
  'integration.notification_endpoints',
  'notifications.tenant_runtime_settings',
  ...foundationRelations,
] as const;

export class ChatPushFoundationVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChatPushFoundationVerificationError';
  }
}

function fail(code: string): never {
  throw new ChatPushFoundationVerificationError(code);
}

function normalizedTenantKeys(value: string): readonly string[] {
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    keys.length === 0 ||
    keys.some((key) => !/^[a-z0-9][a-z0-9-]{1,62}$/.test(key)) ||
    new Set(keys).size !== keys.length
  ) {
    fail('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_INVALID');
  }
  return [...keys].sort();
}

async function foundationCatalogDigest(client: QueryClient): Promise<string> {
  const rows = (
    await client.query<{ snapshot_key: string; snapshot_value: string }>(
      `with target_relation as (
         select relation_name,
                pg_catalog.to_regclass(relation_name) as relation_oid
           from unnest($1::text[]) as target(relation_name)
       ), snapshot as (
         select 'relation:' || target_relation.relation_name as snapshot_key,
                pg_catalog.jsonb_build_object(
                  'kind', relation.relkind,
                  'persistence', relation.relpersistence,
                  'replicaIdentity', relation.relreplident,
                  'partition', relation.relispartition,
                  'partitionBound', coalesce(pg_catalog.pg_get_expr(relation.relpartbound, relation.oid), ''),
                  'owner', pg_catalog.pg_get_userbyid(relation.relowner),
                  'rowSecurity', relation.relrowsecurity,
                  'forceRls', relation.relforcerowsecurity,
                  'acl', coalesce(relation.relacl::text, '')
                ) as snapshot_value
           from target_relation
           join pg_catalog.pg_class relation on relation.oid = target_relation.relation_oid
         union all
         select 'column:' || target_relation.relation_name || ':' || attribute.attnum::text,
                pg_catalog.jsonb_build_object(
                  'name', attribute.attname,
                  'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                  'notNull', attribute.attnotnull,
                  'identity', attribute.attidentity,
                  'generated', attribute.attgenerated,
                  'collation', attribute.attcollation::regcollation::text,
                  'storage', attribute.attstorage,
                  'compression', attribute.attcompression,
                  'default', coalesce(
                    pg_catalog.pg_get_expr(default_catalog.adbin, default_catalog.adrelid),
                    ''
                  ),
                  'acl', coalesce(attribute.attacl::text, '')
                )
           from target_relation
           join pg_catalog.pg_attribute attribute
             on attribute.attrelid = target_relation.relation_oid
            and attribute.attnum > 0
            and not attribute.attisdropped
           left join pg_catalog.pg_attrdef default_catalog
             on default_catalog.adrelid = attribute.attrelid
            and default_catalog.adnum = attribute.attnum
         union all
         select 'constraint:' || target_relation.relation_name || ':' || constraint_catalog.conname,
                pg_catalog.jsonb_build_object(
                  'type', constraint_catalog.contype,
                  'validated', constraint_catalog.convalidated,
                  'deferrable', constraint_catalog.condeferrable,
                  'deferred', constraint_catalog.condeferred,
                  'noInherit', constraint_catalog.connoinherit,
                  'definition', pg_catalog.pg_get_constraintdef(constraint_catalog.oid, false),
                  'index', coalesce(constraint_catalog.conindid::regclass::text, ''),
                  'referencedRelation', coalesce(constraint_catalog.confrelid::regclass::text, ''),
                  'matchType', constraint_catalog.confmatchtype,
                  'updateAction', constraint_catalog.confupdtype,
                  'deleteAction', constraint_catalog.confdeltype,
                  'key', constraint_catalog.conkey::text,
                  'referencedKey', constraint_catalog.confkey::text
                )
           from target_relation
           join pg_catalog.pg_constraint constraint_catalog
             on constraint_catalog.conrelid = target_relation.relation_oid
         union all
         select 'index:' || target_relation.relation_name || ':' || index_relation.relname,
                pg_catalog.jsonb_build_object(
                  'definition', pg_catalog.pg_get_indexdef(index_catalog.indexrelid),
                  'accessMethod', access_method.amname,
                  'valid', index_catalog.indisvalid,
                  'ready', index_catalog.indisready,
                  'unique', index_catalog.indisunique,
                  'primary', index_catalog.indisprimary,
                  'exclusion', index_catalog.indisexclusion,
                  'nullsNotDistinct', index_catalog.indnullsnotdistinct,
                  'keyAttributes', index_catalog.indnkeyatts,
                  'attributes', index_catalog.indnatts,
                  'key', index_catalog.indkey::text,
                  'collation', index_catalog.indcollation::text,
                  'class', index_catalog.indclass::text,
                  'options', index_catalog.indoption::text,
                  'predicate', coalesce(
                    pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid),
                    ''
                  )
                )
           from target_relation
           join pg_catalog.pg_index index_catalog
             on index_catalog.indrelid = target_relation.relation_oid
           join pg_catalog.pg_class index_relation
             on index_relation.oid = index_catalog.indexrelid
           join pg_catalog.pg_am access_method on access_method.oid = index_relation.relam
         union all
         select 'trigger:' || target_relation.relation_name || ':' || trigger_catalog.tgname,
                pg_catalog.jsonb_build_object(
                  'enabled', trigger_catalog.tgenabled,
                  'definition', pg_catalog.pg_get_triggerdef(trigger_catalog.oid, false)
                )
           from target_relation
           join pg_catalog.pg_trigger trigger_catalog
             on trigger_catalog.tgrelid = target_relation.relation_oid
            and not trigger_catalog.tgisinternal
         union all
         select 'policy:' || target_relation.relation_name || ':' || policy.polname,
                pg_catalog.jsonb_build_object(
                  'command', policy.polcmd,
                  'permissive', policy.polpermissive,
                  'roles', policy.polroles::text,
                  'qual', coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
                  'withCheck', coalesce(
                    pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
                    ''
                  )
                )
           from target_relation
           join pg_catalog.pg_policy policy on policy.polrelid = target_relation.relation_oid
       )
       select snapshot_key, snapshot_value::text as snapshot_value
         from snapshot
        order by snapshot_key`,
      [catalogDigestRelations],
    )
  ).rows;
  if (rows.length === 0) fail('CHAT_PUSH_FOUNDATION_CATALOG_SNAPSHOT_EMPTY');
  const hash = createHash('sha256');
  for (const row of rows) hash.update(`${row.snapshot_key}\0${row.snapshot_value}\n`);
  return hash.digest('hex');
}

export function assertFoundationLedger(input: {
  readonly applied: readonly MigrationLedgerEntry[];
  readonly packaged: readonly MigrationLedgerEntry[];
  readonly phase: ChatPushFoundationPhase;
}): { readonly pendingFoundation: readonly string[]; readonly appliedFoundationCount: number } {
  assertMigrationLedgerCompatible({ applied: input.applied, packaged: input.packaged });

  const packagedNames = input.packaged.map((entry) => entry.filename);
  if (new Set(packagedNames).size !== packagedNames.length) {
    fail('CHAT_PUSH_FOUNDATION_PACKAGED_MIGRATION_DUPLICATE');
  }
  const packagedSet = new Set(packagedNames);
  if (CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.some((filename) => !packagedSet.has(filename))) {
    fail('CHAT_PUSH_FOUNDATION_PACKAGED_MIGRATION_MISSING');
  }

  const appliedSet = new Set(input.applied.map((entry) => entry.filename));
  const pending = packagedNames.filter((filename) => !appliedSet.has(filename));
  const foundationSet = new Set<string>(CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES);
  if (pending.some((filename) => !foundationSet.has(filename))) {
    fail('CHAT_PUSH_FOUNDATION_UNEXPECTED_PENDING');
  }

  const appliedFoundation = CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.filter((filename) =>
    appliedSet.has(filename),
  );
  const expectedPrefix = CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.slice(
    0,
    appliedFoundation.length,
  );
  if (appliedFoundation.some((filename, index) => filename !== expectedPrefix[index])) {
    fail('CHAT_PUSH_FOUNDATION_NON_PREFIX_LEDGER');
  }

  const pendingFoundation = CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.filter(
    (filename) => !appliedSet.has(filename),
  );
  if ((input.phase === 'post' || input.phase === 'live') && pendingFoundation.length > 0) {
    fail('CHAT_PUSH_FOUNDATION_POST_MIGRATION_PENDING');
  }
  return { pendingFoundation, appliedFoundationCount: appliedFoundation.length };
}

export function assertTenantInventory(input: {
  readonly approvedTenantKeys: string;
  readonly tenants: readonly TenantRow[];
}): readonly TenantRow[] {
  const approved = normalizedTenantKeys(input.approvedTenantKeys);
  const actual = input.tenants.map((tenant) => tenant.tenant_key).sort();
  if (actual.length === 0) fail('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_EMPTY');
  if (actual.length !== approved.length || actual.some((key, index) => key !== approved[index])) {
    fail('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_MISMATCH');
  }
  if (
    new Set(input.tenants.map((tenant) => tenant.tenant_id)).size !== input.tenants.length ||
    new Set(input.tenants.map((tenant) => tenant.tenant_key)).size !== input.tenants.length
  ) {
    fail('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_DUPLICATE');
  }
  return [...input.tenants].sort((left, right) => left.tenant_key.localeCompare(right.tenant_key));
}

export function assertTenantFoundationState(input: {
  readonly gates: RuntimeGateSnapshot | undefined;
  readonly endpoints: EndpointInventorySnapshot | undefined;
  readonly semanticRowCounts?: readonly number[];
}): void {
  const row = input.gates;
  if (!row) fail('CHAT_PUSH_FOUNDATION_TENANT_GATE_INVENTORY_MISSING');
  if (
    row?.web_push_enabled === true ||
    row?.booking_reminders_enabled === true ||
    row?.booking_binding_present === true ||
    row?.messaging_http_enabled === true ||
    row?.messaging_direct_enabled === true ||
    row?.messaging_realtime_enabled === true ||
    row?.messaging_contextual_enabled === true
  ) {
    fail('CHAT_PUSH_FOUNDATION_TENANT_GATE_ENABLED');
  }
  const endpoints = input.endpoints;
  if (!endpoints) fail('CHAT_PUSH_FOUNDATION_ENDPOINT_INVENTORY_MISSING');
  if (Number(endpoints.duplicate_live_owners) !== 0) {
    fail('CHAT_PUSH_FOUNDATION_DUPLICATE_LIVE_OWNER');
  }
  if (Number(endpoints.suspended_rows) !== 0) {
    fail('CHAT_PUSH_FOUNDATION_SUSPENDED_ENDPOINT_PRESENT');
  }
  if (Number(endpoints.endpoint_rows) !== 0) {
    fail('CHAT_PUSH_FOUNDATION_ENDPOINT_PRESENT');
  }
  if (Number(endpoints.pending_booking_lifecycle_events) !== 0) {
    fail('CHAT_PUSH_FOUNDATION_PENDING_BOOKING_EVENT_PRESENT');
  }
  if (input.semanticRowCounts?.some((count) => Number(count) !== 0)) {
    fail('CHAT_PUSH_FOUNDATION_SEMANTIC_ROW_PRESENT');
  }
}

async function inspectTenant(options: {
  readonly client: QueryClient;
  readonly tenant: TenantRow;
  readonly bookingColumnsExist: boolean;
  readonly existingRelations: readonly string[];
}): Promise<void> {
  await options.client.query('begin transaction read only');
  try {
    const context = await options.client.query<{ tenant_id: string }>(
      `select pg_catalog.set_config('app.tenant_id', $1, true) as tenant_id`,
      [options.tenant.tenant_id],
    );
    if (context.rows[0]?.tenant_id !== options.tenant.tenant_id) {
      fail('CHAT_PUSH_FOUNDATION_RUNTIME_CONTEXT_MISMATCH');
    }

    const bookingFields = options.bookingColumnsExist
      ? `coalesce(notification_runtime.booking_reminders_enabled, false) as booking_reminders_enabled,
         notification_runtime.booking_reminder_ruleset_version is not null
           or notification_runtime.booking_reminder_contract_hash is not null
           as booking_binding_present,`
      : `false as booking_reminders_enabled,
         false as booking_binding_present,`;
    const gates = await options.client.query<RuntimeGateSnapshot>(
      `select coalesce(notification_runtime.web_push_enabled, false) as web_push_enabled,
              ${bookingFields}
              coalesce(messaging_runtime.http_enabled, false) as messaging_http_enabled,
              coalesce(messaging_runtime.direct_enabled, false) as messaging_direct_enabled,
              coalesce(messaging_runtime.realtime_enabled, false) as messaging_realtime_enabled,
              coalesce(messaging_runtime.contextual_enabled, false) as messaging_contextual_enabled
         from (select $1::uuid as tenant_id) tenant
         left join notifications.tenant_runtime_settings notification_runtime
           on notification_runtime.tenant_id = tenant.tenant_id
         left join messaging.tenant_runtime_settings messaging_runtime
           on messaging_runtime.tenant_id = tenant.tenant_id`,
      [options.tenant.tenant_id],
    );
    const endpoints = await options.client.query<EndpointInventorySnapshot>(
      `select count(*)::integer as endpoint_rows,
              count(*) filter (where status = 'SUSPENDED_POLICY')::integer as suspended_rows,
              (
                select count(*)::integer
                  from (
                    select provider_account_id, address_hash
                      from integration.notification_endpoints
                     where tenant_id = $1::uuid
                       and channel = 'PUSH'
                       and status in ('ACTIVE', 'SUSPENDED_POLICY')
                     group by provider_account_id, address_hash
                    having count(distinct user_id) > 1
                  ) duplicate_owner
              ) as duplicate_live_owners,
              (
                select count(*)::integer
                  from audit.outbox_events booking_outbox
                 where booking_outbox.tenant_id = $1::uuid
                   and booking_outbox.published_at is null
                   and booking_outbox.event_type = any($2::text[])
              ) as pending_booking_lifecycle_events
         from integration.notification_endpoints
        where tenant_id = $1::uuid`,
      [
        options.tenant.tenant_id,
        ['booking.confirmed.v1', 'booking.changed.v1', 'booking.cancelled.v1'],
      ],
    );
    assertTenantFoundationState({ gates: gates.rows[0], endpoints: endpoints.rows[0] });

    for (const relation of options.existingRelations) {
      const [schemaName, relationName] = relation.split('.');
      if (!schemaName || !relationName) fail('CHAT_PUSH_FOUNDATION_RELATION_NAME_INVALID');
      const result = await options.client.query<CountRow>(
        `select count(*)::integer as row_count
           from ${schemaName}.${relationName}
          where tenant_id = $1::uuid`,
        [options.tenant.tenant_id],
      );
      if (Number(result.rows[0]?.row_count ?? -1) !== 0) {
        fail('CHAT_PUSH_FOUNDATION_SEMANTIC_ROW_PRESENT');
      }
    }
    await options.client.query('commit');
  } catch (error) {
    await options.client.query('rollback').catch(() => undefined);
    throw error;
  }
}

export async function verifyChatPushFoundation(options: {
  readonly runtimeClient: QueryClient;
  readonly migratorClient: QueryClient;
  readonly packaged: readonly MigrationLedgerEntry[];
  readonly phase: ChatPushFoundationPhase;
  readonly approvedTenantKeys: string;
  readonly expectedCatalogDigest?: string;
  readonly captureCatalogBaseline?: boolean;
}): Promise<ChatPushFoundationVerificationResult> {
  await options.migratorClient.query(
    `select pg_catalog.set_config('search_path', 'pg_catalog', false)`,
  );
  await options.runtimeClient.query(
    `select pg_catalog.set_config('search_path', 'pg_catalog', false)`,
  );

  const applied = (
    await options.migratorClient.query<MigrationLedgerEntry>(
      `select filename, checksum from public.schema_migrations order by filename`,
    )
  ).rows;
  const ledger = assertFoundationLedger({
    applied,
    packaged: options.packaged,
    phase: options.phase,
  });

  const tenants = assertTenantInventory({
    approvedTenantKeys: options.approvedTenantKeys,
    tenants: (
      await options.migratorClient.query<TenantRow>(
        `select id::text as tenant_id, tenant_key
           from identity.tenants
          order by tenant_key, id`,
      )
    ).rows,
  });
  const runtimeIdentity = (
    await options.runtimeClient.query<RuntimeIdentityRow>(
      `select current_user as runtime_role, pg_catalog.pg_backend_pid() as runtime_pid`,
    )
  ).rows[0];
  if (!runtimeIdentity?.runtime_role || !Number.isInteger(runtimeIdentity.runtime_pid)) {
    fail('CHAT_PUSH_FOUNDATION_RUNTIME_IDENTITY_MISSING');
  }

  const relationInventory = (
    await options.migratorClient.query<RelationInventoryRow>(
      `select relation_name,
              pg_catalog.to_regclass(relation_name) is not null as exists
         from unnest($1::text[]) as relation_inventory(relation_name)
        order by relation_name`,
      [foundationRelations],
    )
  ).rows;
  const existingRelations = relationInventory
    .filter((entry) => entry.exists)
    .map((entry) => entry.relation_name);
  const expectedRelations = [
    ...(ledger.appliedFoundationCount >= 1
      ? ['notifications.booking_notification_projection_fences']
      : []),
    ...(ledger.appliedFoundationCount >= 3
      ? ['messaging.user_blocks', 'messaging.user_block_commands']
      : []),
    ...(ledger.appliedFoundationCount >= 5
      ? ['notifications.booking_reminder_schedules', 'notifications.booking_reminder_recipients']
      : []),
  ].sort();
  const actualRelations = [...existingRelations].sort();
  if (
    actualRelations.length !== expectedRelations.length ||
    actualRelations.some((relation, index) => relation !== expectedRelations[index])
  ) {
    fail('CHAT_PUSH_FOUNDATION_PREFIX_RELATION_MISMATCH');
  }
  if (
    (options.phase === 'post' || options.phase === 'live') &&
    existingRelations.length !== foundationRelations.length
  ) {
    fail('CHAT_PUSH_FOUNDATION_POST_RELATION_MISSING');
  }

  const bookingColumnCount = Number(
    (
      await options.migratorClient.query<{ column_count: number }>(
        `select count(*)::integer as column_count
           from pg_catalog.pg_attribute attribute
          where attribute.attrelid = pg_catalog.to_regclass('notifications.tenant_runtime_settings')
            and attribute.attname = any($1::text[])
            and attribute.attnum > 0
            and not attribute.attisdropped`,
        [
          [
            'booking_reminders_enabled',
            'booking_reminder_ruleset_version',
            'booking_reminder_contract_hash',
          ],
        ],
      )
    ).rows[0]?.column_count ?? -1,
  );
  if (bookingColumnCount !== 0 && bookingColumnCount !== 3) {
    fail('CHAT_PUSH_FOUNDATION_BOOKING_COLUMN_PARTIAL');
  }
  const bookingColumnsExist = bookingColumnCount === 3;
  if (bookingColumnsExist !== ledger.appliedFoundationCount >= 5) {
    fail('CHAT_PUSH_FOUNDATION_PREFIX_BOOKING_COLUMN_MISMATCH');
  }
  if ((options.phase === 'post' || options.phase === 'live') && !bookingColumnsExist) {
    fail('CHAT_PUSH_FOUNDATION_POST_BOOKING_COLUMNS_MISSING');
  }

  let catalogDigest: string | undefined;
  if (options.phase === 'post' || options.phase === 'live') {
    const catalog = (
      await options.migratorClient.query<CatalogPostcheckRow>(
        `with expected_index(name, relation_name, columns, options, predicate, is_unique) as (
           values
             ('notification_endpoints_live_address_owner_unique_idx', 'integration.notification_endpoints', array['tenant_id', 'provider_account_id', 'address_hash']::text[], array[0, 0, 0]::smallint[], 'channel=''push''::textandstatus=anyarray[''active''::text,''suspended_policy''::text]', true),
             ('notification_endpoints_live_user_quota_idx', 'integration.notification_endpoints', array['tenant_id', 'user_id', 'provider_account_id']::text[], array[0, 0, 0]::smallint[], 'channel=''push''::textandstatus=anyarray[''active''::text,''suspended_policy''::text]', false),
             ('user_blocks_reverse_pair_idx', 'messaging.user_blocks', array['tenant_id', 'blocked_user_id', 'blocker_user_id']::text[], array[0, 0, 0]::smallint[], '', false),
             ('booking_reminder_schedules_due_idx', 'notifications.booking_reminder_schedules', array['tenant_id', 'due_at', 'booking_id', 'reminder_kind']::text[], array[0, 0, 0, 0]::smallint[], 'state=''pending''::text', false),
             ('booking_reminder_schedules_claim_idx', 'notifications.booking_reminder_schedules', array['tenant_id', 'claim_token', 'booking_id', 'reminder_kind']::text[], array[0, 0, 0, 0]::smallint[], 'state=''pending''::textandclaim_tokenisnotnull', false),
             ('booking_reminder_schedules_missed_idx', 'notifications.booking_reminder_schedules', array['tenant_id', 'completed_at']::text[], array[0, 3]::smallint[], 'state=''missed''::text', false)
         ), expected_constraint(name, relation_name) as (
           values
             ('notification_endpoints_status_check', 'integration.notification_endpoints'),
             ('tenant_runtime_booking_reminder_binding_check', 'notifications.tenant_runtime_settings')
         ), expected_column(name, type_name, not_null, default_expression) as (
           values
             ('booking_reminders_enabled', 'boolean', true, 'false'),
             ('booking_reminder_ruleset_version', 'text', false, ''),
             ('booking_reminder_contract_hash', 'text', false, '')
         ), index_state as (
           select expected_index.name,
                  expected_index.columns as expected_columns,
                  expected_index.options as expected_options,
                  expected_index.predicate as expected_predicate,
                  expected_index.is_unique as expected_unique,
                  index_catalog.indexrelid,
                  index_catalog.indisvalid,
                  index_catalog.indisready,
                  index_catalog.indisunique,
                  index_catalog.indnatts = index_catalog.indnkeyatts as keys_only,
                  access_method.amname as access_method,
                  array(
                    select attribute.attname
                      from unnest(index_catalog.indkey) with ordinality as index_key(attnum, position)
                      join pg_catalog.pg_attribute attribute
                        on attribute.attrelid = index_catalog.indrelid
                       and attribute.attnum = index_key.attnum
                     where index_key.position <= index_catalog.indnkeyatts
                     order by index_key.position
                  ) as actual_columns,
                  array(
                    select index_option.option
                      from unnest(index_catalog.indoption) with ordinality as index_option(option, position)
                     order by index_option.position
                  ) as actual_options,
                  pg_catalog.regexp_replace(
                    pg_catalog.lower(coalesce(
                      pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid),
                      ''
                    )),
                    '[[:space:]()]',
                    '',
                    'g'
                  ) as actual_predicate
             from expected_index
             left join pg_catalog.pg_namespace namespace_catalog
               on namespace_catalog.nspname = pg_catalog.split_part(expected_index.relation_name, '.', 1)
             left join pg_catalog.pg_class index_class
               on index_class.relnamespace = namespace_catalog.oid
              and index_class.relname = expected_index.name
             left join pg_catalog.pg_index index_catalog
               on index_catalog.indexrelid = index_class.oid
              and index_catalog.indrelid = pg_catalog.to_regclass(expected_index.relation_name)
             left join pg_catalog.pg_am access_method
               on access_method.oid = index_class.relam
         ), constraint_state as (
           select expected_constraint.name,
                  constraint_catalog.oid,
                  constraint_catalog.convalidated
             from expected_constraint
             left join pg_catalog.pg_constraint constraint_catalog
               on constraint_catalog.conrelid = pg_catalog.to_regclass(
                    expected_constraint.relation_name
                  )
              and constraint_catalog.conname = expected_constraint.name
              and constraint_catalog.contype = 'c'
         ), column_state as (
           select expected_column.name,
                  attribute.attnum,
                  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type_name,
                  attribute.attnotnull as not_null,
                  pg_catalog.regexp_replace(
                    pg_catalog.lower(coalesce(
                      pg_catalog.pg_get_expr(default_catalog.adbin, default_catalog.adrelid),
                      ''
                    )),
                    '[[:space:]()]',
                    '',
                    'g'
                  ) as default_expression,
                  expected_column.type_name as expected_type_name,
                  expected_column.not_null as expected_not_null,
                  expected_column.default_expression as expected_default_expression
             from expected_column
             left join pg_catalog.pg_attribute attribute
               on attribute.attrelid = pg_catalog.to_regclass(
                    'notifications.tenant_runtime_settings'
                  )
              and attribute.attname = expected_column.name
              and attribute.attnum > 0
              and not attribute.attisdropped
             left join pg_catalog.pg_attrdef default_catalog
               on default_catalog.adrelid = attribute.attrelid
              and default_catalog.adnum = attribute.attnum
         )
         select count(indexrelid)::integer as matched_indexes,
                count(*) filter (where indisvalid and indisready)::integer as ready_indexes,
                count(*) filter (
                  where actual_columns = expected_columns
                    and actual_options = expected_options
                    and actual_predicate = expected_predicate
                    and indisunique = expected_unique
                    and keys_only
                    and access_method = 'btree'
                )::integer as exact_index_shapes,
                (select count(oid)::integer from constraint_state) as matched_constraints,
                (
                  select count(*) filter (where convalidated)::integer
                    from constraint_state
                ) as validated_constraints,
                (
                  select count(*) filter (
                    where attnum is not null
                      and type_name = expected_type_name
                      and not_null = expected_not_null
                      and default_expression = expected_default_expression
                  )::integer
                    from column_state
                ) as exact_booking_columns
           from index_state`,
      )
    ).rows[0];
    if (
      Number(catalog?.matched_indexes ?? -1) !== 6 ||
      Number(catalog?.ready_indexes ?? -1) !== 6 ||
      Number(catalog?.exact_index_shapes ?? -1) !== 6 ||
      Number(catalog?.matched_constraints ?? -1) !== 2 ||
      Number(catalog?.validated_constraints ?? -1) !== 2 ||
      Number(catalog?.exact_booking_columns ?? -1) !== 3
    ) {
      fail('CHAT_PUSH_FOUNDATION_POST_CATALOG_MISMATCH');
    }
    catalogDigest = await foundationCatalogDigest(options.migratorClient);
    if (
      options.expectedCatalogDigest !== undefined &&
      (!/^[0-9a-f]{64}$/.test(options.expectedCatalogDigest) ||
        catalogDigest !== options.expectedCatalogDigest)
    ) {
      fail('CHAT_PUSH_FOUNDATION_CATALOG_DIGEST_MISMATCH');
    }
    if (options.expectedCatalogDigest === undefined && options.captureCatalogBaseline !== true) {
      fail('CHAT_PUSH_FOUNDATION_CATALOG_BASELINE_REQUIRED');
    }
  }

  const canonicalTenantIsolation =
    "(tenant_id=(nullif(current_setting('app.tenant_id'::text,true),''::text))::uuid)";
  const existingIsolation = (
    await options.migratorClient.query<ExistingIsolationRow>(
      `with expected(schema_name, relation_name, policy_name) as (
         values
           ('integration'::text, 'notification_endpoints'::text, 'notification_endpoints_tenant_isolation'::text),
           ('notifications'::text, 'tenant_runtime_settings'::text, 'notification_runtime_settings_tenant_isolation'::text),
           ('messaging'::text, 'tenant_runtime_settings'::text, 'messaging_runtime_settings_tenant_isolation'::text),
           ('audit'::text, 'outbox_events'::text, 'outbox_events_tenant_isolation'::text)
       )
       select expected.schema_name || '.' || expected.relation_name as relation_name,
              coalesce(relation.relrowsecurity, false) as row_security,
              coalesce(relation.relforcerowsecurity, false) as force_rls,
              count(policy.oid)::integer as policy_count,
              count(policy.oid) filter (
                where policy.polname = expected.policy_name
                  and policy.polcmd = '*'
                  and policy.polpermissive
                  and policy.polroles = array[0]::oid[]
                  and pg_catalog.regexp_replace(
                    pg_catalog.lower(coalesce(
                      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                      ''
                    )),
                    '[[:space:]]',
                    '',
                    'g'
                  ) = $1
                  and pg_catalog.regexp_replace(
                    pg_catalog.lower(coalesce(
                      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
                      ''
                    )),
                    '[[:space:]]',
                    '',
                    'g'
                  ) = $1
              )::integer as exact_policy_count
         from expected
         left join pg_catalog.pg_namespace namespace_catalog
           on namespace_catalog.nspname = expected.schema_name
         left join pg_catalog.pg_class relation
           on relation.relnamespace = namespace_catalog.oid
          and relation.relname = expected.relation_name
          and relation.relkind in ('r', 'p')
         left join pg_catalog.pg_policy policy on policy.polrelid = relation.oid
        group by expected.schema_name, expected.relation_name,
                 relation.relrowsecurity, relation.relforcerowsecurity
        order by expected.schema_name, expected.relation_name`,
      [canonicalTenantIsolation],
    )
  ).rows;
  if (
    existingIsolation.length !== 4 ||
    existingIsolation.some(
      (entry) =>
        entry.row_security !== true ||
        entry.force_rls !== true ||
        Number(entry.policy_count) !== 1 ||
        Number(entry.exact_policy_count) !== 1,
    )
  ) {
    fail('CHAT_PUSH_FOUNDATION_EXISTING_RLS_POLICY_MISMATCH');
  }

  for (const tenant of tenants) {
    await inspectTenant({
      client: options.runtimeClient,
      tenant,
      bookingColumnsExist,
      existingRelations,
    });
  }

  const sessionCount = Number(
    (
      await options.migratorClient.query<SessionCountRow>(
        `select count(*)::integer as session_count
           from pg_catalog.pg_stat_activity activity
          where activity.datname = current_database()
            and activity.usename = $1
            and activity.pid <> $2`,
        [runtimeIdentity.runtime_role, runtimeIdentity.runtime_pid],
      )
    ).rows[0]?.session_count ?? -1,
  );
  if (sessionCount < 0) fail('CHAT_PUSH_FOUNDATION_RUNTIME_SESSION_INVENTORY_MISSING');
  if ((options.phase === 'drained' || options.phase === 'post') && sessionCount !== 0) {
    fail('CHAT_PUSH_FOUNDATION_RUNTIME_SESSION_PRESENT');
  }

  return {
    tenantCount: tenants.length,
    pendingFoundationCount: ledger.pendingFoundation.length,
    appliedFoundationCount: ledger.appliedFoundationCount,
    runtimeSessionCount: sessionCount,
    ...(catalogDigest ? { catalogDigest } : {}),
  };
}
