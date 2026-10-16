import type { PoolClient } from 'pg';

export const SUPPORT_TICKET_RUNTIME_PRIVILEGES = {
  tickets: ['SELECT', 'INSERT', 'UPDATE'],
  messages: ['SELECT', 'INSERT', 'DELETE'],
  history: ['SELECT', 'INSERT'],
  commands: ['SELECT', 'INSERT', 'UPDATE'],
} as const;
export type SupportTicketRelation = keyof typeof SUPPORT_TICKET_RUNTIME_PRIVILEGES;
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
/** Source-only statements for an explicitly authorized exact migrator/runtime target. Never auto-executed. */
export function supportTicketRuntimeGrantStatements(runtimeRoleName: string): readonly string[] {
  if (!runtimeRoleName) throw new Error('SUPPORT_RUNTIME_ROLE_INVALID');
  const role = quoteIdentifier(runtimeRoleName);
  return [
    'revoke all privileges on schema support from public',
    `revoke all privileges on schema support from ${role}`,
    `grant usage on schema support to ${role}`,
    ...Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES).flatMap(([name, privileges]) => {
      const table = `support.${quoteIdentifier(name)}`;
      return [
        `revoke all privileges on table ${table} from public`,
        `revoke all privileges on table ${table} from ${role}`,
        `grant ${privileges.join(', ')} on table ${table} to ${role}`,
      ];
    }),
  ];
}
interface Grant {
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
}
interface Policy {
  readonly name: string;
  readonly command: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using: string;
  readonly check: string;
}
interface Relation {
  readonly name: string;
  readonly owner: string;
  readonly forceRls: boolean;
  readonly enabledRls: boolean;
  readonly policies: readonly Policy[];
  readonly grants: readonly Grant[];
  readonly columnGrants: number;
  readonly runtimePrivileges: readonly string[];
}
export interface SupportTicketAclSnapshot {
  readonly runtime: {
    readonly name: string;
    readonly superuser: boolean;
    readonly bypassRls: boolean;
    readonly createRole: boolean;
    readonly createDatabase: boolean;
    readonly replication: boolean;
    readonly canAssumeOwner: boolean;
    readonly schemaCreate: boolean;
  };
  readonly schema: { readonly owner: string; readonly grants: readonly Grant[] };
  readonly relations: readonly Relation[];
  readonly retentionGuards: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly owner: string;
    readonly securityDefiner: boolean;
    readonly relation: string;
    readonly functionName: string;
    readonly triggerType: number;
    readonly argumentCount: number;
    readonly unconditional: boolean;
  }[];
}
const tenantExpression =
  "tenant_id=nullif(current_setting('app.tenant_id'::text,true),''::text)::uuid";
