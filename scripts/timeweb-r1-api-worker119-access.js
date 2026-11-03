// Source-owned read-only privilege probe through the application's actual connection.
// Credentials remain inside the pinned application container and errors are redacted.
import {
  r1RuntimePrivilegeQuery,
  r1RuntimePrivilegeRequirements,
  assessR1RuntimePrivileges,
} from './r1-runtime-privilege-audit.js';
export function r1RuntimeAccessProbe(component, postgresAddresses) {
  const query = r1RuntimePrivilegeQuery(component);
  if (
    !Array.isArray(postgresAddresses) ||
    !postgresAddresses.length ||
    postgresAddresses.some((v) => typeof v !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(v))
  )
    throw Error('R1_RUNTIME_ACCESS_TARGET');
  return `const {Client}=require('pg');const dns=require('node:dns').promises;
(async()=>{let client;try {
const u=new URL(process.env.DATABASE_URL);
if(u.username!=='phub_runtime'||u.hostname!=='postgres'||u.pathname!=='/phub_beta'||u.search||u.hash||(u.port!==''&&u.port!=='5432'))throw Error();
const a=await dns.lookup(u.hostname);if(!${JSON.stringify(postgresAddresses)}.includes(a.address))throw Error();
u.hostname=a.address;
client=new Client({connectionString:u.toString(),connectionTimeoutMillis:5000,application_name:'r1_runtime_privilege_readonly',options:'-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000'});
await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const r=await client.query(${JSON.stringify(query)});if(r.rows.length!==1)throw Error();
await client.query('ROLLBACK');await client.end();process.stdout.write(JSON.stringify(r.rows[0].capture));
}catch{if(client)await client.end().catch(()=>{});process.stderr.write('R1_RUNTIME_ACCESS_FAILED');process.exitCode=1;}})();`;
}
export function validateR1RuntimeAccess(capture, component, beforeGrants = false) {
  const result = assessR1RuntimePrivileges(capture, {
    component,
    databaseName: 'phub_beta',
    roleName: 'phub_runtime',
  });
  const newRelations = new Set(
    r1RuntimePrivilegeRequirements(component)
      .filter((r) => r.tenantTable)
      .map((r) => r.relation),
  );
  if (
    result.issues.some(
      (issue) =>
        !beforeGrants ||
        !newRelations.has(issue.relation) ||
        ![
          'PRIVILEGE_MISSING',
          'COLUMN_UPDATE_MISSING',
          'ROW_LOCK_UPDATE_MISSING',
          'SUBJECT_COMMAND_WRITE_SCOPE_TOO_BROAD',
        ].includes(issue.code),
    )
  )
    throw Error('R1_RUNTIME_ACCESS_UNSATISFIED');
  return result;
}
