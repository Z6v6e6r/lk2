import type { PoolClient } from 'pg';
import { SUPPORT_TICKET_RUNTIME_PRIVILEGES } from './support-ticket-acl.js';
export const SUPPORT_DATABASE_OWNER_ROLE = 'phub_support_owner';
/** Column UPDATE(updated_at) permits FOR SHARE without granting identity/permission mutation. */
export const SUPPORT_RUNTIME_PREREQUISITES = {
  'identity.tenants': { SELECT: ['id', 'active'] },
  'identity.users': { SELECT: ['tenant_id', 'id', 'status'], UPDATE: ['updated_at'] },
  'identity.user_access_profiles': {
    SELECT: ['tenant_id', 'user_id', 'roles', 'permissions'],
    UPDATE: ['updated_at'],
  },
  'audit.audit_log': {
    INSERT: [
      'tenant_id',
      'actor_id',
      'action',
      'resource_type',
      'resource_id',
      'result',
      'correlation_id',
      'old_value',
      'new_value',
    ],
  },
  'audit.outbox_events': {
    INSERT: ['tenant_id', 'id', 'event_type', 'aggregate_id', 'correlation_id', 'payload'],
  },
  'notifications.templates': {
    SELECT: ['id', 'tenant_id', 'template_key', 'version', 'locale'],
    INSERT: [
      'tenant_id',
      'template_key',
      'version',
      'locale',
      'category',
      'channels',
      'title_template',
      'body_template',
      'deep_link_template',
      'active',
    ],
  },
  'notifications.intents': {
    SELECT: ['id'],
    INSERT: [
      'tenant_id',
      'recipient_user_id',
      'source_event_id',
      'template_id',
      'dedupe_key',
      'render_data',
      'rendered_title',
      'rendered_body',
      'rendered_deep_link',
      'state',
      'completed_at',
    ],
  },
  'notifications.deliveries': {
    INSERT: ['tenant_id', 'intent_id', 'channel', 'state', 'completed_at'],
  },
  'notifications.inbox_items': {
    INSERT: ['tenant_id', 'intent_id', 'user_id', 'category', 'title', 'body', 'deep_link'],
  },
} as const;
export interface SupportRuntimePrivilege {
  readonly relation: string;
  readonly privilege: string;
  readonly columnName: string | null;
}
export interface SupportRuntimePrerequisite extends SupportRuntimePrivilege {
  readonly allowed: boolean;
  readonly schemaUsage: boolean;
}
export function supportRuntimePrerequisiteDefinitions(): readonly SupportRuntimePrivilege[] {
  return Object.entries(
    SUPPORT_RUNTIME_PREREQUISITES as Readonly<
      Record<string, Readonly<Record<string, readonly string[]>>>
    >,
  ).flatMap(([relation, privileges]) =>
    Object.entries(privileges).flatMap(([privilege, columns]) =>
      columns.map((columnName) => ({ relation, privilege, columnName })),
    ),
  );
}
const key = (row: SupportRuntimePrivilege) =>
  `${row.relation}:${row.privilege}:${row.columnName ?? '*'}`;
