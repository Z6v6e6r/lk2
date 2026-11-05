// Fixed post119 runtime ACL transaction; no connector, CLI or activation authority.
import { createHash } from 'node:crypto';
import { r1RuntimePrivilegeRequirements } from './r1-runtime-privilege-audit.js';
import { r1PackagedInventory, r1Same } from './r1-tail-migration-profile.js';
const ROLE = 'phub_runtime',
  OWNER = 'phub_migrator';
const requirements = new Map();
for (const component of ['api', 'worker'])
  for (const row of r1RuntimePrivilegeRequirements(component)) {
    if (!row.tenantTable) continue;
    const previous = requirements.get(row.relation) ?? { privileges: [], columns: [] };
    previous.privileges = [...new Set([...previous.privileges, ...row.privileges])].sort();
    previous.columns = [...new Set([...previous.columns, ...row.updateColumns])].sort();
    requirements.set(row.relation, previous);
  }
const names = [...requirements.keys()].sort();
const schemas = [...new Set(names.map((name) => name.split('.')[0]))].sort();
const need = (ok) => {
  if (!ok) throw Error('R1_RUNTIME_GRANT_BOUNDARY');
};
const ident = (s) => {
  need(typeof s === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(s));
  return `"${s}"`;
};
const qualified = (s) => s.split('.').map(ident).join('.');
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const encode = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
const digest = (v) => createHash('sha256').update(encode(v)).digest('hex');
const exact = (v, keys) =>
  need(
    v && typeof v === 'object' && !Array.isArray(v) && r1Same(Object.keys(v).sort(), keys.sort()),
  );
const acl = (expression, owner) =>
  `(select coalesce(jsonb_agg(jsonb_build_array(pg_catalog.pg_get_userbyid(a.grantor),case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by pg_catalog.pg_get_userbyid(a.grantor) collate "C",case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb) from pg_catalog.aclexplode(${owner ? `coalesce(${expression},pg_catalog.acldefault('r',${owner}))` : expression}) a)`;
export const R1_RUNTIME_GRANT_CATALOG_SQL = `select jsonb_build_object(
 'databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()),'recovery',pg_catalog.pg_is_in_recovery(),
 'roleSafe',exists(select 1 from pg_catalog.pg_roles r where r.rolname='phub_runtime' and not(r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls) and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)),
 'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_catalog.pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,'migratorUsage',pg_catalog.has_schema_privilege('phub_migrator',n.oid,'USAGE'),'migratorCreate',pg_catalog.has_schema_privilege('phub_migrator',n.oid,'CREATE')) order by n.nspname collate "C") from pg_catalog.pg_namespace n where n.nspname=any(array[${schemas.map(literal).join(',')}]::text[])),
 'ledger',(select jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) order by filename collate "C") from public.schema_migrations),
 'tables',(select jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||c.relname,'owner',pg_catalog.pg_get_userbyid(c.relowner),'kind',c.relkind::text,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
 'schemaUsage',pg_catalog.has_schema_privilege('phub_runtime',n.oid,'USAGE'),'schemaCreate',pg_catalog.has_schema_privilege('phub_runtime',n.oid,'CREATE'),'schemaOwnerAssumable',pg_catalog.pg_has_role('phub_runtime',n.nspowner,'MEMBER'),
 'acl',${acl('c.relacl', 'c.relowner')},'columns',(select jsonb_agg(jsonb_build_object('name',col.attname,'acl',${acl('col.attacl')}) order by col.attname collate "C") from pg_catalog.pg_attribute col where col.attrelid=c.oid and col.attnum>0 and not col.attisdropped)) order by n.nspname collate "C",c.relname collate "C") from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname||'.'||c.relname=any(array[${names.map(literal).join(',')}]::text[])))`;
