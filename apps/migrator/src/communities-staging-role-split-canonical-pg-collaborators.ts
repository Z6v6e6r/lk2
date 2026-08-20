import { randomBytes } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_PREFIX,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { Client } from 'pg';

import type { CommunitiesStagingRoleSplitCanonicalMarkerWriter } from './communities-staging-role-split-canonical-host-adapter.js';
import type {
  CommunitiesStagingRoleSplitPgRestorePreflightObservation,
  CommunitiesStagingRoleSplitPgRestoreTarget,
} from './communities-staging-role-split-pg-restore-runner.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-runner-adapter.js';

const ADVISORY_KEY_1 = 1_836_020_338;
const ADVISORY_KEY_2 = 1_936_876_912;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const oidPattern = /^[1-9][0-9]*$/u;
const markerPattern = new RegExp(
  `^${COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_PREFIX}[a-f0-9]{64}$`,
  'u',
);

export interface CommunitiesStagingRoleSplitCanonicalPgSession {
  query<T extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  close(): Promise<void>;
}

export type CommunitiesStagingRoleSplitCanonicalPgSessionFactory = (
  signal: AbortSignal,
) => Promise<CommunitiesStagingRoleSplitCanonicalPgSession>;

export class CommunitiesStagingRoleSplitCanonicalPgCollaboratorError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_INVALID'
      | 'CONNECTION_UNAVAILABLE'
      | 'CONNECTION_BINDING_INVALID'
      | 'FENCE_UNAVAILABLE'
      | 'FENCE_LOST'
      | 'FENCE_RELEASE_FAILED'
      | 'MARKER_BINDING_INVALID'
      | 'MARKER_OUTCOME_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_CANONICAL_PG_${code}`);
    this.name = 'CommunitiesStagingRoleSplitCanonicalPgCollaboratorError';
  }
}

function fail(code: CommunitiesStagingRoleSplitCanonicalPgCollaboratorError['code']): never {
  throw new CommunitiesStagingRoleSplitCanonicalPgCollaboratorError(code);
}

function validSubject(value: string): boolean {
  return sha256Pattern.test(value);
}

type CloneConnectionBinding = Pick<
  CommunitiesStagingRoleSplitPgRestoreTarget,
  'database' | 'host' | 'port' | 'connectionUser' | 'sslMode'
>;

function assertCloneConnectionString(
  connectionString: string,
  expected: CloneConnectionBinding,
): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail('CONFIG_INVALID');
  }
  const hostname = parsed.hostname === '[::1]' ? '::1' : parsed.hostname;
  let database: string;
  let username: string;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    username = decodeURIComponent(parsed.username);
  } catch {
    fail('CONFIG_INVALID');
  }
  const parameters = [...parsed.searchParams.entries()];
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hash !== '' ||
    !['127.0.0.1', '::1'].includes(hostname) ||
    hostname !== expected.host ||
    (parsed.port || '5432') !== expected.port ||
    parsed.pathname.split('/').length !== 2 ||
    database !== expected.database ||
    username !== expected.connectionUser ||
    parsed.password.length < 1 ||
    expected.sslMode !== 'disable' ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== 'sslmode' ||
    parameters[0]?.[1] !== 'disable'
  )
    fail('CONFIG_INVALID');
}

export class CommunitiesStagingRoleSplitCloneOnlyConnectionFactory {
  constructor(
    readonly subjectSha256: string,
    private readonly connectionString: string,
    readonly binding: CloneConnectionBinding,
    private readonly connectionTimeoutMs: number,
    private readonly queryTimeoutMs: number,
  ) {
    if (
      !validSubject(subjectSha256) ||
      !Number.isSafeInteger(connectionTimeoutMs) ||
      connectionTimeoutMs < 1 ||
      connectionTimeoutMs > 60_000 ||
      !Number.isSafeInteger(queryTimeoutMs) ||
      queryTimeoutMs < 1 ||
      queryTimeoutMs > 60_000
    )
      fail('CONFIG_INVALID');
    assertCloneConnectionString(connectionString, binding);
  }

