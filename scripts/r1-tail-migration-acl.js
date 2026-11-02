// Narrow temporary migrator capability for the fixed eleven-file tail only.
import { r1Exact, r1Encode, r1Hash, r1Same, r1Stop } from './r1-tail-migration-profile.js';
const schemas = [
  'booking',
  'commerce',
  'eligibility',
  'games',
  'identity',
  'integration',
  'locations',
  'notifications',
];
const createSchemas = new Set(['booking', 'commerce', 'games', 'integration', 'notifications']);
const references = Object.freeze({
  'identity.tenants': ['id'],
  'identity.users': ['tenant_id', 'id'],
  'identity.refresh_sessions': ['tenant_id', 'id'],
  'locations.profiles': ['tenant_id', 'id'],
  'integration.external_entity_map': ['tenant_id', 'id'],
  'games.command_idempotency': ['tenant_id', 'id'],
  'games.games': ['tenant_id', 'id'],
  'games.participations': ['tenant_id', 'game_id', 'id'],
  'games.seat_reservations': ['tenant_id', 'game_id', 'id'],
  'games.payment_confirmation_evidence': ['tenant_id', 'id'],
  'eligibility.decisions': ['tenant_id', 'id'],
  'eligibility.payment_snapshots': ['tenant_id', 'operation_id'],
});
const parentNames = Object.keys(references).sort();
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) r1Stop('ACL_IDENTIFIER');
  return `"${s}"`;
};
const qualified = (name) => name.split('.').map(ident).join('.');
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const parentArray = `array[${parentNames.map(literal).join(',')}]::regclass[]`;
const schemaArray = `array[${schemas.map(literal).join(',')}]::text[]`;
export const R1_TAIL_ACL_SQL = `with objects as (
 select 'schema:'||n.nspname key,n.nspowner owner,n.nspacl acl,n.nspacl is null "aclIsNull",'n'::"char" kind,
   jsonb_build_object('USAGE',pg_catalog.has_schema_privilege('phub_migrator',n.oid,'USAGE'),
    'CREATE',pg_catalog.has_schema_privilege('phub_migrator',n.oid,'CREATE')) props
 from pg_catalog.pg_namespace n where n.nspname=any(${schemaArray})
 union all
 select 'table:'||c.oid::regclass::text,c.relowner,c.relacl,c.relacl is null,'r'::"char",
   jsonb_build_object('rls',c.relrowsecurity,'force',c.relforcerowsecurity)
 from pg_catalog.pg_class c where c.oid=any(${parentArray}||array['notifications.intents','notifications.deliveries']::regclass[])
 union all
 select 'column:'||c.oid::regclass::text||':'||a.attname,c.relowner,a.attacl,a.attacl is null,'c'::"char",
   jsonb_build_object('REFERENCES',pg_catalog.has_column_privilege('phub_migrator',c.oid,a.attnum,'REFERENCES'))
 from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 where c.oid=any(${parentArray})
 or(c.oid='notifications.intents'::regclass and a.attacl is not null)
) select coalesce(jsonb_agg(jsonb_build_object('key',o.key,'owner',pg_catalog.pg_get_userbyid(o.owner),
 'aclIsNull',o."aclIsNull",'props',o.props,'acl',
 (select coalesce(jsonb_agg(jsonb_build_array(pg_catalog.pg_get_userbyid(x.grantor),
  case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end,x.privilege_type,x.is_grantable)
  order by pg_catalog.pg_get_userbyid(x.grantor) collate "C",case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end collate "C",x.privilege_type collate "C",x.is_grantable),'[]'::jsonb)
  from pg_catalog.aclexplode(case when o.kind='c' then o.acl else coalesce(o.acl,pg_catalog.acldefault(o.kind,o.owner)) end)x))
 order by o.key collate "C"),'[]'::jsonb) from objects o`;
