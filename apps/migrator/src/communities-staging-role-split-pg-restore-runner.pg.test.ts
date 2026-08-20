/**
 * Opt-in PG16 failure matrix. This never runs in CI or ordinary developer
 * tests: an operator must explicitly supply disposable loopback *_verify
 * databases and set
 * PHUB_COMMUNITIES_MARKER_PG16_VERIFY=I_UNDERSTAND_PG16_VERIFY_IS_DISPOSABLE.
 *
 * It deliberately feeds pg_restore an invalid custom archive. That exercises
 * the real child-process failure path without mutating either supplied DB.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  runCommunitiesStagingRoleSplitPgRestore,
  type CommunitiesStagingRoleSplitPgRestorePreflightObservation,
} from './communities-staging-role-split-pg-restore-runner.js';

const confirmation = process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY;
const sourceUrl = process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_SOURCE_URL;
const cloneUrl = process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_CLONE_URL;
const pgRestorePath = process.env.PHUB_COMMUNITIES_MARKER_PG16_VERIFY_PG_RESTORE;

interface SafeUrl {
  readonly value: URL;
  readonly database: string;
}

function safeLoopbackVerifyUrl(value: string | undefined): SafeUrl | null {
  if (value === undefined) return null;
  try {
    const parsed = new URL(value);
    const database = parsed.pathname.replace(/^\//, '');
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
      !['127.0.0.1', '::1'].includes(parsed.hostname) ||
      parsed.search.length !== 0 ||
      parsed.hash.length !== 0 ||
      !/^[a-z_][a-z0-9_]{0,62}_verify$/.test(database) ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(decodeURIComponent(parsed.username)) ||
      parsed.password.length === 0
    )
      return null;
    return { value: parsed, database };
  } catch {
    return null;
  }
}

describe('PG16 marker host opt-in URL guard', () => {
  it.each([
    'postgresql://role:password@127.0.0.1/source_verify?host=nonloopback.example',
    'postgresql://role:password@127.0.0.1/source_verify#redirect',
    'postgresql://role:password@nonloopback.example/source_verify',
    'postgresql://role:password@localhost/source_verify',
    'postgresql://role:password@127.0.0.1/source',
  ])('rejects a URL with an alternate connection route: %s', (value) => {
    expect(safeLoopbackVerifyUrl(value)).toBeNull();
  });

  it('accepts only a plain loopback disposable URL', () => {
    expect(
      safeLoopbackVerifyUrl('postgresql://role:password@127.0.0.1:5432/source_verify'),
    ).toMatchObject({ database: 'source_verify' });
  });
});

const source = safeLoopbackVerifyUrl(sourceUrl);
const clone = safeLoopbackVerifyUrl(cloneUrl);
const canRun =
  confirmation === 'I_UNDERSTAND_PG16_VERIFY_IS_DISPOSABLE' &&
  process.platform === 'linux' &&
  source !== null &&
  clone !== null &&
  source.database !== clone.database &&
  pgRestorePath !== undefined &&
  /^\/[A-Za-z0-9._/-]+$/.test(pgRestorePath);

async function withClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error('preflight aborted');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  const onAbort = () => void client.end().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
    signal?.removeEventListener('abort', onAbort);
  }
}

describe.skipIf(!canRun)('PG16 marker host restore failure matrix', () => {
  it('rejects target identity mismatches before spawn and leaves the source reachable after a real pg_restore failure', async () => {
    if (source === null || clone === null || pgRestorePath === undefined)
      throw new Error('fixture absent');
    const cloneIdentity = await withClient(clone.value.toString(), async (client) => {
      const result = await client.query<{
        database: string;
        oid: string;
        system_identifier: string;
        major: string;
        session_user: string;
        session_user_oid: string;
        current_user: string;
        current_user_oid: string;
      }>(
        "SELECT current_database() AS database, d.oid::text AS oid, control.system_identifier::text AS system_identifier, split_part(current_setting('server_version'), '.', 1) AS major, session_user::text AS session_user, session_user::regrole::oid::text AS session_user_oid, current_user::text AS current_user, current_user::regrole::oid::text AS current_user_oid FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() control WHERE d.datname = current_database()",
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    });
    expect(cloneIdentity.database).toBe(clone.database);
    expect(cloneIdentity.major).toBe('16');
    const beforeSource = await withClient(source.value.toString(), (client) =>
      client.query<{ database: string }>('SELECT current_database() AS database'),
    );
    expect(beforeSource.rows[0]?.database).toBe(source.database);

    const directory = await mkdtemp(join(tmpdir(), 'phub-marker-pg16-verify-'));
    const archivePath = join(directory, 'intentionally-invalid.dump');
    const pgpassPath = join(directory, 'pgpass');
    const host = clone.value.hostname;
    const port = clone.value.port || '5432';
    const login = decodeURIComponent(clone.value.username);
    const password = decodeURIComponent(clone.value.password);
    await writeFile(archivePath, 'this is intentionally not a PostgreSQL custom archive\n', {
      mode: 0o600,
    });
    await writeFile(pgpassPath, `${host}:${port}:${clone.database}:${login}:${password}\n`, {
      mode: 0o600,
    });
    await Promise.all([chmod(archivePath, 0o600), chmod(pgpassPath, 0o600)]);
    const archiveFile = await open(archivePath, 'r');
    const passwordFile = await open(pgpassPath, 'r');
    const executableFile = await open(pgRestorePath, 'r');
    const expectedPgRestoreSha256 = createHash('sha256')
      .update(await readFile(pgRestorePath))
      .digest('hex');
    const preflight = async (
      _target: unknown,
      signal: AbortSignal,
    ): Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation> =>
      await withClient(
        clone.value.toString(),
        async (client) => {
          const result = await client.query<{
            database: string;
            oid: string;
            system_identifier: string;
            major: string;
            session_user: string;
            session_user_oid: string;
            current_user: string;
            current_user_oid: string;
          }>(
            "SELECT current_database() AS database, d.oid::text AS oid, control.system_identifier::text AS system_identifier, split_part(current_setting('server_version'), '.', 1) AS major, session_user::text AS session_user, session_user::regrole::oid::text AS session_user_oid, current_user::text AS current_user, current_user::regrole::oid::text AS current_user_oid FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() control WHERE d.datname = current_database()",
          );
          if (result.rows.length !== 1) throw new Error('clone preflight unavailable');
          const row = result.rows[0]!;
          return {
            database: row.database,
            databaseOid: row.oid,
            systemIdentifier: row.system_identifier,
            postgresMajor: row.major,
            sessionUser: row.session_user,
            sessionUserOid: row.session_user_oid,
            currentUser: row.current_user,
            currentUserOid: row.current_user_oid,
          };
        },
        signal,
      );
    const runnerConfig = (databaseOid: string) => ({
      target: {
        database: clone.database,
        databaseOid,
        sourceDatabase: source.database,
        systemIdentifier: cloneIdentity.system_identifier,
        postgresMajor: '16' as const,
        connectionUser: login,
        connectionUserOid: cloneIdentity.session_user_oid,
        restoreRole: cloneIdentity.current_user,
        restoreRoleOid: cloneIdentity.current_user_oid,
        host,
        port,
        sslMode: 'disable' as const,
      },
      timeoutMs: 30_000,
      expectedPgRestoreSha256,
      preflight,
    });
    try {
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(runnerConfig(`${Number(cloneIdentity.oid) + 1}`), {
          archiveFile,
          passwordFile,
          executableFile,
        }),
      ).rejects.toMatchObject({ code: 'TARGET_BINDING_INVALID' });
      await expect(
        runCommunitiesStagingRoleSplitPgRestore(runnerConfig(cloneIdentity.oid), {
          archiveFile,
          passwordFile,
          executableFile,
        }),
      ).rejects.toMatchObject({ code: 'NONZERO_EXIT' });
    } finally {
      await archiveFile.close();
      await passwordFile.close();
      await executableFile.close();
      await unlink(archivePath).catch(() => undefined);
      await unlink(pgpassPath).catch(() => undefined);
    }
    const afterSource = await withClient(source.value.toString(), (client) =>
      client.query<{ database: string }>('SELECT current_database() AS database'),
    );
    expect(afterSource.rows[0]?.database).toBe(source.database);
  });
});