function validate(snapshot) {
  exact(snapshot, [
    'databaseName',
    'systemIdentifier',
    'recovery',
    'roleSafe',
    'schemas',
    'ledger',
    'tables',
  ]);
  ident(snapshot.databaseName);
  need(
    typeof snapshot.systemIdentifier === 'string' &&
      /^[1-9][0-9]*$/.test(snapshot.systemIdentifier),
  );
  need(snapshot.recovery === false && snapshot.roleSafe === true);
  need(Array.isArray(snapshot.schemas) && snapshot.schemas.length === schemas.length);
  for (const [i, row] of snapshot.schemas.entries()) {
    exact(row, ['name', 'owner', 'acl', 'migratorUsage', 'migratorCreate']);
    need(row.name === schemas[i]);
    ident(row.owner);
    // Existing runtime USAGE requires an explicit ACL here. Refuse null rather than
    // materialize a default ACL that GRANT/REVOKE could not restore byte-for-byte.
    need(
      typeof row.acl === 'string' &&
        row.acl.startsWith('{') &&
        row.acl.endsWith('}') &&
        row.acl.length <= 65536,
    );
    need(typeof row.migratorUsage === 'boolean' && typeof row.migratorCreate === 'boolean');
  }
  r1PackagedInventory(snapshot.ledger);
  need(Array.isArray(snapshot.tables) && snapshot.tables.length === names.length);
  for (const [i, row] of snapshot.tables.entries()) {
    exact(row, [
      'relation',
      'owner',
      'kind',
      'rls',
      'forceRls',
      'schemaUsage',
      'schemaCreate',
      'schemaOwnerAssumable',
      'acl',
      'columns',
    ]);
    need(
      row.relation === names[i] &&
        row.owner === OWNER &&
        row.kind === 'r' &&
        row.rls === true &&
        row.forceRls === true &&
        row.schemaUsage === true &&
        row.schemaCreate === false &&
        row.schemaOwnerAssumable === false,
    );
    need(Array.isArray(row.columns) && row.columns.length > 0);
    let last = '';
    for (const column of row.columns) {
      exact(column, ['name', 'acl']);
      ident(column.name);
      need(column.name > last);
      last = column.name;
    }
    for (const [column, entries] of [[null, row.acl], ...row.columns.map((c) => [c.name, c.acl])]) {
      need(Array.isArray(entries));
      let previous = '';
      for (const entry of entries) {
        need(
          Array.isArray(entry) &&
            entry.length === 4 &&
            entry[0] === OWNER &&
            typeof entry[3] === 'boolean',
        );
        if (entry[1] !== 'PUBLIC') ident(entry[1]);
        need(
          (column
            ? ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
            : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
          ).includes(entry[2]),
        );
        const key = JSON.stringify(entry);
        need(key > previous);
        previous = key;
        need(
          !(entry[1] === 'PUBLIC' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(entry[2])),
        );
        if (entry[1] === ROLE) need(!entry[3] && !['TRUNCATE', 'TRIGGER'].includes(entry[2]));
      }
    }
    for (const col of requirements.get(row.relation).columns)
      need(row.columns.some((c) => c.name === col));
  }
  return snapshot;
}
function statement(action, table, column, privilege) {
  return `${action} ${privilege}${column ? '(' + ident(column) + ')' : ''} on ${qualified(table)} ${action === 'grant' ? 'to' : 'from'} ${ROLE};`;
}
export function planR1RuntimeGrants119(preimage) {
  validate(preimage);
  const postimage = structuredClone(preimage),
    changes = [];
  for (const row of postimage.tables) {
    const req = requirements.get(row.relation);
    // Only this new command receipt has a narrower write contract than inherited defaults.
    if (row.relation === 'identity.external_subject_link_commands')
      for (const [column, entries] of [
        [null, row.acl],
        ...row.columns.map((c) => [c.name, c.acl]),
      ]) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (
            entry[1] === ROLE &&
            (entry[2] === 'DELETE' ||
              (entry[2] === 'UPDATE' && (!column || !req.columns.includes(column))))
          ) {
            changes.push({ action: 'revoke', relation: row.relation, column, privilege: entry[2] });
            entries.splice(i, 1);
          }
        }
      }
    for (const [column, privilege] of [
      ...req.privileges.map((p) => [null, p]),
      ...req.columns.map((c) => [c, 'UPDATE']),
    ]) {
      const entries = column ? row.columns.find((c) => c.name === column).acl : row.acl;
      if (entries.some((e) => e[1] === ROLE && e[2] === privilege)) continue;
      if (column && row.acl.some((e) => e[1] === ROLE && e[2] === privilege)) continue;
      entries.push([OWNER, ROLE, privilege, false]);
      entries.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      changes.push({ action: 'grant', relation: row.relation, column, privilege });
    }
  }
  validate(postimage);
  return {
    schema: 'PHUB_R1_RUNTIME_GRANTS119_V2',
    preimage: structuredClone(preimage),
    preimageSha256: digest(preimage),
    postimage,
    postimageSha256: digest(postimage),
    changes,
  };
}
// Caller owns authenticated target/capsule/locks and terminal119 proof. Never accept statements
// from a receipt. SQL is reconstructed from the source-owned fixed matrix on every invocation.
export function r1RuntimeGrantTransaction119(plan, phase) {
  need(phase === 'apply' || phase === 'recover');
  need(r1Same(plan, planR1RuntimeGrants119(plan.preimage)));
  const apply = phase === 'apply',
    before = apply ? plan.preimage : plan.postimage,
    after = apply ? plan.postimage : plan.preimage;
  const changes = apply
    ? plan.changes
    : [...plan.changes]
        .reverse()
        .map((c) => ({ ...c, action: c.action === 'grant' ? 'revoke' : 'grant' }));
  const transactionCatalog = R1_RUNTIME_GRANT_CATALOG_SQL.replace(
    '(select system_identifier::text from pg_catalog.pg_control_system())',
    "current_setting('phub.r1_grant_system_identifier')",
  );
  const missingUsage = before.schemas.filter((row) => !row.migratorUsage);
  const schemaStatements = (action) =>
    missingUsage
      .map(
        (row) =>
          `set local role ${ident(row.owner)};${action} USAGE on schema ${ident(row.name)} ${action === 'grant' ? 'to' : 'from'} phub_migrator;reset role;`,
      )
      .join('\n');
  const check = (snapshot, code, omitSchemas = false) =>
    `if ((${transactionCatalog})${omitSchemas ? " - 'schemas'" : ''}) is distinct from (${literal(encode(snapshot))}::jsonb${omitSchemas ? " - 'schemas'" : ''}) then raise exception '${code}';end if;`;
  return `begin;select set_config('phub.r1_grant_system_identifier',(select system_identifier::text from pg_catalog.pg_control_system()),true);set local search_path='pg_catalog';set local lock_timeout='5s';set local statement_timeout='30s';
do $r1pre$ begin
if current_user <> session_user then raise exception 'R1_RUNTIME_GRANT_ADMIN_ROLE';end if;
lock table public.schema_migrations in share mode;
${names.map((n) => `lock table ${qualified(n)} in share row exclusive mode;`).join('\n')}
${check(before, 'R1_RUNTIME_GRANT_PREIMAGE_DRIFT')}
end $r1pre$;
${schemaStatements('grant')}
set local role phub_migrator;
do $r1grants$ begin
${check(before, 'R1_RUNTIME_GRANT_PREIMAGE_DRIFT', true)}
${changes.map((c) => statement(c.action, c.relation, c.column, c.privilege)).join('\n')}
${check(after, 'R1_RUNTIME_GRANT_POSTIMAGE_DRIFT', true)}
end $r1grants$;
reset role;
${schemaStatements('revoke')}
do $r1post$ begin
${check(after, 'R1_RUNTIME_GRANT_POSTIMAGE_DRIFT')}
end $r1post$;commit;`;
}