export function validateR1TailAcl(rows, phase = 'cleaned') {
  if (
    !Array.isArray(rows) ||
    rows.length < 20 ||
    rows.length > 1024 ||
    r1Encode(rows).length > 1048576
  )
    r1Stop('ACL_ROWS');
  let previous = '';
  const keys = new Set();
  for (const row of rows) {
    r1Exact(row, ['key', 'owner', 'aclIsNull', 'props', 'acl']);
    if (
      typeof row.key !== 'string' ||
      row.key <= previous ||
      typeof row.aclIsNull !== 'boolean' ||
      !Array.isArray(row.acl)
    )
      r1Stop('ACL_ROW');
    previous = row.key;
    keys.add(row.key);
    ident(row.owner);
    const [kind, name, column] = row.key.split(':');
    if (kind === 'schema') {
      if (!schemas.includes(name)) r1Stop('ACL_SCOPE');
      r1Exact(row.props, ['USAGE', 'CREATE']);
      if (Object.values(row.props).some((value) => typeof value !== 'boolean')) r1Stop('ACL_PROPS');
    } else if (kind === 'table') {
      if (
        !parentNames.includes(name) &&
        !['notifications.intents', 'notifications.deliveries'].includes(name)
      )
        r1Stop('ACL_SCOPE');
      r1Exact(row.props, ['rls', 'force']);
      if (Object.values(row.props).some((value) => typeof value !== 'boolean')) r1Stop('ACL_PROPS');
    } else if (kind === 'column') {
      if (!parentNames.includes(name) && name !== 'notifications.intents') r1Stop('ACL_SCOPE');
      ident(column);
      r1Exact(row.props, ['REFERENCES']);
      if (typeof row.props.REFERENCES !== 'boolean') r1Stop('ACL_PROPS');
    } else r1Stop('ACL_SCOPE');
    let last = '';
    for (const grant of row.acl) {
      if (!Array.isArray(grant) || grant.length !== 4 || typeof grant[3] !== 'boolean')
        r1Stop('ACL_GRANT');
      ident(grant[0]);
      if (grant[1] !== 'PUBLIC') ident(grant[1]);
      if (
        ![
          'USAGE',
          'CREATE',
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ].includes(grant[2])
      )
        r1Stop('ACL_PRIVILEGE');
      const encoded = JSON.stringify(grant);
      if (encoded <= last) r1Stop('ACL_ORDER');
      last = encoded;
      if (
        name === 'notifications.intents' &&
        (grant[0] !== (phase === 'cleaned' ? 'phub_beta' : 'phub_migrator') || grant[3])
      )
        r1Stop('ACL_OWNER_RECOVERY_UNSUPPORTED');
    }
  }
  for (const schema of schemas) if (!keys.has('schema:' + schema)) r1Stop('ACL_COVERAGE');
  for (const [table, columns] of Object.entries(references)) {
    if (!keys.has('table:' + table)) r1Stop('ACL_COVERAGE');
    for (const column of columns)
      if (!keys.has('column:' + table + ':' + column)) r1Stop('ACL_COVERAGE');
  }
  for (const table of ['notifications.intents', 'notifications.deliveries']) {
    const row = rows.find((row) => row.key === 'table:' + table);
    if (
      !row ||
      row.props.rls !== true ||
      row.props.force !== true ||
      row.owner !==
        (table === 'notifications.intents' && phase === 'cleaned' ? 'phub_beta' : 'phub_migrator')
    )
      r1Stop('ACL_OWNER_RLS');
    if (table === 'notifications.intents' && row.aclIsNull)
      r1Stop('ACL_NULL_OWNER_RECOVERY_UNSUPPORTED');
  }
  return rows;
}
export function r1TailPreparationPlan(preimage) {
  validateR1TailAcl(preimage, 'cleaned');
  const added = [];
  for (const schema of schemas) {
    const row = preimage.find((row) => row.key === 'schema:' + schema);
    for (const privilege of ['USAGE', ...(createSchemas.has(schema) ? ['CREATE'] : [])])
      if (!row.props[privilege])
        added.push({
          key: row.key,
          privilege,
          sql: `grant ${privilege} on schema ${ident(schema)} to phub_migrator;`,
          inverse: `revoke ${privilege} on schema ${ident(schema)} from phub_migrator;`,
        });
  }
  for (const [table, columns] of Object.entries(references))
    for (const column of columns) {
      const row = preimage.find((row) => row.key === `column:${table}:${column}`);
      if (!row.props.REFERENCES)
        added.push({
          key: row.key,
          privilege: 'REFERENCES',
          sql: `grant references (${ident(column)}) on ${qualified(table)} to phub_migrator;`,
          inverse: `revoke references (${ident(column)}) on ${qualified(table)} from phub_migrator;`,
        });
    }
  const restoration = [
    'alter table notifications.intents owner to phub_beta;',
    ...[...added].reverse().map((row) => row.inverse),
    'revoke all privileges on notifications.intents from phub_beta,phub_migrator;',
  ];
  for (const row of preimage.filter(
    (row) =>
      row.key === 'table:notifications.intents' ||
      row.key.startsWith('column:notifications.intents:'),
  )) {
    const column = row.key.split(':')[2];
    if (column)
      restoration.push(
        `revoke all privileges (${ident(column)}) on notifications.intents from phub_beta,phub_migrator;`,
      );
    for (const [grantor, grantee, privilege] of row.acl) {
      if (grantor !== 'phub_beta') r1Stop('ACL_OWNER_RECOVERY_UNSUPPORTED');
      restoration.push(
        `grant ${privilege}${column ? ' (' + ident(column) + ')' : ''} on notifications.intents to ${grantee === 'PUBLIC' ? 'PUBLIC' : ident(grantee)};`,
      );
    }
  }
  return {
    schema: 'PHUB_R1_TAIL_PREPARATION_V1',
    preimage,
    preimageSha256: r1Hash(r1Encode(preimage)),
    added,
    bootstrapStatements: [
      ...added.map((row) => row.sql),
      'alter table notifications.intents owner to phub_migrator;',
    ],
    cleanupStatements: restoration,
  };
}
export function validateR1TailPreparation(value, preimage) {
  if (!r1Same(value, r1TailPreparationPlan(preimage))) r1Stop('PREPARATION_DRIFT');
  return value;
}
// The guard and all DDL share one transaction. Source code constructs statements, never JSON.
export function r1TailAclTransaction(preparation, phase, expected) {
  validateR1TailPreparation(preparation, preparation.preimage);
  validateR1TailAcl(expected, phase === 'bootstrap' ? 'cleaned' : 'prepared');
  if (!['bootstrap', 'cleanup'].includes(phase)) r1Stop('ACL_PHASE');
  const before = literal(JSON.stringify(expected));
  const after =
    phase === 'cleanup'
      ? `if (${R1_TAIL_ACL_SQL}) is distinct from ${literal(JSON.stringify(preparation.preimage))}::jsonb then raise exception 'R1_TAIL_ACL_CLEANUP_DRIFT';end if;`
      : '';
  return `begin;set local search_path='pg_catalog';set local lock_timeout='5s';set local statement_timeout='30s';
    do $r1tail$ begin
    if (${R1_TAIL_ACL_SQL}) is distinct from ${before}::jsonb then raise exception 'R1_TAIL_ACL_PREIMAGE_DRIFT';end if;
    ${preparation[phase === 'bootstrap' ? 'bootstrapStatements' : 'cleanupStatements'].join('\n')}
    ${after} end $r1tail$;commit;`;
}
