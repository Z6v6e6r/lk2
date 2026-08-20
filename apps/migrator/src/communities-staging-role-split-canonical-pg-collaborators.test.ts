/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  communitiesStagingRoleSplitLedgerSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  CommunitiesStagingRoleSplitPgDdlFence,
  CommunitiesStagingRoleSplitPgMarkerWriter,
  CommunitiesStagingRoleSplitCloneOnlyConnectionFactory,
  type CommunitiesStagingRoleSplitCanonicalPgSession,
} from './communities-staging-role-split-canonical-pg-collaborators.js';
import { COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY } from './communities-staging-role-split-ddl-fence.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_restore',
  expectedCloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16386',
  systemIdentifier: '7421000000000000000',
  backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
  backupSha256: sha('archive'),
  backupBytes: '7',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: sha('backup evidence'),
  archiveTocSha256: sha('toc'),
  sourceLedgerSha256: communitiesStagingRoleSplitLedgerSha256([
    { filename: '0001_initial.sql', checksum: 'a'.repeat(64) },
  ]),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('restore helper'),
  markerWriterSha256: sha('marker writer'),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const marker = `phub-communities-role-split-clone-v2:${sha('payload')}`;

function sessionFixture(responses: readonly (readonly Record<string, unknown>[])[]) {
  const statements: string[] = [];
  let index = 0;
  const session = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/gu, ' ').trim());
      return { rows: responses[index++] ?? [] };
    }),
    close: vi.fn(async () => undefined),
  } as unknown as CommunitiesStagingRoleSplitCanonicalPgSession;
  return { session, statements };
}

function cloneOnlyFactory(session: CommunitiesStagingRoleSplitCanonicalPgSession) {
  const factory = new CommunitiesStagingRoleSplitCloneOnlyConnectionFactory(
    sha('factory'),
    `postgresql://${request.expectedCloneDatabaseOwner}:private@127.0.0.1:5432/${request.restoreDatabase}?sslmode=disable`,
    {
      database: request.restoreDatabase,
      host: '127.0.0.1',
      port: '5432',
      connectionUser: request.expectedCloneDatabaseOwner,
      sslMode: 'disable',
    },
    10_000,
    30_000,
  );
  vi.spyOn(factory, 'openBoundedSession').mockResolvedValue(session);
  return factory;
}

const markerIdentity = {
  database: request.restoreDatabase,
  session_user: request.expectedCloneDatabaseOwner,
  session_user_oid: request.expectedCloneDatabaseOwnerOid,
  current_user: request.expectedCloneDatabaseOwner,
  current_user_oid: request.expectedCloneDatabaseOwnerOid,
  system_identifier: request.systemIdentifier,
};

