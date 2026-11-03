// Fixed R1 catalog diagnostic. No connector, grants, runner or activation authority.
const make = (relation, privileges, options = {}) => ({
  relation,
  privileges,
  updateColumns: [],
  rowLock: false,
  tenantTable: true,
  restrictedCommandUpdates: false,
  ...options,
});
const api = [
  make('identity.external_subject_link_commands', ['SELECT', 'INSERT'], {
    updateColumns: ['outcome', 'completed_at'],
    restrictedCommandUpdates: true,
  }),
  make('integration.game_create_location_bindings', ['SELECT'], { rowLock: true }),
  make('games.managed_self_leave_attempts', ['SELECT', 'INSERT', 'UPDATE']),
  make('games.managed_self_leave_command_links', ['SELECT', 'INSERT']),
  make('booking.training_registration_attempts', ['SELECT', 'INSERT', 'UPDATE']),
  make('booking.tournament_local_attempts', ['SELECT', 'INSERT', 'UPDATE']),
  make('games.quarter_create_attempts', ['SELECT', 'INSERT', 'UPDATE']),
  make('commerce.monthly_purchase_attempts', ['SELECT', 'INSERT', 'UPDATE']),
  make('commerce.monthly_purchase_launches', ['SELECT', 'INSERT'], { updateColumns: ['used_at'] }),
];
const worker = [
  make('integration.game_create_location_bindings', ['SELECT', 'INSERT', 'UPDATE']),
  make('booking.tournament_local_attempts', ['SELECT']),
  make('notifications.legacy_game_reminder_source_status', ['SELECT', 'INSERT', 'UPDATE']),
  make('notifications.legacy_game_reminder_sources', ['SELECT', 'INSERT', 'UPDATE']),
  make('notifications.legacy_game_reminder_recipients', ['SELECT', 'INSERT', 'DELETE']),
  ...['station', 'tournament'].flatMap((context) => [
    make(`notifications.${context}_message_sources`, ['SELECT', 'UPDATE']),
    make(`notifications.${context}_message_facts`, ['SELECT', 'INSERT', 'UPDATE']),
    make(`notifications.${context}_message_recipient_outbox`, ['SELECT', 'INSERT', 'UPDATE']),
  ]),
];
const parentRelations = {
  api: [
    'identity.users',
    'identity.refresh_sessions',
    'identity.tenants',
    'profile.user_summaries',
    'integration.external_identity_map',
    'integration.external_entity_map',
    'integration.identity_provider_bindings',
    'games.games',
    'games.participations',
    'games.command_idempotency',
    'locations.profiles',
  ],
  worker: [
    'identity.users',
    'identity.tenants',
    'integration.external_entity_map',
    'integration.identity_provider_bindings',
    'games.games',
  ],
};
const privilegeNames = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const roleFlagNames = [
  'superuser',
  'createRole',
  'createDatabase',
  'replication',
  'bypassRls',
  'privilegedMembership',
];
const captureSchema = 'PHUB_R1_RUNTIME_PRIVILEGE_CAPTURE_V1';

function need(ok) {
  if (!ok) throw Error('R1_RUNTIME_PRIVILEGE_CAPTURE_INVALID');
}
function exact(value, names) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  need(
    Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key)),
  );
}
function privileges(value, allowed = privilegeNames) {
  need(
    Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every((p) => allowed.includes(p)),
  );
}
export function r1RuntimePrivilegeRequirements(component) {
  need(component === 'api' || component === 'worker');
  return structuredClone([
    ...(component === 'api' ? api : worker),
    ...parentRelations[component].map((name) =>
      make(name, ['SELECT'], { rowLock: true, tenantTable: false }),
    ),
  ]).sort((a, b) => a.relation.localeCompare(b.relation));
}

