import { createHash } from 'node:crypto';

const MIGRATOR = 'phub_migrator';
const OWNER = 'phub_beta';
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
      : item,
  );
const same = (a, b) => canonical(a) === canonical(b);
const fail = (code) => {
  throw Error(`CLOSED_APPLICATION_ACL_${code}`);
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail('SHAPE');
};
const permissions = Object.freeze({
  game_start_0103: Object.freeze(
    [
      ['schema:notifications', 'CREATE'],
      ['column:identity.tenants:id', 'REFERENCES'],
      ['column:identity.users:id', 'REFERENCES'],
      ['column:identity.users:tenant_id', 'REFERENCES'],
      ['column:games.games:id', 'REFERENCES'],
      ['column:games.games:tenant_id', 'REFERENCES'],
    ].map((row) => Object.freeze(row)),
  ),
  subject_link_0104: Object.freeze(
    [
      ['schema:identity', 'CREATE'],
      ['column:identity.users:id', 'REFERENCES'],
      ['column:identity.users:tenant_id', 'REFERENCES'],
    ].map((row) => Object.freeze(row)),
  ),
});
function rules(profile) {
  if (!Object.hasOwn(permissions, profile)) fail('PROFILE');
  return permissions[profile];
}
function scope(profile) {
  const selected = rules(profile);
  return {
    schema: selected[0][0].slice(7),
    tables: [...new Set(selected.slice(1).map(([key]) => key.split(':')[1]))].sort(compare),
  };
}
export function closedApplicationAclSql(profile) {
  const { schema, tables } = scope(profile);
  const names = tables.map((name) => `'${name}'`).join(',');
  // All table/column ACLs in the fixed parent scope are captured, including unrelated privileges.
  return `with acl_objects as (
    select 'schema:'||n.nspname key,n.nspowner owner,n.nspacl acl,n.nspacl is null "aclIsNull",
      jsonb_build_object('CREATE',pg_catalog.has_schema_privilege('${MIGRATOR}',n.oid,'CREATE'),'USAGE',pg_catalog.has_schema_privilege('${MIGRATOR}',n.oid,'USAGE')) effective,
      'n'::"char" aclkind from pg_catalog.pg_namespace n where n.nspname='${schema}'
    union all select 'table:'||c.oid::regclass::text,c.relowner,c.relacl,c.relacl is null,
      jsonb_build_object('REFERENCES',pg_catalog.has_table_privilege('${MIGRATOR}',c.oid,'REFERENCES')),'r'::"char"
      from pg_catalog.pg_class c where c.oid=any(array[${names}]::regclass[])
    union all select 'column:'||c.oid::regclass::text||':'||a.attname,c.relowner,a.attacl,a.attacl is null,
      jsonb_build_object('REFERENCES',pg_catalog.has_column_privilege('${MIGRATOR}',c.oid,a.attnum,'REFERENCES')),'c'::"char"
      from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid=c.oid
      where c.oid=any(array[${names}]::regclass[]) and a.attnum>0 and not a.attisdropped
  ) select coalesce(jsonb_agg(jsonb_build_object('key',o.key,'owner',pg_catalog.pg_get_userbyid(o.owner),
    'aclIsNull',o."aclIsNull",'effective',o.effective,'acl',
      (select coalesce(jsonb_agg(jsonb_build_array(pg_catalog.pg_get_userbyid(x.grantor),
        case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end,
        x.privilege_type,x.is_grantable) order by pg_catalog.pg_get_userbyid(x.grantor) collate "C",
        case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end collate "C",x.privilege_type collate "C",x.is_grantable),'[]'::jsonb)
       from pg_catalog.aclexplode(case when o.aclkind='c' then o.acl else coalesce(o.acl,pg_catalog.acldefault(o.aclkind,o.owner)) end) x)) order by o.key collate "C"),'[]'::jsonb) from acl_objects o`;
}
export function validateClosedApplicationAcl(profile, rows) {
  const { schema, tables } = scope(profile);
  if (
    !Array.isArray(rows) ||
    rows.length < 3 ||
    rows.length > 512 ||
    Buffer.byteLength(canonical(rows)) > 262144
  )
    fail('ROWS');
  let previous = '';
  for (const row of rows) {
    exact(row, ['key', 'owner', 'aclIsNull', 'effective', 'acl']);
    const parts = typeof row.key === 'string' ? row.key.split(':') : [];
    const schemaRow = row.key === `schema:${schema}`;
    if (
      !(
        schemaRow ||
        (parts[0] === 'table' && parts.length === 2 && tables.includes(parts[1])) ||
        (parts[0] === 'column' &&
          parts.length === 3 &&
          tables.includes(parts[1]) &&
          identifier.test(parts[2]))
      ) ||
      row.key <= previous ||
      row.owner !== OWNER ||
      typeof row.aclIsNull !== 'boolean' ||
      !Array.isArray(row.acl)
    )
      fail('ROW');
    previous = row.key;
    exact(row.effective, schemaRow ? ['CREATE', 'USAGE'] : ['REFERENCES']);
    if (
      Object.values(row.effective).some((value) => typeof value !== 'boolean') ||
      (schemaRow && (!row.effective.USAGE || row.aclIsNull))
    )
      fail('EFFECTIVE');
    let last = '';
    for (const grant of row.acl) {
      if (
        !Array.isArray(grant) ||
        grant.length !== 4 ||
        !identifier.test(grant[0]) ||
        !(identifier.test(grant[1]) || grant[1] === 'PUBLIC') ||
        !(
          schemaRow
            ? ['CREATE', 'USAGE']
            : parts[0] === 'column'
              ? ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
              : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        ).includes(grant[2]) ||
        typeof grant[3] !== 'boolean' ||
        (grant[1] === MIGRATOR && grant[3])
      )
        fail('GRANT');
      const key = JSON.stringify(grant);
      if (key <= last) fail('GRANT_ORDER');
      last = key;
    }
    if (parts[0] === 'column' && row.aclIsNull && row.acl.length !== 0) fail('NULL_ACL');
  }
  const keys = new Set(rows.map((row) => row.key));
  if (
    !keys.has(`schema:${schema}`) ||
    tables.some((table) => !keys.has(`table:${table}`)) ||
    rules(profile).some(([key]) => !keys.has(key))
  )
    fail('COVERAGE');
  return rows;
}
export function closedApplicationAclPlan(profile, preimage) {
  validateClosedApplicationAcl(profile, preimage);
  preimage = JSON.parse(JSON.stringify(preimage));
  const bootstrap = JSON.parse(JSON.stringify(preimage));
  const added = [];
  for (const [key, privilege] of rules(profile)) {
    const row = bootstrap.find((item) => item.key === key);
    const direct = row.acl.filter((grant) => grant[1] === MIGRATOR && grant[2] === privilege);
    if (direct.length > 1 || (direct.length === 1 && !row.effective[privilege]))
      fail('DIRECT_EFFECTIVE');
    if (row.effective[privilege]) continue;
    if (direct.length) fail('DIRECT_EFFECTIVE');
    row.acl.push([OWNER, MIGRATOR, privilege, false]);
    row.acl.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    row.aclIsNull = false;
    row.effective[privilege] = true;
    added.push([key, privilege]);
  }
  const statement = ([key, privilege], revoke) => {
    const [kind, object, column] = key.split(':');
    const target = kind === 'schema' ? `schema ${object}` : object;
    const right = kind === 'column' ? `${privilege} (${column})` : privilege;
    // Names and privilege strings come exclusively from the fixed profile rules.
    return `${revoke ? 'revoke' : 'grant'} ${right} on ${target} ${revoke ? 'from' : 'to'} ${MIGRATOR};`;
  };
  const guard = (expected) =>
    `do $closed_acl$ begin if (${closedApplicationAclSql(profile)}) is distinct from '${JSON.stringify(expected).replaceAll("'", "''")}'::jsonb then raise exception 'CLOSED_APPLICATION_ACL_DRIFT'; end if; end $closed_acl$;`;
  const transaction = (before, after, statements) =>
    `begin;set local search_path='pg_catalog';set local lock_timeout='5s';set local statement_timeout='30s';do $closed_lock$ begin perform pg_catalog.pg_advisory_xact_lock(7140221);end $closed_lock$;${guard(before)}${statements.join('')}${guard(after)}commit;`;
  const bootstrapSql = transaction(
    preimage,
    bootstrap,
    added.map((row) => statement(row, false)),
  );
  const cleanupSql = transaction(
    bootstrap,
    preimage,
    [...added].reverse().map((row) => statement(row, true)),
  );
  const seal = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) seal(item);
      Object.freeze(value);
    }
    return value;
  };
  return seal({
    profile,
    preimage,
    bootstrap,
    added,
    bootstrapSql,
    cleanupSql,
    preimageSha256: createHash('sha256').update(canonical(preimage)).digest('hex'),
    bootstrapSha256: createHash('sha256').update(bootstrapSql).digest('hex'),
    cleanupSha256: createHash('sha256').update(cleanupSql).digest('hex'),
  });
}