describe('CommunitiesStagingRoleSplitPgDdlFence', () => {
  it('owns one dedicated backend and proves the exact advisory lock before release', async () => {
    const current = sessionFixture([
      [{ acquired: true, backend_pid: '4242', system_identifier: request.systemIdentifier }],
      [{ backend_pid: '4242', held: true }],
      [{ released: true }],
    ]);
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(
      sha('fence'),
      async () => current.session,
    );
    const lease = await fence.acquire({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(lease).toMatchObject({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      backendPid: '4242',
      advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
    });
    await expect(fence.assertHeld(lease)).resolves.toBeUndefined();
    await expect(fence.release(lease)).resolves.toBeUndefined();
    expect(current.session.close).toHaveBeenCalledOnce();
  });

  it('rejects a busy fence and closes the unretained session', async () => {
    const current = sessionFixture([
      [{ acquired: false, backend_pid: '4242', system_identifier: request.systemIdentifier }],
    ]);
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(
      sha('fence'),
      async () => current.session,
    );
    await expect(
      fence.acquire({
        requestSha256: sha('request'),
        systemIdentifier: request.systemIdentifier,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'FENCE_UNAVAILABLE' });
    expect(current.session.close).toHaveBeenCalledOnce();
  });

  it('treats a successful close as conclusive even when advisory unlock reports false', async () => {
    const current = sessionFixture([
      [{ acquired: true, backend_pid: '4242', system_identifier: request.systemIdentifier }],
      [{ released: false }],
    ]);
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(
      sha('fence'),
      async () => current.session,
    );
    const lease = await fence.acquire({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    await expect(fence.release(lease)).resolves.toBeUndefined();
    await expect(fence.release(lease)).rejects.toMatchObject({ code: 'FENCE_RELEASE_FAILED' });
    expect(current.session.close).toHaveBeenCalledOnce();
  });

  it('treats a successful close as conclusive when the advisory unlock query errors', async () => {
    let queryCalls = 0;
    const session = {
      query: vi.fn(async () => {
        queryCalls += 1;
        if (queryCalls === 1)
          return {
            rows: [
              { acquired: true, backend_pid: '4242', system_identifier: request.systemIdentifier },
            ],
          };
        throw new Error('unlock response lost');
      }),
      close: vi.fn(async () => undefined),
    } as unknown as CommunitiesStagingRoleSplitCanonicalPgSession;
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(sha('fence'), async () => session);
    const lease = await fence.acquire({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    await expect(fence.release(lease)).resolves.toBeUndefined();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('retries both unlock and close only when neither outcome was confirmed', async () => {
    let queryCalls = 0;
    const close = vi
      .fn<CommunitiesStagingRoleSplitCanonicalPgSession['close']>()
      .mockRejectedValueOnce(new Error('close lost'))
      .mockResolvedValueOnce(undefined);
    const session = {
      query: vi.fn(async () => {
        queryCalls += 1;
        if (queryCalls === 1)
          return {
            rows: [
              { acquired: true, backend_pid: '4242', system_identifier: request.systemIdentifier },
            ],
          };
        if (queryCalls === 2) throw new Error('unlock response lost');
        return { rows: [{ released: true }] };
      }),
      close,
    } as unknown as CommunitiesStagingRoleSplitCanonicalPgSession;
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(sha('fence'), async () => session);
    const lease = await fence.acquire({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    await expect(fence.release(lease)).rejects.toMatchObject({ code: 'FENCE_RELEASE_FAILED' });
    await expect(fence.release(lease)).resolves.toBeUndefined();
    expect(queryCalls).toBe(3);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('retains an unlock-confirmed entry after close failure and retries close without re-unlocking', async () => {
    const current = sessionFixture([
      [{ acquired: true, backend_pid: '4242', system_identifier: request.systemIdentifier }],
      [{ released: true }],
    ]);
    const close = current.session.close as ReturnType<typeof vi.fn>;
    close.mockRejectedValueOnce(new Error('close lost')).mockResolvedValueOnce(undefined);
    const fence = new CommunitiesStagingRoleSplitPgDdlFence(
      sha('fence'),
      async () => current.session,
    );
    const lease = await fence.acquire({
      requestSha256: sha('request'),
      systemIdentifier: request.systemIdentifier,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    await expect(fence.release(lease)).rejects.toMatchObject({ code: 'FENCE_RELEASE_FAILED' });
    await expect(fence.release(lease)).resolves.toBeUndefined();
    expect(
      current.statements.filter((statement) => statement.includes('pg_advisory_unlock')),
    ).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('CommunitiesStagingRoleSplitCloneOnlyConnectionFactory', () => {
  it('accepts only the exact loopback clone URL and dedicated restore login', () => {
    expect(
      () =>
        new CommunitiesStagingRoleSplitCloneOnlyConnectionFactory(
          sha('factory'),
          'postgresql://phub_restore:private@127.0.0.1:5432/phub_restore_123_4?sslmode=disable',
          {
            database: request.restoreDatabase,
            host: '127.0.0.1',
            port: '5432',
            connectionUser: request.expectedCloneDatabaseOwner,
            sslMode: 'disable',
          },
          10_000,
          30_000,
        ),
    ).not.toThrow();
    expect(
      () =>
        new CommunitiesStagingRoleSplitCloneOnlyConnectionFactory(
          sha('factory'),
          'postgresql://phub_restore:private@127.0.0.1:5432/phub_staging?sslmode=disable',
          {
            database: request.restoreDatabase,
            host: '127.0.0.1',
            port: '5432',
            connectionUser: request.expectedCloneDatabaseOwner,
            sslMode: 'disable',
          },
          10_000,
          30_000,
        ),
    ).toThrow(/CONFIG_INVALID/u);
  });
});

describe('CommunitiesStagingRoleSplitPgMarkerWriter', () => {
  it('locks the catalog, validates OID and owner, writes and reads back in one transaction', async () => {
    const current = sessionFixture([
      [],
      [],
      [],
      [markerIdentity],
      [],
      [
        {
          oid: '45678',
          owner: request.expectedCloneDatabaseOwner,
          owner_oid: request.expectedCloneDatabaseOwnerOid,
          system_identifier: request.systemIdentifier,
        },
      ],
      [],
      [{ marker }],
      [],
    ]);
    const writer = new CommunitiesStagingRoleSplitPgMarkerWriter(
      request.markerWriterSha256,
      cloneOnlyFactory(current.session),
      10_000,
    );
    await expect(
      writer.write({ request, cloneDatabaseOid: '45678', marker }),
    ).resolves.toBeUndefined();
    expect(current.statements).toEqual([
      'begin',
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '30s'",
      expect.stringContaining('select current_database() as database'),
      'lock table pg_catalog.pg_database in access exclusive mode',
      expect.stringContaining('from pg_catalog.pg_database'),
      `comment on database "${request.restoreDatabase}" is '${marker}'`,
      expect.stringContaining('select pg_catalog.shobj_description'),
      'commit',
    ]);
    expect(current.session.close).toHaveBeenCalledOnce();
  });

  it('rolls back without COMMENT when the clone binding differs', async () => {
    const current = sessionFixture([
      [],
      [],
      [],
      [markerIdentity],
      [],
      [
        {
          oid: '99999',
          owner: request.expectedCloneDatabaseOwner,
          owner_oid: request.expectedCloneDatabaseOwnerOid,
          system_identifier: request.systemIdentifier,
        },
      ],
      [],
    ]);
    const writer = new CommunitiesStagingRoleSplitPgMarkerWriter(
      request.markerWriterSha256,
      cloneOnlyFactory(current.session),
      10_000,
    );
    await expect(
      writer.write({ request, cloneDatabaseOid: '45678', marker }),
    ).rejects.toMatchObject({ code: 'MARKER_BINDING_INVALID' });
    expect(current.statements).toContain('rollback');
    expect(current.statements.some((sql) => sql.startsWith('comment on database'))).toBe(false);
  });

  it('rolls back without COMMENT when the connected cluster identifier differs', async () => {
    const current = sessionFixture([
      [],
      [],
      [],
      [markerIdentity],
      [],
      [
        {
          oid: '45678',
          owner: request.expectedCloneDatabaseOwner,
          owner_oid: request.expectedCloneDatabaseOwnerOid,
          system_identifier: '7421999999999999999',
        },
      ],
      [],
    ]);
    const writer = new CommunitiesStagingRoleSplitPgMarkerWriter(
      request.markerWriterSha256,
      cloneOnlyFactory(current.session),
      10_000,
    );
    await expect(
      writer.write({ request, cloneDatabaseOid: '45678', marker }),
    ).rejects.toMatchObject({ code: 'MARKER_BINDING_INVALID' });
    expect(current.statements).toContain('rollback');
    expect(current.statements.some((sql) => sql.startsWith('comment on database'))).toBe(false);
  });

  it.each([
    ['database', { ...markerIdentity, database: request.sourceDatabase }],
    ['current role', { ...markerIdentity, current_user: 'postgres', current_user_oid: '10' }],
  ])(
    'rolls back before catalog lock when the clone session %s differs',
    async (_name, identity) => {
      const current = sessionFixture([[], [], [], [identity], []]);
      const writer = new CommunitiesStagingRoleSplitPgMarkerWriter(
        request.markerWriterSha256,
        cloneOnlyFactory(current.session),
        10_000,
      );
      await expect(
        writer.write({ request, cloneDatabaseOid: '45678', marker }),
      ).rejects.toMatchObject({ code: 'MARKER_BINDING_INVALID' });
      expect(current.statements).toContain('rollback');
      expect(current.statements).not.toContain(
        'lock table pg_catalog.pg_database in access exclusive mode',
      );
      expect(current.statements.some((sql) => sql.startsWith('comment on database'))).toBe(false);
    },
  );
});
