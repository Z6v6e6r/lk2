import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  advanceCommunitiesStagingRoleSplitMarkerCeremonyState,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  type CommunitiesStagingRoleSplitLedgerEntry,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  CommunitiesStagingRoleSplitMarkerCeremonyPgHost,
  CommunitiesStagingRoleSplitMarkerCeremonyPgHostError,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig,
  type CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
} from './communities-staging-role-split-marker-ceremony-pg-host.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const ledger: readonly CommunitiesStagingRoleSplitLedgerEntry[] = [
  { filename: '0001_initial.sql', checksum: 'a'.repeat(64) },
];

function fakePgClient(
  resolve: (sql: string) => readonly object[],
): CommunitiesStagingRoleSplitMarkerCeremonyPgClient {
  return {
    query<T extends object>(sql: string) {
      return Promise.resolve({ rows: resolve(sql) as readonly T[] });
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phub-marker-host-'));
  await chmod(directory, 0o700);
  const archiveBasename = 'postgres-communities-rehearsal-20260819T120000Z-123.dump';
  const evidenceBasename = `${archiveBasename}.evidence`;
  const archive = join(directory, archiveBasename);
  const evidence = join(directory, evidenceBasename);
  const toc = join(directory, 'archive.toc');
  await writeFile(archive, 'archive');
  await writeFile(evidence, 'evidence');
  await writeFile(toc, 'toc');
  await Promise.all([archive, evidence, toc].map((path) => chmod(path, 0o600)));
  const request = {
    restoreDatabase: 'phub_restore_123_4',
    expectedCloneDatabaseOwner: 'phub_staging',
    expectedCloneDatabaseOwnerOid: '16384',
    sourceDatabase: 'phub_staging',
    sourceDatabaseOid: '16385',
    sourceDatabaseOwner: 'phub_staging',
    sourceDatabaseOwnerOid: '16384',
    systemIdentifier: '7421000000000000000',
    backupBasename: archiveBasename,
    backupSha256: sha('archive'),
    backupBytes: '7',
    backupEvidenceBasename: evidenceBasename,
    backupEvidenceSha256: sha('evidence'),
    archiveTocSha256: sha('toc'),
    sourceLedgerSha256: communitiesStagingRoleSplitLedgerSha256(ledger),
    sourceLedgerCount: '1',
    activeRelease: 'f'.repeat(40),
    restoreRunId: '123',
    restoreRunAttempt: '4',
    postgresMajor: '16',
    objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
    restoreHelperSha256: '2'.repeat(64),
    markerWriterSha256: '3'.repeat(64),
  } satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
  const queries: string[] = [];
  const controls = {
    adminSystemIdentifier: request.systemIdentifier,
    cloneSystemIdentifier: request.systemIdentifier,
    sourceSystemIdentifier: request.systemIdentifier,
    cloneExists: true,
    restoreCalls: 0,
    restoreInputKeys: [] as string[],
    createCalls: 0,
  };
  const admin = fakePgClient((sql) => {
    queries.push(sql);
    if (sql.includes('system_identifier') && sql.includes('server_version'))
      return [{ system_identifier: controls.adminSystemIdentifier, major: '16' }];
    if (sql.includes('pg_database'))
      return controls.cloneExists
        ? [{ oid: '45678', owner: 'phub_staging', owner_oid: '16384' }]
        : [];
    if (sql.includes('server_version')) return [{ major: '16' }];
    if (sql.includes('pg_control_system'))
      return [{ system_identifier: controls.cloneSystemIdentifier }];
    return [];
  });
  const source = fakePgClient((sql) => {
    queries.push(sql);
    if (sql.includes('current_database'))
      return [
        {
          database: request.sourceDatabase,
          oid: request.sourceDatabaseOid,
          owner: request.sourceDatabaseOwner,
          owner_oid: request.sourceDatabaseOwnerOid,
          system_identifier: controls.sourceSystemIdentifier,
          major: '16',
        },
      ];
    if (sql.includes('schema_migrations')) return ledger;
    return [];
  });
  const clone = fakePgClient((sql) => {
    queries.push(sql);
    if (sql.includes('current_database'))
      return [
        {
          database: request.restoreDatabase,
          oid: '45678',
          owner: request.expectedCloneDatabaseOwner,
          owner_oid: request.expectedCloneDatabaseOwnerOid,
          system_identifier: controls.cloneSystemIdentifier,
          major: '16',
        },
      ];
    if (sql.includes('schema_migrations')) return ledger;
    return [];
  });
  const config = {
    stateDirectory: directory,
    request,
    creationReceiptSha256: '1'.repeat(64),
    admin,
    source,
    clone,
    archive: { path: archive, evidencePath: evidence, tocPath: toc },
    createCloneDatabase: () => {
      controls.createCalls += 1;
      controls.cloneExists = true;
      return Promise.resolve();
    },
    restoreArchive: (input) => {
      controls.restoreCalls += 1;
      controls.restoreInputKeys = Object.keys(input).sort();
      return Promise.resolve();
    },
  } as const satisfies CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig;
  const host = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(config);
  return {
    host,
    directory,
    archive,
    evidence,
    toc,
    request,
    requestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
    queries,
    controls,
    config,
  };
}

describe('CommunitiesStagingRoleSplitMarkerCeremonyPgHost', () => {
  it('requires an independently pinned exact creation receipt digest', async () => {
    const { config } = await fixture();
    expect(
      () =>
        new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
          ...config,
          creationReceiptSha256: 'not-a-sha256',
        }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CREATION_RECEIPT_SHA_INVALID',
      }),
    );
  });

  it('denies a second lease and retains a stale lease rather than stealing it', async () => {
    const { host, requestSha256 } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    await expect(host.acquireLease(requestSha256)).rejects.toMatchObject({
      code: 'LEASE_UNAVAILABLE',
    });
    await expect(host.dropExactClone(lease, '45678')).rejects.toMatchObject({
      code: 'AUTOMATIC_DROP_UNAVAILABLE',
    });
  });

  it('requires a pre-provisioned private state directory', async () => {
    const { config, directory, requestSha256 } = await fixture();
    await unlink(join(directory, 'marker-evidence.json')).catch(() => undefined);
    const missing = join(directory, 'missing');
    const configured = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
      ...config,
      stateDirectory: missing,
    });
    await expect(configured.acquireLease(requestSha256)).rejects.toMatchObject({
      code: 'STATE_DIRECTORY_UNSAFE',
    });
  });

  it('persists canonical state and rejects stale compare-and-swap transitions', async () => {
    const { host, requestSha256, directory, config } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    const candidate = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(requestSha256);
    const owned = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(candidate, 'OWNED', {
      cloneDatabaseOid: '45678',
    });
    await host.createCandidate(lease, candidate);
    await host.advanceState(lease, candidate, owned);
    await expect(host.advanceState(lease, candidate, owned)).rejects.toMatchObject({
      code: 'STATE_CAS_MISMATCH',
    });
    const persistedText = await readFile(join(directory, 'ceremony-state.json'), 'utf8');
    expect(persistedText.endsWith('\n')).toBe(true);
    const persisted = JSON.parse(persistedText) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([
      'creationReceiptSha256',
      'schemaVersion',
      'state',
    ]);
    expect(persisted).toMatchObject({
      schemaVersion: 'communities-role-split-marker-pg-host-state-v2',
      creationReceiptSha256: config.creationReceiptSha256,
    });
  });

  it('rejects a different valid receipt before resuming a pre-verified state', async () => {
    const { host, requestSha256, directory, config } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    const candidate = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(requestSha256);
    await host.createCandidate(lease, candidate);
    await host.releaseLease(lease);

    const changed = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
      ...config,
      creationReceiptSha256: '2'.repeat(64),
    });
    await expect(changed.acquireLease(requestSha256)).rejects.toMatchObject({
      code: 'STATE_RECEIPT_MISMATCH',
    });
    await expect(readFile(join(directory, 'ceremony.lock'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const resumed = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(config);
    const resumedLease = await resumed.acquireLease(requestSha256);
    await expect(resumed.loadState(resumedLease)).resolves.toEqual(candidate);
    await resumed.releaseLease(resumedLease);
  });

  it('rejects a different valid receipt before resuming verified artifacts', async () => {
    const { host, requestSha256, directory, config } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    const candidate = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(requestSha256);
    const owned = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(candidate, 'OWNED', {
      cloneDatabaseOid: '45678',
    });
    const restorePending = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
      owned,
      'RESTORE_PENDING',
      { cloneDatabaseOid: '45678' },
    );
    const restored = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
      restorePending,
      'RESTORED',
      { cloneDatabaseOid: '45678' },
    );
    await host.createCandidate(lease, candidate);
    await host.advanceState(lease, candidate, owned);
    await host.advanceState(lease, owned, restorePending);
    await host.advanceState(lease, restorePending, restored);
    const artifacts = await host.verifyBindings(lease, '45678');
    const verified = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(restored, 'VERIFIED', {
      cloneDatabaseOid: '45678',
      markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(artifacts.payload),
    });
    await host.saveVerified(lease, restored, verified, artifacts);
    const persisted = JSON.parse(
      await readFile(join(directory, 'ceremony-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([
      'artifacts',
      'creationReceiptSha256',
      'schemaVersion',
      'state',
    ]);
    expect(persisted).toMatchObject({
      creationReceiptSha256: config.creationReceiptSha256,
      artifacts: { payload: { creationReceiptSha256: config.creationReceiptSha256 } },
    });
    await host.releaseLease(lease);

    const changed = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost({
      ...config,
      creationReceiptSha256: '2'.repeat(64),
    });
    await expect(changed.acquireLease(requestSha256)).rejects.toMatchObject({
      code: 'STATE_RECEIPT_MISMATCH',
    });
    await expect(readFile(join(directory, 'ceremony.lock'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const resumed = new CommunitiesStagingRoleSplitMarkerCeremonyPgHost(config);
    const resumedLease = await resumed.acquireLease(requestSha256);
    await expect(resumed.loadVerifiedArtifacts(resumedLease)).resolves.toEqual(artifacts);
    await resumed.releaseLease(resumedLease);
  });

  it('streams exact private archive custody before invoking restore', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    await expect(host.restoreClone(lease, '45678')).resolves.toBeUndefined();
    expect(controls.restoreCalls).toBe(1);
    expect(controls.restoreInputKeys).toEqual(['archiveFile', 'cloneDatabaseOid', 'request']);
  });

  it('rejects archive size or digest drift before invoking restore', async () => {
    const { host, requestSha256, controls, archive } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    await writeFile(archive, 'archive-drift');
    await chmod(archive, 0o600);
    await expect(host.restoreClone(lease, '45678')).rejects.toMatchObject({
      code: 'ARCHIVE_CUSTODY_INVALID',
    });
    expect(controls.restoreCalls).toBe(0);
  });

  it('binds source and clone to the same pinned PG16 system and ledger', async () => {
    const { host, requestSha256, config } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    await expect(host.verifyBindings(lease, '45678')).resolves.toMatchObject({
      payload: {
        cloneDatabaseOid: '45678',
        postgresMajor: '16',
        creationReceiptSha256: config.creationReceiptSha256,
      },
    });
  });

  it('fails closed when the clone connection reaches another cluster', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    controls.cloneSystemIdentifier = '7421000000000000001';
    await expect(host.verifyBindings(lease, '45678')).rejects.toMatchObject({
      code: 'CLONE_BINDING_INVALID',
    });
  });

  it('creates only the requested clone and rechecks its exact OID and owner', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    controls.cloneExists = false;
    await expect(host.createClone(lease)).resolves.toEqual({ cloneDatabaseOid: '45678' });
    expect(controls.createCalls).toBe(1);
  });

  it('rejects an existing clone before the create callback', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    await expect(host.createClone(lease)).rejects.toMatchObject({ code: 'CREATE_CLONE_INVALID' });
    expect(controls.createCalls).toBe(0);
  });

  it('rejects a wrong admin cluster before clone creation', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    controls.cloneExists = false;
    controls.adminSystemIdentifier = '7421000000000000001';
    await expect(host.createClone(lease)).rejects.toMatchObject({
      code: 'TARGET_SERVER_BINDING_INVALID',
    });
    expect(controls.createCalls).toBe(0);
  });

  it('rejects a wrong clone connection before restore', async () => {
    const { host, requestSha256, controls } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    controls.cloneSystemIdentifier = '7421000000000000001';
    await expect(host.restoreClone(lease, '45678')).rejects.toMatchObject({
      code: 'CLONE_BINDING_INVALID',
    });
    expect(controls.restoreCalls).toBe(0);
  });

  it('keeps marker, evidence and automatic cleanup mutations unavailable', async () => {
    const { host, requestSha256, queries } = await fixture();
    const lease = await host.acquireLease(requestSha256);
    const before = queries.length;
    await expect(host.writeMarker(lease, '45678', 'marker')).rejects.toMatchObject({
      code: 'CLUSTER_DDL_FENCE_REQUIRED',
    });
    await expect(host.publishEvidence(lease, {} as never)).rejects.toMatchObject({
      code: 'OWNERSHIP_ACL_ATTESTATION_REQUIRED',
    });
    await expect(host.dropExactClone(lease, '45678')).rejects.toMatchObject({
      code: 'AUTOMATIC_DROP_UNAVAILABLE',
    });
    expect(queries).toHaveLength(before);
  });

  it('uses no database query for automatic cleanup', async () => {
    const { host, queries } = await fixture();
    await expect(
      host.dropExactClone({ requestSha256: 'a'.repeat(64), fencingToken: 'b'.repeat(64) }, '45678'),
    ).rejects.toBeInstanceOf(CommunitiesStagingRoleSplitMarkerCeremonyPgHostError);
    expect(queries).toEqual([]);
  });
});