const normalizePolicy = (value: string): string => value.toLowerCase().replace(/[\s()]/gu, '');
export function assertSupportTicketAclBoundary(
  snapshot: SupportTicketAclSnapshot,
  expected: { readonly runtimeRoleName: string; readonly migratorRoleName: string },
): void {
  const runtime = snapshot.runtime;
  if (
    runtime.name !== expected.runtimeRoleName ||
    Object.entries(runtime).some(([key, value]) => key !== 'name' && value === true) ||
    expected.runtimeRoleName === expected.migratorRoleName
  )
    throw new Error('SUPPORT_RUNTIME_ROLE_UNSAFE');
  if (snapshot.schema.owner !== expected.migratorRoleName)
    throw new Error('SUPPORT_SCHEMA_OWNER_INVALID');
  const allowedGrants = (grants: readonly Grant[], privileges: readonly string[]) =>
    grants.every(
      (grant) =>
        grant.grantee === expected.migratorRoleName ||
        (grant.grantee === expected.runtimeRoleName &&
          !grant.grantable &&
          privileges.includes(grant.privilege)),
    );
  if (
    !allowedGrants(snapshot.schema.grants, ['USAGE']) ||
    !snapshot.schema.grants.some(
      (grant) =>
        grant.grantee === expected.runtimeRoleName &&
        grant.privilege === 'USAGE' &&
        !grant.grantable,
    )
  )
    throw new Error('SUPPORT_SCHEMA_GRANTS_INVALID');
  if (snapshot.relations.length !== Object.keys(SUPPORT_TICKET_RUNTIME_PRIVILEGES).length)
    throw new Error('SUPPORT_RELATION_INVENTORY_INVALID');
  const guards = [
    {
      name: 'support_ticket_lifecycle_guard',
      relation: 'tickets',
      functionName: 'support.guard_ticket_lifecycle',
      triggerType: 23,
    },
    {
      name: 'support_message_retention_guard',
      relation: 'messages',
      functionName: 'support.guard_retention_message_delete',
      triggerType: 11,
    },
    {
      name: 'support_receipt_retention_guard',
      relation: 'commands',
      functionName: 'support.guard_receipt_retirement',
      triggerType: 19,
    },
    {
      name: 'support_archived_message_guard',
      relation: 'messages',
      functionName: 'support.guard_archived_message_insert',
      triggerType: 7,
    },
  ];
  // PostgreSQL tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16.
  if (
    snapshot.retentionGuards.length !== guards.length ||
    guards.some(
      (definition) =>
        !snapshot.retentionGuards.some(
          (guard) =>
            guard.name === definition.name &&
            guard.enabled &&
            guard.owner === expected.migratorRoleName &&
            !guard.securityDefiner &&
            guard.relation === definition.relation &&
            guard.functionName === definition.functionName &&
            guard.triggerType === definition.triggerType &&
            guard.argumentCount === 0 &&
            guard.unconditional,
        ),
    )
  )
    throw new Error('SUPPORT_RETENTION_GUARDS_INVALID');
  for (const [name, privileges] of Object.entries(SUPPORT_TICKET_RUNTIME_PRIVILEGES)) {
    const relation = snapshot.relations.find((row) => row.name === name);
    if (
      !relation ||
      relation.owner !== expected.migratorRoleName ||
      !relation.enabledRls ||
      !relation.forceRls ||
      relation.columnGrants !== 0 ||
      !allowedGrants(relation.grants, privileges) ||
      [...relation.runtimePrivileges].sort().join(',') !== [...privileges].sort().join(',')
    )
      throw new Error('SUPPORT_RELATION_GRANTS_INVALID');
    const policy = relation.policies[0];
    if (
      relation.policies.length !== 1 ||
      !policy ||
      policy.name !== `support_${name}_tenant` ||
      policy.command !== '*' ||
      !policy.permissive ||
      policy.roles.join(',') !== 'PUBLIC' ||
      normalizePolicy(policy.using) !== normalizePolicy(tenantExpression) ||
      normalizePolicy(policy.check) !== normalizePolicy(tenantExpression)
    )
      throw new Error('SUPPORT_TENANT_POLICY_INVALID');
  }
}
export async function inspectSupportTicketAclBoundary(
  client: Pick<PoolClient, 'query'>,
  runtimeRoleName: string,
  migratorRoleName: string,
): Promise<SupportTicketAclSnapshot> {
  const role = await client.query<SupportTicketAclSnapshot['runtime']>(
    `select rolname as name,rolsuper as superuser,rolbypassrls as "bypassRls",rolcreaterole as "createRole",rolcreatedb as "createDatabase",rolreplication as replication,
     pg_has_role(rolname,$2,'MEMBER') as "canAssumeOwner",has_schema_privilege(rolname,'support','CREATE') as "schemaCreate" from pg_roles where rolname=$1`,
    [runtimeRoleName, migratorRoleName],
  );
  const runtime = role.rows[0];
  if (!runtime) throw new Error('SUPPORT_RUNTIME_ROLE_MISSING');
  const schema = await client.query<SupportTicketAclSnapshot['schema']>(
    `select pg_get_userbyid(n.nspowner) as owner,coalesce((select jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable)) from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a),'[]'::jsonb) as grants from pg_namespace n where n.nspname='support'`,
  );
  if (!schema.rows[0]) throw new Error('SUPPORT_SCHEMA_MISSING');
  const relations = await client.query<Relation>(
    `select c.relname as name,pg_get_userbyid(c.relowner) as owner,c.relforcerowsecurity as "forceRls",c.relrowsecurity as "enabledRls",
     coalesce((select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(select jsonb_agg(case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end) from unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))) from pg_policy p where p.polrelid=c.oid),'[]'::jsonb) as policies,
     coalesce((select jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'privilege',a.privilege_type,'grantable',a.is_grantable)) from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),'[]'::jsonb) as grants,
     (select count(*)::integer from pg_attribute a where a.attrelid=c.oid and a.attacl is not null) as "columnGrants",
     array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege($1,c.oid,p)) as "runtimePrivileges"
     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='support' and c.relkind in ('r','p') order by c.relname`,
    [runtimeRoleName],
  );
  const retentionGuards = await client.query<SupportTicketAclSnapshot['retentionGuards'][number]>(
    `select t.tgname as name,t.tgenabled in ('O','A') as enabled,pg_get_userbyid(p.proowner) as owner,p.prosecdef as "securityDefiner",c.relname as relation,fn.nspname||'.'||p.proname as "functionName",t.tgtype::integer as "triggerType",t.tgnargs::integer as "argumentCount",t.tgqual is null as unconditional from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace fn on fn.oid=p.pronamespace where n.nspname='support' and not t.tgisinternal order by t.tgname`,
  );
  return {
    runtime,
    schema: schema.rows[0],
    relations: relations.rows,
    retentionGuards: retentionGuards.rows,
  };
}