// Translate only the exact table/column ACLs in a reviewed grant plan into the existing
// semantic catalog representation. All non-ACL fields and all other relations survive.
export function r1RuntimeGrantCatalog119(catalog, grantPlan) {
  need(r1Same(grantPlan, planR1RuntimeGrants119(grantPlan.preimage)));
  const result = structuredClone(catalog);
  const normalized = (acl, relation) =>
    acl
      .map(([grantor, grantee, privilege, grantable]) => [
        relation && grantee === 'phub_runtime'
          ? 'RUNTIME'
          : relation && grantee === 'phub_migrator'
            ? 'MIGRATOR'
            : grantee,
        relation && grantor === 'phub_migrator' ? 'MIGRATOR' : grantor,
        privilege,
        grantable,
      ])
      .sort((a, b) => {
        for (let i = 0; i < 3; i++) {
          if (a[i] < b[i]) return -1;
          if (a[i] > b[i]) return 1;
        }
        return 0;
      });
  // The frozen PostgreSQL catalog stores value::text, not parsed JSON objects.
  // Replace only its top-level ACL token; preserve every other byte (including
  // PostgreSQL jsonb key order and spacing) for the existing catalog attestation.
  const pgAcl = (entries) =>
    '[' +
    entries.map((entry) => '[' + entry.map((x) => JSON.stringify(x)).join(', ') + ']').join(', ') +
    ']';
  const replaceAcl = (row, before, after) => {
    need(row && typeof row.value === 'string');
    const parsed = JSON.parse(row.value);
    need(r1Same(parsed.acl, before));
    const token = '"acl": ' + pgAcl(before);
    const offset = row.value.indexOf(token);
    need(offset >= 0 && row.value.indexOf(token, offset + token.length) < 0);
    const next =
      row.value.slice(0, offset) +
      '"acl": ' +
      pgAcl(after) +
      row.value.slice(offset + token.length);
    need(r1Same(JSON.parse(next), { ...parsed, acl: after }));
    row.value = next;
  };
  for (const table of grantPlan.postimage.tables) {
    const previous = grantPlan.preimage.tables.find((x) => x.relation === table.relation);
    const relation = result.find((x) => x.key === 'relation:' + table.relation);
    if (!relation) continue; // The separate grant snapshot covers all18; tail catalog has its own fixed scope.
    replaceAcl(relation, normalized(previous.acl, true), normalized(table.acl, true));
    for (const col of table.columns) {
      const row = result.find((x) => x.key === 'column:' + table.relation + ':' + col.name);
      replaceAcl(
        row,
        normalized(previous.columns.find((x) => x.name === col.name).acl, false),
        normalized(col.acl, false),
      );
    }
  }
  return result;
}
