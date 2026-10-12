// Fixed catalog-only probes for the two migrations in the closed Android bridge.
import { exact } from './timeweb-api-worker-contract.js';

const identitySql = `select current_user as "currentRoleName", session_user as "sessionRoleName",
 current_setting('role') as "roleOverride", current_database() as "databaseName",
 (select system_identifier::text from pg_catalog.pg_control_system()) as "systemIdentifier",
 pg_catalog.pg_is_in_recovery() as recovery, current_setting('transaction_read_only') as "readOnly",
 r.rolsuper as superuser, r.rolcreaterole as "createRole", r.rolcreatedb as "createDatabase",
 r.rolreplication as replication, r.rolbypassrls as "bypassRls",
 pg_catalog.has_function_privilege(current_user,'pg_catalog.gen_random_uuid()','EXECUTE') as "uuidExecute",
 exists(select 1 from pg_catalog.pg_roles other where other.oid<>r.oid
   and pg_catalog.pg_has_role(session_user,other.oid,'MEMBER')
   and (other.rolsuper or other.rolcreaterole or other.rolcreatedb or other.rolreplication
     or other.rolbypassrls or left(other.rolname,3)='pg_')) as "privilegedMembership",
 (select count(*)::int from pg_catalog.pg_roles other where other.oid<>r.oid
  and pg_catalog.pg_has_role(session_user,other.oid,'MEMBER WITH ADMIN OPTION')) as "delegableRoles",
 exists(select 1 from pg_catalog.pg_roles reachable where pg_catalog.pg_has_role(session_user,reachable.oid,'MEMBER')
  and pg_catalog.has_database_privilege(reachable.oid,current_database(),'CREATE')) as "canCreateDatabaseObjects",
 (select count(*)::int from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
  and exists(select 1 from pg_catalog.pg_roles reachable where pg_catalog.pg_has_role(session_user,reachable.oid,'MEMBER')
   and pg_catalog.has_schema_privilege(reachable.oid,n.oid,'CREATE'))) as "controllableBusinessSchemas",
 (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','m','S','f') and pg_catalog.pg_has_role(session_user,c.relowner,'MEMBER')
  and left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema') as "controllableBusinessRelations",
 (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','f') and left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
  and exists(select 1 from pg_catalog.pg_roles reachable where pg_catalog.pg_has_role(session_user,reachable.oid,'MEMBER')
   and ((c.relkind in ('r','p','f') and pg_catalog.has_table_privilege(reachable.oid,c.oid,'TRUNCATE'))
    or pg_catalog.has_table_privilege(reachable.oid,c.oid,'TRIGGER')))) as "dangerousBusinessRelationPrivileges",
 pg_catalog.has_schema_privilege(current_user,'public','USAGE') as "publicUsage",
 pg_catalog.has_schema_privilege(current_user,'public','CREATE') as "publicCreate",
 pg_catalog.has_schema_privilege(current_user,'profile','USAGE') as "profileUsage",
 pg_catalog.has_schema_privilege(current_user,'identity','USAGE') as "identityUsage",
 pg_catalog.has_schema_privilege(current_user,'profile','CREATE') as "profileCreate",
 pg_catalog.has_schema_privilege(current_user,'identity','CREATE') as "identityCreate"
 from pg_catalog.pg_roles r where r.rolname=current_user`;