// Execute through the actual application connection inside a READ ONLY transaction.
// Parameters contain only this source-owned relation list and fixed component name.
export function r1RuntimePrivilegeQuery(component) {
  const requirements = r1RuntimePrivilegeRequirements(component);
  return {
    text: `with wanted as (
      select relation from pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as x(relation pg_catalog.text)
    ), relations as (
      select w.relation,c.oid,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl,
        n.oid as namespace_oid,n.nspowner as namespace_owner
      from wanted w left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(w.relation)
      left join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    ) select pg_catalog.jsonb_build_object(
      'schema','${captureSchema}','component',$2::pg_catalog.text,'capturedAt',pg_catalog.clock_timestamp(),
      'databaseName',pg_catalog.current_database(),'sessionRoleName',session_user,'currentRoleName',current_user,
      'roleOverride',pg_catalog.current_setting('role'),'readOnly',pg_catalog.current_setting('transaction_read_only'),
      'recovery',pg_catalog.pg_is_in_recovery(),
      'uuidExecute',pg_catalog.has_function_privilege(current_user,'pg_catalog.gen_random_uuid()','EXECUTE'),
      'roleFlags',pg_catalog.jsonb_build_object('superuser',r.rolsuper,'createRole',r.rolcreaterole,
        'createDatabase',r.rolcreatedb,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,
        'privilegedMembership',exists(select 1 from pg_catalog.pg_roles other where other.oid<>r.oid
          and pg_catalog.pg_has_role(session_user,other.oid,'MEMBER')
          and (other.rolsuper or other.rolcreaterole or other.rolcreatedb or other.rolreplication
            or other.rolbypassrls or pg_catalog.left(other.rolname,3)='pg_'))),
      'relations',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'relation',c.relation,'present',c.oid is not null,'kind',c.relkind::pg_catalog.text,
        'schemaUsage',coalesce(pg_catalog.has_schema_privilege(current_user,c.namespace_oid,'USAGE'),false),
        'schemaCreate',coalesce(pg_catalog.has_schema_privilege(current_user,c.namespace_oid,'CREATE'),false),
        'schemaOwnerAssumable',coalesce(pg_catalog.pg_has_role(session_user,c.namespace_owner,'MEMBER'),false),
        'ownerAssumable',coalesce(pg_catalog.pg_has_role(session_user,c.relowner,'MEMBER'),false),
        'rls',coalesce(c.relrowsecurity,false),'forceRls',coalesce(c.relforcerowsecurity,false),
        'publicDml',exists(select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          where a.grantee=0 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))
          or exists(select 1 from pg_catalog.pg_attribute col cross join lateral pg_catalog.aclexplode(col.attacl) a
            where col.attrelid=c.oid and col.attnum>0 and not col.attisdropped and a.grantee=0
              and a.privilege_type in ('SELECT','INSERT','UPDATE')),
        'dangerousDdl',coalesce(pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE')
          or pg_catalog.has_table_privilege(current_user,c.oid,'TRIGGER'),false),
        'tablePrivileges',coalesce((select pg_catalog.jsonb_agg(p order by p) from pg_catalog.unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
          where c.oid is not null and pg_catalog.has_table_privilege(current_user,c.oid,p)),'[]'::pg_catalog.jsonb),
        'columnCount',(select pg_catalog.count(*)::pg_catalog.int4 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
        'columns',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'privileges',
          coalesce((select pg_catalog.jsonb_agg(p order by p) from pg_catalog.unnest(array['SELECT','INSERT','UPDATE']) p
            where pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p)),'[]'::pg_catalog.jsonb)) order by a.attnum)
          from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'[]'::pg_catalog.jsonb)
      ) order by c.relation) from relations c)
    ) as capture from pg_catalog.pg_roles r where r.rolname=current_user`,
    values: [JSON.stringify(requirements.map(({ relation }) => ({ relation }))), component],
  };
}

