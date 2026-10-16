import type { Pool } from 'pg';
import { createDatabasePool } from './connection.js';
import {
  assertSupportTicketAclBoundary,
  inspectSupportTicketAclBoundary,
} from './support-ticket-acl.js';
import {
  assertSupportRuntimePrerequisites,
  inspectSupportRuntimePrerequisites,
  assertSupportRuntimePrivilegeInventory,
  inspectSupportRuntimePrivilegeInventory,
  SUPPORT_DATABASE_OWNER_ROLE,
  assertSupportOwnerObjectBoundary,
} from './support-ticket-prerequisites.js';
/** Separate role over the same canonical database. No fallback to legacy privileged credentials. */
export function assertSupportDatabaseConnection(
  main: string,
  support: string,
): { runtimeRoleName: string; databaseName: string } {
  let legacy: URL, isolated: URL;
  try {
    legacy = new URL(main);
    isolated = new URL(support);
  } catch {
    throw new Error('SUPPORT_DATABASE_TARGET_INVALID');
  }
  const target = (value: URL) =>
    `${value.protocol}//${value.hostname}:${value.port || '5432'}${value.pathname}`;
  if (
    !['postgres:', 'postgresql:'].includes(isolated.protocol) ||
    !['postgres:', 'postgresql:'].includes(legacy.protocol) ||
    target(legacy) !== target(isolated) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(decodeURIComponent(isolated.username)) ||
    !isolated.password ||
    decodeURIComponent(isolated.username) === decodeURIComponent(legacy.username) ||
    isolated.search ||
    isolated.hash ||
    legacy.search ||
    legacy.hash
  )
    throw new Error('SUPPORT_DATABASE_TARGET_INVALID');
  return {
    runtimeRoleName: decodeURIComponent(isolated.username),
    databaseName: decodeURIComponent(isolated.pathname.slice(1)),
  };
}
export async function openSupportTicketRuntimePool(
  mainConnectionString: string,
  supportConnectionString: string | undefined,
  createPool: (url: string) => Pool = (url) => createDatabasePool(url, { max: 3 }),
): Promise<Pool | undefined> {
  if (supportConnectionString === undefined) return undefined;
  const expected = assertSupportDatabaseConnection(mainConnectionString, supportConnectionString);
  const pool = createPool(supportConnectionString);
  // pg removes failed idle clients; handle the event without logging connection/SQL details.
  pool.on('error', () => undefined);
  try {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      open = true;
      await client.query("set local statement_timeout = '5s'");
      await client.query("set local lock_timeout = '2s'");
      const identity = (
        await client.query<{
          roleName: string;
          sessionRole: string;
          databaseName: string;
          owner: string;
          membershipCount: number;
          recovery: boolean;
          ownerUnsafe: boolean;
          ownerMemberships: number;
        }>(
          `select current_user as "roleName",session_user as "sessionRole",current_database() as "databaseName",
         pg_get_userbyid(n.nspowner) as owner,pg_is_in_recovery() as recovery,
         (select count(*)::integer from pg_auth_members where member=o.oid or roleid=o.oid) as "ownerMemberships",
         (o.rolcanlogin or o.rolsuper or o.rolbypassrls or o.rolcreaterole or o.rolcreatedb or o.rolreplication) as "ownerUnsafe",
         (select count(*)::integer from pg_auth_members where member=current_user::regrole or roleid=current_user::regrole) as "membershipCount"
         from pg_namespace n join pg_roles o on o.oid=n.nspowner where n.nspname='support'`,
        )
      ).rows[0];
      if (
        !identity ||
        identity.roleName !== expected.runtimeRoleName ||
        identity.sessionRole !== expected.runtimeRoleName ||
        identity.databaseName !== expected.databaseName ||
        identity.owner !== SUPPORT_DATABASE_OWNER_ROLE ||
        identity.ownerUnsafe ||
        identity.ownerMemberships !== 0 ||
        identity.membershipCount !== 0 ||
        identity.recovery
      )
        throw new Error('SUPPORT_RUNTIME_IDENTITY_INVALID');
      assertSupportTicketAclBoundary(
        await inspectSupportTicketAclBoundary(client, expected.runtimeRoleName, identity.owner),
        {
          runtimeRoleName: expected.runtimeRoleName,
          migratorRoleName: identity.owner,
        },
      );
      assertSupportRuntimePrerequisites(
        await inspectSupportRuntimePrerequisites(client, expected.runtimeRoleName),
      );
      assertSupportRuntimePrivilegeInventory(
        await inspectSupportRuntimePrivilegeInventory(client, expected.runtimeRoleName),
      );
      await assertSupportOwnerObjectBoundary(client, SUPPORT_DATABASE_OWNER_ROLE, 'post');
      await client.query('commit');
      open = false;
    } finally {
      if (open) await client.query('rollback').catch(() => undefined);
      client.release();
    }
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    // Startup failure is deliberately body/DSN-free. Configured but unsafe never becomes disabled.
    throw new Error('SUPPORT_RUNTIME_BOUNDARY_INVALID');
  }
}