const capabilitiesSql = `select
 pg_catalog.has_language_privilege(current_user,'plpgsql','USAGE') as "plpgsqlUsage",
 pg_catalog.has_function_privilege(current_user,'pg_catalog.gen_random_uuid()','EXECUTE') as "uuidExecute",
 (select count(*)::int from pg_catalog.pg_default_acl d cross join lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclrole=current_user::regrole and d.defaclnamespace=0 and d.defaclobjtype='r'
  and a.grantee<>current_user::regrole) as "globalNonOwnerTableDefaultGrants",
 pg_catalog.pg_has_role(current_user,c.relowner,'USAGE') as "ledgerOwner",
 pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') as "ledgerSelect",
 pg_catalog.has_table_privilege(current_user,c.oid,'INSERT') as "ledgerInsert",
 pg_catalog.has_table_privilege(current_user,'identity.tenants','REFERENCES') as "tenantsReferences",
 pg_catalog.has_table_privilege(current_user,'identity.users','REFERENCES') as "usersReferences",
 pg_catalog.has_table_privilege(current_user,'identity.refresh_sessions','REFERENCES') as "sessionsReferences",
 pg_catalog.has_table_privilege(current_user,'identity.refresh_sessions','TRIGGER') as "sessionsTrigger",
 pg_catalog.has_schema_privilege($1,'profile','USAGE') as "runtimeProfileUsage",
 pg_catalog.has_schema_privilege($1,'identity','USAGE') as "runtimeIdentityUsage",
 pg_catalog.pg_has_role($1,current_user,'MEMBER') as "runtimeCanAssumeMigrator"
 from pg_catalog.pg_class c where c.oid='public.schema_migrations'::regclass`;

const aclSql = `with namespaces as (select oid,nspname from pg_catalog.pg_namespace
 where nspname in ('profile','identity')), acl as (
 select n.nspname,a.grantee,a.privilege_type,a.is_grantable
 from namespaces n join pg_catalog.pg_default_acl d
 on d.defaclrole=(select oid from pg_catalog.pg_roles where rolname=current_user)
 and d.defaclobjtype='r' and d.defaclnamespace in (0,n.oid)
 cross join lateral pg_catalog.aclexplode(d.defaclacl) a)
 select n.nspname as schema,
 count(distinct a.privilege_type) filter(where a.grantee=$1::regrole
 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))::int as "runtimeDmlCount",
 count(*) filter(where a.grantee=$1::regrole and (a.is_grantable
 or a.privilege_type not in ('SELECT','INSERT','UPDATE','DELETE')))::int as "unsafeRuntimeGrants",
 count(*) filter(where a.grantee=0)::int as "publicGrants",
 count(*) filter(where a.grantee not in ($1::regrole,current_user::regrole,0))::int as "unexpectedGrantees"
 from namespaces n left join acl a on a.nspname=n.nspname group by n.nspname order by n.nspname`;

export const MIGRATION_ROLE_PROBE_SOURCE = `import {Client} from 'pg';
const kind=process.argv[1],runtime=process.argv[2];
let client;
try {
 if(!['runtime','migrator'].includes(kind))throw Error();
 const url=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash)throw Error();
 const wireRoleName=decodeURIComponent(url.username);
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(wireRoleName))throw Error();
 client=new Client({connectionString:url.toString(),connectionTimeoutMillis:5000,
 options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000'});
 await client.connect();
 await client.query('begin transaction isolation level repeatable read read only');
 await client.query("set local statement_timeout='5s'");
 await client.query("set local lock_timeout='2s'");
 const rows=(await client.query(${JSON.stringify(identitySql)})).rows;
 if(rows.length!==1)throw Error();
 let capabilities=null,defaultAcls=[];
 if(kind==='migrator'){
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(runtime||''))throw Error();
  const caps=(await client.query(${JSON.stringify(capabilitiesSql)},[runtime])).rows;
  if(caps.length!==1)throw Error(); capabilities=caps[0];
  defaultAcls=(await client.query(${JSON.stringify(aclSql)},[runtime])).rows;
 }
 await client.query('rollback');
 process.stdout.write(JSON.stringify({schema:'PHUB_TIMEWEB_MIGRATION_ROLE_READBACK_V1',kind,
 wireRoleName,...rows[0],runtimeRoleName:kind==='migrator'?runtime:null,capabilities,defaultAcls})+'\\n');
}catch{process.stderr.write('ROLE_PROOF_UNKNOWN\\n');process.exitCode=1;}
finally{await client?.end().catch(()=>{});}`;