export function assessR1RuntimePrivileges(value, expected) {
  exact(expected, ['component', 'databaseName', 'roleName']);
  need(typeof expected.databaseName === 'string' && expected.databaseName.length > 0);
  need(typeof expected.roleName === 'string' && expected.roleName.length > 0);
  const requirements = r1RuntimePrivilegeRequirements(expected.component);
  exact(value, [
    'schema',
    'component',
    'capturedAt',
    'databaseName',
    'sessionRoleName',
    'currentRoleName',
    'roleOverride',
    'readOnly',
    'recovery',
    'uuidExecute',
    'roleFlags',
    'relations',
  ]);
  need(value.schema === captureSchema && value.component === expected.component);
  need(typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt)));
  for (const key of [
    'databaseName',
    'sessionRoleName',
    'currentRoleName',
    'roleOverride',
    'readOnly',
  ])
    need(typeof value[key] === 'string');
  for (const key of ['recovery', 'uuidExecute']) need(typeof value[key] === 'boolean');
  exact(value.roleFlags, roleFlagNames);
  roleFlagNames.forEach((key) => need(typeof value.roleFlags[key] === 'boolean'));
  need(Array.isArray(value.relations) && value.relations.length === requirements.length);
  const byName = new Map();
  for (const row of value.relations) {
    exact(row, [
      'relation',
      'present',
      'kind',
      'schemaUsage',
      'schemaCreate',
      'ownerAssumable',
      'schemaOwnerAssumable',
      'rls',
      'forceRls',
      'publicDml',
      'dangerousDdl',
      'tablePrivileges',
      'columnCount',
      'columns',
    ]);
    need(typeof row.relation === 'string' && !byName.has(row.relation));
    for (const key of [
      'present',
      'schemaUsage',
      'schemaCreate',
      'ownerAssumable',
      'schemaOwnerAssumable',
      'rls',
      'forceRls',
      'publicDml',
      'dangerousDdl',
    ])
      need(typeof row[key] === 'boolean');
    need(row.kind === null || typeof row.kind === 'string');
    privileges(row.tablePrivileges);
    need(Number.isSafeInteger(row.columnCount) && row.columnCount >= 0);
    need(Array.isArray(row.columns) && row.columns.length === row.columnCount);
    const names = new Set();
    for (const column of row.columns) {
      exact(column, ['name', 'privileges']);
      need(typeof column.name === 'string' && column.name.length > 0 && !names.has(column.name));
      names.add(column.name);
      privileges(column.privileges, privilegeNames.slice(0, 3));
    }
    need(row.present ? row.columns.length > 0 : row.kind === null && row.columns.length === 0);
    byName.set(row.relation, row);
  }
  need(requirements.every(({ relation }) => byName.has(relation)));
  const issues = [];
  const add = (code, relation = null, privilege = null, review = false) =>
    issues.push({ code, relation, privilege, review });
  if (
    value.databaseName !== expected.databaseName ||
    value.currentRoleName !== expected.roleName ||
    value.sessionRoleName !== expected.roleName
  )
    add('CONNECTION_BINDING_MISMATCH');
  if (value.roleOverride !== 'none') add('ROLE_OVERRIDE');
  if (value.readOnly !== 'on' || value.recovery) add('READ_ONLY_PRIMARY_CAPTURE_REQUIRED');
  if (!value.uuidExecute) add('UUID_EXECUTE_MISSING');
  for (const flag of roleFlagNames) if (value.roleFlags[flag]) add('UNSAFE_ROLE_' + flag);
  for (const req of requirements) {
    const row = byName.get(req.relation);
    if (!row.present) {
      add('RELATION_MISSING', req.relation);
      continue;
    }
    if (!['r', 'p'].includes(row.kind)) add('ORDINARY_RELATION_REQUIRED', req.relation);
    if (!row.schemaUsage) add('SCHEMA_USAGE_MISSING', req.relation);
    if (row.schemaCreate || row.schemaOwnerAssumable || row.ownerAssumable || row.dangerousDdl)
      add('UNSAFE_SCHEMA_OR_OWNER_OR_DDL', req.relation);
    if (req.tenantTable && (!row.rls || !row.forceRls || row.publicDml))
      add('TENANT_TABLE_BOUNDARY_INVALID', req.relation);
    for (const privilege of req.privileges) {
      if (row.tablePrivileges.includes(privilege)) continue;
      const capabilities = row.columns.map((col) => col.privileges.includes(privilege));
      if (privilege !== 'DELETE' && capabilities.every(Boolean)) continue;
      if (privilege !== 'DELETE' && capabilities.some(Boolean))
        add('COLUMN_SCOPE_REVIEW_REQUIRED', req.relation, privilege, true);
      else add('PRIVILEGE_MISSING', req.relation, privilege);
    }
    for (const name of req.updateColumns) {
      const col = row.columns.find((c) => c.name === name);
      if (!col) add('REQUIRED_COLUMN_MISSING', req.relation, name);
      else if (!col.privileges.includes('UPDATE')) add('COLUMN_UPDATE_MISSING', req.relation, name);
    }
    if (
      req.rowLock &&
      !row.tablePrivileges.includes('UPDATE') &&
      !row.columns.some((c) => c.privileges.includes('UPDATE'))
    )
      add('ROW_LOCK_UPDATE_MISSING', req.relation);
    if (
      req.restrictedCommandUpdates &&
      (row.tablePrivileges.includes('UPDATE') ||
        row.tablePrivileges.includes('DELETE') ||
        row.columns.some(
          (col) => col.privileges.includes('UPDATE') && !req.updateColumns.includes(col.name),
        ))
    )
      add('SUBJECT_COMMAND_WRITE_SCOPE_TOO_BROAD', req.relation);
  }
  return {
    schema: 'PHUB_R1_RUNTIME_PRIVILEGE_ASSESSMENT_V1',
    component: expected.component,
    status: issues.some((issue) => !issue.review)
      ? 'BLOCKED'
      : issues.length
        ? 'REVIEW_REQUIRED'
        : 'SATISFIED',
    scope: 'R1_NEW_RELATIONS_AND_REVIEWED_ROW_LOCK_PARENTS_ONLY',
    activationAllowed: false,
    capturedAt: value.capturedAt,
    issues,
  };
}