export function assertSupportRuntimePrerequisites(
  rows: readonly SupportRuntimePrerequisite[],
): void {
  const expected = supportRuntimePrerequisiteDefinitions().map(key).sort().join(',');
  if (
    rows.some((row) => !row.allowed || !row.schemaUsage) ||
    rows.map(key).sort().join(',') !== expected
  )
    throw new Error('SUPPORT_RUNTIME_PREREQUISITES_MISSING');
}
export async function inspectSupportRuntimePrerequisites(
  client: Pick<PoolClient, 'query'>,
  runtimeRoleName: string,
): Promise<readonly SupportRuntimePrerequisite[]> {
  return (
    await client.query<SupportRuntimePrerequisite>(
      `select r.relation,r.privilege,r."columnName",
      case when r."columnName" is null then coalesce(has_table_privilege($1,to_regclass(r.relation),r.privilege),false)
      else coalesce(has_column_privilege($1,to_regclass(r.relation),r."columnName",r.privilege),false) end as allowed,
      has_schema_privilege($1,split_part(r.relation,'.',1),'USAGE') as "schemaUsage"
     from jsonb_to_recordset($2::jsonb) as r(relation text,privilege text,"columnName" text)`,
      [runtimeRoleName, JSON.stringify(supportRuntimePrerequisiteDefinitions())],
    )
  ).rows;
}
/** Exact effective business privileges, including inherited/PUBLIC access. Never silently repair extras. */
export async function inspectSupportRuntimePrivilegeInventory(
  client: Pick<PoolClient, 'query'>,
  runtimeRoleName: string,
) {
  const relations = (
    await client.query<SupportRuntimePrivilege>(
      `with relations as (select c.oid,n.nspname||'.'||c.relname as relation from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where c.relkind in ('r','p','v','m','f') and n.nspname<>'information_schema' and left(n.nspname,3)<>'pg_')
     select r.relation,p.privilege,null::text as "columnName" from relations r
       cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
       where has_table_privilege($1,r.oid,p.privilege)
     union all select r.relation,p.privilege,a.attname::text as "columnName" from relations r join pg_attribute a on a.attrelid=r.oid
       cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
       where a.attnum>0 and not a.attisdropped and not has_table_privilege($1,r.oid,p.privilege)
       and has_column_privilege($1,r.oid,a.attnum,p.privilege)`,
      [runtimeRoleName],
    )
  ).rows;
  const schemas = (
    await client.query<{ schemaName: string; privilege: string }>(
      `select n.nspname as "schemaName",p.privilege from pg_namespace n cross join unnest(array['USAGE','CREATE']) p(privilege)
     where n.nspname<>'information_schema' and left(n.nspname,3)<>'pg_' and has_schema_privilege($1,n.oid,p.privilege)`,
      [runtimeRoleName],
    )
  ).rows;
  const dangerous = (
    await client.query<{ unsafe: boolean }>(
      `select has_database_privilege($1,current_database(),'CREATE') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where p.prosecdef and n.nspname<>'information_schema' and left(n.nspname,3)<>'pg_'
     and has_schema_privilege($1,n.oid,'USAGE') and has_function_privilege($1,p.oid,'EXECUTE'))
     or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and left(n.nspname,3)<>'pg_' and exists(select 1 from unnest(array['USAGE','SELECT','UPDATE']) sp(privilege) where has_sequence_privilege($1,c.oid,sp.privilege)))
     or exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) g where g.grantee=$1::regrole and g.is_grantable)
     or exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) g where g.grantee=$1::regrole and g.is_grantable)
     or exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) g where g.grantee=$1::regrole and g.is_grantable) or exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) g where g.grantee=$1::regrole)
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='support' and has_function_privilege($1,p.oid,'EXECUTE'))
     or exists(select 1 from pg_database d cross join lateral aclexplode(d.datacl) g where g.grantee=$1::regrole and g.is_grantable)
     or exists(select 1 from pg_database d where d.datdba=$1::regrole)
     or exists(select 1 from pg_namespace n where n.nspowner=$1::regrole)
     or exists(select 1 from pg_proc p where p.proowner=$1::regrole)
     or exists(select 1 from pg_type t where t.typowner=$1::regrole) as unsafe`,
      [runtimeRoleName],
    )
  ).rows[0];
  return { relations, schemas, unsafe: dangerous?.unsafe ?? true };
}
export function assertSupportRuntimePrivilegeInventory(
  inventory: Awaited<ReturnType<typeof inspectSupportRuntimePrivilegeInventory>>,
  phase: 'pre' | 'post' = 'post',
): void {
  const expected = [
    ...supportRuntimePrerequisiteDefinitions(),
    ...Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES).flatMap(([name, privileges]) =>
      privileges.map((privilege) => ({ relation: `support.${name}`, privilege, columnName: null })),
    ),
  ]
    .map(key)
    .sort();
  const actual = inventory.relations.map(key).sort();
  const expectedSchemas = ['identity:USAGE', 'audit:USAGE', 'notifications:USAGE', 'support:USAGE'];
  const schemas = inventory.schemas
    .filter((row) => !(row.schemaName === 'public' && row.privilege === 'USAGE'))
    .map((row) => `${row.schemaName}:${row.privilege}`)
    .sort();
  if (
    inventory.unsafe ||
    new Set(actual).size !== actual.length ||
    actual.some((value) => !expected.includes(value)) ||
    schemas.some((value) => !expectedSchemas.includes(value)) ||
    (phase === 'post' &&
      (actual.join(',') !== expected.join(',') ||
        schemas.join(',') !== expectedSchemas.sort().join(',')))
  )
    throw new Error('SUPPORT_RUNTIME_PRIVILEGE_INVENTORY_INVALID');
}
export function supportRuntimePrerequisiteGrantStatements(
  runtimeRoleName: string,
): readonly string[] {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRoleName))
    throw new Error('SUPPORT_RUNTIME_ROLE_INVALID');
  return [
    ...['identity', 'audit', 'notifications'].map(
      (schema) => `grant usage on schema ${schema} to "${runtimeRoleName}"`,
    ),
    ...Object.entries(
      SUPPORT_RUNTIME_PREREQUISITES as Readonly<
        Record<string, Readonly<Record<string, readonly string[]>>>
      >,
    ).flatMap(([relation, privileges]) =>
      Object.entries(privileges).map(
        ([privilege, columns]) =>
          `grant ${privilege}${` (${columns.map((column) => `"${column}"`).join(', ')})`} on table ${relation} to "${runtimeRoleName}"`,
      ),
    ),
  ];
}

export async function assertSupportOwnerObjectBoundary(
  client: Pick<PoolClient, 'query'>,
  ownerRoleName: string,
  phase: 'pre' | 'post',
): Promise<void> {
  const row = (
    await client.query<{ unsafe: boolean; functionCount: number; schemaCount: number }>(
      `/* support-owner-inventory */ select
  exists(select 1 from pg_database where datdba=$1::regrole)
  or exists(select 1 from pg_namespace where nspowner=$1::regrole and nspname<>'support')
  or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relowner=$1::regrole and n.nspname not in ('support','pg_toast'))
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proowner=$1::regrole and n.nspname<>'support')
  or exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typowner=$1::regrole and n.nspname not in ('support','pg_toast')) as unsafe,
  (select count(*)::int from pg_proc p where p.proowner=$1::regrole) as "functionCount",
  (select count(*)::int from pg_namespace where nspowner=$1::regrole) as "schemaCount"`,
      [ownerRoleName],
    )
  ).rows[0];
  if (
    !row ||
    row.unsafe ||
    row.functionCount !== (phase === 'post' ? 4 : 0) ||
    row.schemaCount !== (phase === 'post' ? 1 : 0)
  )
    throw new Error('SUPPORT_OWNER_OBJECT_BOUNDARY_INVALID');
}