const fields = [
  'schema',
  'kind',
  'wireRoleName',
  'currentRoleName',
  'sessionRoleName',
  'roleOverride',
  'databaseName',
  'systemIdentifier',
  'recovery',
  'readOnly',
  'superuser',
  'createRole',
  'createDatabase',
  'replication',
  'bypassRls',
  'uuidExecute',
  'privilegedMembership',
  'delegableRoles',
  'canCreateDatabaseObjects',
  'controllableBusinessSchemas',
  'controllableBusinessRelations',
  'dangerousBusinessRelationPrivileges',
  'publicUsage',
  'publicCreate',
  'profileUsage',
  'identityUsage',
  'profileCreate',
  'identityCreate',
  'runtimeRoleName',
  'capabilities',
  'defaultAcls',
];
const capabilities = [
  'plpgsqlUsage',
  'uuidExecute',
  'globalNonOwnerTableDefaultGrants',
  'ledgerOwner',
  'ledgerSelect',
  'ledgerInsert',
  'tenantsReferences',
  'usersReferences',
  'sessionsReferences',
  'sessionsTrigger',
  'runtimeProfileUsage',
  'runtimeIdentityUsage',
  'runtimeCanAssumeMigrator',
];
const stop = () => {
  throw Error('API_WORKER_MIGRATION_ROLE_PROOF_UNKNOWN');
};

export function validateMigrationRoleReadback(value, kind, target, runtimeRole) {
  exact(value, fields);
  if (
    value.schema !== 'PHUB_TIMEWEB_MIGRATION_ROLE_READBACK_V1' ||
    value.kind !== kind ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.wireRoleName ?? '') ||
    value.wireRoleName !== value.currentRoleName ||
    value.currentRoleName !== value.sessionRoleName ||
    value.roleOverride !== 'none' ||
    value.recovery !== false ||
    value.readOnly !== 'on' ||
    value.databaseName !== target.databaseName ||
    value.systemIdentifier !== target.systemIdentifier ||
    [
      'superuser',
      'createRole',
      'createDatabase',
      'replication',
      'bypassRls',
      'privilegedMembership',
      'canCreateDatabaseObjects',
    ].some((key) => value[key] !== false) ||
    value.wireRoleName.startsWith('pg_') ||
    value.delegableRoles !== 0 ||
    [
      'controllableBusinessSchemas',
      'controllableBusinessRelations',
      'dangerousBusinessRelationPrivileges',
    ].some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
    value.uuidExecute !== true ||
    value.publicUsage !== true ||
    value.profileUsage !== true ||
    value.identityUsage !== true
  )
    stop();
  if (kind === 'runtime') {
    if (
      value.publicCreate !== false ||
      [
        'controllableBusinessSchemas',
        'controllableBusinessRelations',
        'dangerousBusinessRelationPrivileges',
      ].some((key) => value[key] !== 0) ||
      value.profileCreate !== false ||
      value.identityCreate !== false ||
      value.runtimeRoleName !== null ||
      value.capabilities !== null ||
      !Array.isArray(value.defaultAcls) ||
      value.defaultAcls.length
    )
      stop();
  } else {
    exact(value.capabilities, capabilities);
    if (
      value.publicCreate !== true ||
      value.profileCreate !== true ||
      value.identityCreate !== true ||
      value.runtimeRoleName !== runtimeRole ||
      value.currentRoleName === runtimeRole ||
      capabilities.some(
        (key) =>
          value.capabilities[key] !==
          (key === 'globalNonOwnerTableDefaultGrants' ? 0 : key !== 'runtimeCanAssumeMigrator'),
      ) ||
      !Array.isArray(value.defaultAcls) ||
      value.defaultAcls.length !== 2
    )
      stop();
    for (const [i, schema] of ['identity', 'profile'].entries()) {
      const acl = value.defaultAcls[i];
      exact(acl, [
        'schema',
        'runtimeDmlCount',
        'unsafeRuntimeGrants',
        'publicGrants',
        'unexpectedGrantees',
      ]);
      if (
        acl.schema !== schema ||
        acl.runtimeDmlCount !== 4 ||
        acl.unsafeRuntimeGrants !== 0 ||
        acl.publicGrants !== 0 ||
        acl.unexpectedGrantees !== 0
      )
        stop();
    }
  }
  return value;
}