  private async openSession(
    signal: AbortSignal,
    abortWhileOpen: boolean,
  ): Promise<CommunitiesStagingRoleSplitCanonicalPgSession> {
    if (signal.aborted) fail('CONNECTION_UNAVAILABLE');
    const client = new Client({
      connectionString: this.connectionString,
      application_name: 'phub-communities-role-split-canonical-host-v1',
      connectionTimeoutMillis: this.connectionTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
    });
    const abort = () => {
      void client.end().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
    } catch {
      signal.removeEventListener('abort', abort);
      await client.end().catch(() => undefined);
      fail('CONNECTION_UNAVAILABLE');
    }
    if (!abortWhileOpen) signal.removeEventListener('abort', abort);
    let closed = false;
    return {
      query: async <T extends object>(sql: string, values?: readonly unknown[]) => {
        if (closed || (abortWhileOpen && signal.aborted)) fail('CONNECTION_UNAVAILABLE');
        try {
          const result = await client.query(sql, values as unknown[] | undefined);
          return { rows: result.rows as unknown as readonly T[] };
        } catch {
          fail('CONNECTION_UNAVAILABLE');
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (abortWhileOpen) signal.removeEventListener('abort', abort);
        try {
          await client.end();
        } catch {
          fail('CONNECTION_UNAVAILABLE');
        }
      },
    };
  }

  /** Session whose signal remains active until close; use for bounded queries and marker writes. */
  openBoundedSession(signal: AbortSignal): Promise<CommunitiesStagingRoleSplitCanonicalPgSession> {
    return this.openSession(signal, true);
  }

  /**
   * Long-lived advisory-lock session. The signal bounds connection acquisition only; the fence
   * owner must assert and explicitly release the returned backend.
   */
  openFenceSession(signal: AbortSignal): Promise<CommunitiesStagingRoleSplitCanonicalPgSession> {
    return this.openSession(signal, false);
  }

  async preflight(
    target: CommunitiesStagingRoleSplitPgRestoreTarget,
    signal: AbortSignal,
  ): Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation> {
    if (
      target.database !== this.binding.database ||
      target.host !== this.binding.host ||
      target.port !== this.binding.port ||
      target.connectionUser !== this.binding.connectionUser ||
      target.sslMode !== this.binding.sslMode ||
      target.database === target.sourceDatabase
    )
      fail('CONNECTION_BINDING_INVALID');
    const session = await this.openBoundedSession(signal);
    try {
      const result = await session.query<CommunitiesStagingRoleSplitPgRestorePreflightObservation>(
        `select current_database() as database,
                d.oid::text as "databaseOid",
                (pg_control_system()).system_identifier::text as "systemIdentifier",
                (current_setting('server_version_num')::integer / 10000)::text as "postgresMajor",
                session_user as "sessionUser",
                (select oid::text from pg_catalog.pg_roles where rolname = session_user) as "sessionUserOid",
                current_user as "currentUser",
                (select oid::text from pg_catalog.pg_roles where rolname = current_user) as "currentUserOid"
         from pg_catalog.pg_database d
         where d.datname = current_database()`,
      );
      if (result.rows.length !== 1) fail('CONNECTION_BINDING_INVALID');
      return result.rows[0]!;
    } finally {
      await session.close();
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) fail('MARKER_BINDING_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  if (!markerPattern.test(value)) fail('MARKER_BINDING_INVALID');
  return `'${value.replaceAll("'", "''")}'`;
}

function assertLeaseShape(lease: CommunitiesStagingRoleSplitDdlFenceLease): void {
  if (
    !sha256Pattern.test(lease.requestSha256) ||
    !/^[0-9]{10,32}$/u.test(lease.systemIdentifier) ||
    !oidPattern.test(lease.backendPid) ||
    !sha256Pattern.test(lease.fencingToken) ||
    lease.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY
  )
    fail('FENCE_LOST');
}

type FenceEntry = {
  readonly session: CommunitiesStagingRoleSplitCanonicalPgSession;
  readonly backendPid: string;
};

export class CommunitiesStagingRoleSplitPgDdlFence implements CommunitiesStagingRoleSplitDdlFence {
  private readonly entries = new Map<string, FenceEntry>();

  constructor(
    readonly subjectSha256: string,
    private readonly createSession: CommunitiesStagingRoleSplitCanonicalPgSessionFactory,
  ) {
    if (!validSubject(subjectSha256)) fail('CONFIG_INVALID');
  }

  async acquire(input: {
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<CommunitiesStagingRoleSplitDdlFenceLease> {
    if (
      !sha256Pattern.test(input.requestSha256) ||
      !/^[0-9]{10,32}$/u.test(input.systemIdentifier) ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 60_000 ||
      input.signal.aborted
    )
      fail('FENCE_UNAVAILABLE');
    let session: CommunitiesStagingRoleSplitCanonicalPgSession | null = null;
    try {
      session = await this.createSession(input.signal);
      const result = await session.query<{
        readonly acquired: boolean;
        readonly backend_pid: string;
        readonly system_identifier: string;
      }>(
        `select pg_try_advisory_lock($1::integer, $2::integer) as acquired,
                pg_backend_pid()::text as backend_pid,
                (pg_control_system()).system_identifier::text as system_identifier`,
        [ADVISORY_KEY_1, ADVISORY_KEY_2],
      );
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        row?.acquired !== true ||
        !oidPattern.test(row.backend_pid) ||
        row.system_identifier !== input.systemIdentifier
      )
        fail('FENCE_UNAVAILABLE');
      const fencingToken = randomBytes(32).toString('hex');
      const lease = {
        requestSha256: input.requestSha256,
        systemIdentifier: input.systemIdentifier,
        backendPid: row.backend_pid,
        fencingToken,
        advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
      } as const;
      this.entries.set(fencingToken, { session, backendPid: row.backend_pid });
      session = null;
      return lease;
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitCanonicalPgCollaboratorError) throw error;
      return fail('FENCE_UNAVAILABLE');
    } finally {
      if (session !== null) await session.close().catch(() => undefined);
    }
  }

  async assertHeld(lease: CommunitiesStagingRoleSplitDdlFenceLease): Promise<void> {
    assertLeaseShape(lease);
    const entry = this.entries.get(lease.fencingToken);
    if (entry === undefined || entry.backendPid !== lease.backendPid) fail('FENCE_LOST');
    try {
      const result = await entry.session.query<{
        readonly backend_pid: string;
        readonly held: boolean;
      }>(
        `select pg_backend_pid()::text as backend_pid,
                exists (
                  select 1
                  from pg_catalog.pg_locks
                  where locktype = 'advisory'
                    and pid = pg_backend_pid()
                    and classid = $1::oid
                    and objid = $2::oid
                    and objsubid = 2
                    and granted
                ) as held`,
        [ADVISORY_KEY_1, ADVISORY_KEY_2],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row?.backend_pid !== lease.backendPid || row.held !== true)
        fail('FENCE_LOST');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitCanonicalPgCollaboratorError) throw error;
      fail('FENCE_LOST');
    }
  }

  async release(lease: CommunitiesStagingRoleSplitDdlFenceLease): Promise<void> {
    assertLeaseShape(lease);
    const entry = this.entries.get(lease.fencingToken);
    if (entry === undefined || entry.backendPid !== lease.backendPid) fail('FENCE_RELEASE_FAILED');
    this.entries.delete(lease.fencingToken);
    let released: boolean;
    try {
      const result = await entry.session.query<{ readonly released: boolean }>(
        'select pg_advisory_unlock($1::integer, $2::integer) as released',
        [ADVISORY_KEY_1, ADVISORY_KEY_2],
      );
      released = result.rows.length === 1 && result.rows[0]?.released === true;
    } catch {
      released = false;
    }
    try {
      await entry.session.close();
    } catch {
      released = false;
    }
    if (!released) fail('FENCE_RELEASE_FAILED');
  }
}

export class CommunitiesStagingRoleSplitPgMarkerWriter implements CommunitiesStagingRoleSplitCanonicalMarkerWriter {
  get connectionFactorySubjectSha256(): string {
    return this.connectionFactory.subjectSha256;
  }

  constructor(
    readonly subjectSha256: string,
    private readonly connectionFactory: CommunitiesStagingRoleSplitCloneOnlyConnectionFactory,
    private readonly timeoutMs: number,
  ) {
    if (
      !validSubject(subjectSha256) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    )
      fail('CONFIG_INVALID');
  }

  async write(input: {
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
    readonly cloneDatabaseOid: string;
    readonly marker: string;
  }): Promise<void> {
    try {
      assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    } catch {
      fail('MARKER_BINDING_INVALID');
    }
    if (!oidPattern.test(input.cloneDatabaseOid) || !markerPattern.test(input.marker))
      fail('MARKER_BINDING_INVALID');
    const factoryBinding = this.connectionFactory.binding;
    if (
      !validSubject(this.connectionFactory.subjectSha256) ||
      factoryBinding.database !== input.request.restoreDatabase ||
      factoryBinding.connectionUser !== input.request.expectedCloneDatabaseOwner ||
      (factoryBinding.host !== '127.0.0.1' && factoryBinding.host !== '::1') ||
      factoryBinding.sslMode !== 'disable'
    )
      fail('MARKER_BINDING_INVALID');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let session: CommunitiesStagingRoleSplitCanonicalPgSession | null = null;
    let transaction = false;
    try {
      session = await this.connectionFactory.openBoundedSession(controller.signal);
      await session.query('begin');
      transaction = true;
      await session.query("set local lock_timeout = '5s'");
      await session.query("set local statement_timeout = '30s'");
      const identity = await session.query<{
        readonly database: string;
        readonly session_user: string;
        readonly session_user_oid: string;
        readonly current_user: string;
        readonly current_user_oid: string;
        readonly system_identifier: string;
      }>(
        `select current_database() as database,
                session_user as session_user,
                (select oid::text from pg_catalog.pg_roles where rolname = session_user) as session_user_oid,
                current_user as current_user,
                (select oid::text from pg_catalog.pg_roles where rolname = current_user) as current_user_oid,
                (pg_control_system()).system_identifier::text as system_identifier`,
      );
      const identityRow = identity.rows[0];
      if (
        identity.rows.length !== 1 ||
        identityRow?.database !== input.request.restoreDatabase ||
        identityRow.session_user !== input.request.expectedCloneDatabaseOwner ||
        identityRow.session_user_oid !== input.request.expectedCloneDatabaseOwnerOid ||
        identityRow.current_user !== input.request.expectedCloneDatabaseOwner ||
        identityRow.current_user_oid !== input.request.expectedCloneDatabaseOwnerOid ||
        identityRow.system_identifier !== input.request.systemIdentifier
      )
        fail('MARKER_BINDING_INVALID');
      await session.query('lock table pg_catalog.pg_database in access exclusive mode');
      const before = await session.query<{
        readonly oid: string;
        readonly owner: string;
        readonly owner_oid: string;
        readonly system_identifier: string;
      }>(
        `select d.oid::text as oid,
                pg_get_userbyid(d.datdba) as owner,
                d.datdba::text as owner_oid,
                (pg_control_system()).system_identifier::text as system_identifier
         from pg_catalog.pg_database d
         where d.datname = $1`,
        [input.request.restoreDatabase],
      );
      const row = before.rows[0];
      if (
        before.rows.length !== 1 ||
        row?.oid !== input.cloneDatabaseOid ||
        row.owner !== input.request.expectedCloneDatabaseOwner ||
        row.owner_oid !== input.request.expectedCloneDatabaseOwnerOid ||
        row.system_identifier !== input.request.systemIdentifier
      )
        fail('MARKER_BINDING_INVALID');
      await session.query(
        `comment on database ${quoteIdentifier(input.request.restoreDatabase)} is ${quoteLiteral(input.marker)}`,
      );
      const after = await session.query<{ readonly marker: string | null }>(
        `select pg_catalog.shobj_description(d.oid, 'pg_database') as marker
         from pg_catalog.pg_database d
         where d.oid = $1::oid and d.datname = $2`,
        [input.cloneDatabaseOid, input.request.restoreDatabase],
      );
      if (after.rows.length !== 1 || after.rows[0]?.marker !== input.marker)
        fail('MARKER_OUTCOME_AMBIGUOUS');
      await session.query('commit');
      transaction = false;
    } catch (error) {
      if (transaction && session !== null) await session.query('rollback').catch(() => undefined);
      if (error instanceof CommunitiesStagingRoleSplitCanonicalPgCollaboratorError) throw error;
      fail('MARKER_OUTCOME_AMBIGUOUS');
    } finally {
      clearTimeout(timer);
      if (session !== null) await session.close().catch(() => undefined);
    }
  }
}
