/**
 * Deliberately unwired PG16 host implementation for the marker ceremony.
 *
 * This is a library boundary, not a command: callers must provide an isolated
 * administrator connection and an ownership/ACL-preserving restore callback.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import {
  assertCommunitiesStagingRoleSplitMarkerCeremonyState,
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  canonicalCommunitiesStagingRoleSplitLedger,
  communitiesStagingRoleSplitLedgerSha256,
  assertCommunitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitLedgerEntry,
  type CommunitiesStagingRoleSplitMarkerCeremonyObservation,
  type CommunitiesStagingRoleSplitMarkerCeremonyState,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';

import type {
  CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  CommunitiesStagingRoleSplitMarkerCeremonyHost,
  CommunitiesStagingRoleSplitMarkerCeremonyLease,
} from './communities-staging-role-split-marker-ceremony.js';

const MAX_PERSISTED_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;
const MODE_0700 = 0o700;
const MODE_0600 = 0o600;
const ENVELOPE_VERSION = 'communities-role-split-marker-pg-host-state-v1';

export class CommunitiesStagingRoleSplitMarkerCeremonyPgHostError extends Error {
  constructor(readonly code: string) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_PG_HOST_${code}`);
    this.name = 'CommunitiesStagingRoleSplitMarkerCeremonyPgHostError';
  }
}

function fail(code: string): never {
  throw new CommunitiesStagingRoleSplitMarkerCeremonyPgHostError(code);
}

export interface CommunitiesStagingRoleSplitMarkerCeremonyPgClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
}

export interface CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig {
  readonly stateDirectory: string;
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  /** Dedicated administrator connection to the isolated clone/server only. */
  readonly admin: CommunitiesStagingRoleSplitMarkerCeremonyPgClient;
  /** Read-only connection to the declared source database. */
  readonly source: CommunitiesStagingRoleSplitMarkerCeremonyPgClient;
  /** Dedicated connection to request.restoreDatabase; never the source database. */
  readonly clone: CommunitiesStagingRoleSplitMarkerCeremonyPgClient;
  readonly archive: {
    readonly path: string;
    readonly evidencePath: string;
    readonly tocPath: string;
  };
  /** Must preserve ownership and ACLs; --no-owner and --no-acl are forbidden. */
  readonly restoreArchive: (input: {
    /** The callback must consume this already verified descriptor and must not reopen its path. */
    readonly archiveFile: FileHandle;
    readonly cloneDatabaseOid: string;
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  }) => Promise<void>;
  /** Must create only request.restoreDatabase and return only after server acknowledgement. */
  readonly createCloneDatabase: (restoreDatabase: string) => Promise<void>;
}

interface PersistedEnvelope {
  readonly schemaVersion: typeof ENVELOPE_VERSION;
  readonly state: CommunitiesStagingRoleSplitMarkerCeremonyState;
  readonly artifacts?: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts;
}

interface CatalogRow extends Record<string, unknown> {
  readonly oid: string;
  readonly owner: string;
  readonly owner_oid: string;
}

interface ConnectedDatabaseRow extends CatalogRow {
  readonly database: string;
  readonly system_identifier: string;
  readonly major: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  fail('PERSISTED_VALUE_INVALID');
}

function canonicalEnvelope(envelope: PersistedEnvelope): string {
  return `${canonicalJson(envelope)}\n`;
}

function isRegularMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

function sameStat(
  left: { ino: number; dev: number },
  right: { ino: number; dev: number },
): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

function exactHex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export class CommunitiesStagingRoleSplitMarkerCeremonyPgHost implements CommunitiesStagingRoleSplitMarkerCeremonyHost {
  private readonly statePath: string;
  private readonly leasePath: string;
  private readonly evidencePath: string;

  constructor(private readonly config: CommunitiesStagingRoleSplitMarkerCeremonyPgHostConfig) {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(config.request);
    const configuredPaths = [
      config.stateDirectory,
      config.archive.path,
      config.archive.evidencePath,
      config.archive.tocPath,
    ];
    if (
      !configuredPaths.every(isAbsolute) ||
      new Set(configuredPaths).size !== configuredPaths.length
    )
      fail('PATH_BINDING_INVALID');
    this.statePath = join(config.stateDirectory, 'ceremony-state.json');
    this.leasePath = join(config.stateDirectory, 'ceremony.lock');
    this.evidencePath = join(config.stateDirectory, 'marker-evidence.json');
  }

  private async assertDirectory(): Promise<void> {
    try {
      const stat = await lstat(this.config.stateDirectory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid() ||
        !isRegularMode(stat.mode, MODE_0700)
      )
        fail('STATE_DIRECTORY_UNSAFE');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitMarkerCeremonyPgHostError) throw error;
      fail('STATE_DIRECTORY_UNSAFE');
    }
  }

  private async assertLease(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease): Promise<void> {
    await this.assertDirectory();
    if (
      lease.requestSha256 !==
        communitiesStagingRoleSplitRestoreMarkerRequestSha256(this.config.request) ||
      !exactHex(lease.fencingToken)
    )
      fail('LEASE_INVALID');
    let content: string;
    try {
      const first = await lstat(this.leasePath);
      if (
        !first.isFile() ||
        first.isSymbolicLink() ||
        first.uid !== process.getuid() ||
        !isRegularMode(first.mode, MODE_0600)
      )
        fail('LEASE_LOST');
      const handle = await open(this.leasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameStat(first, opened)) fail('LEASE_LOST');
        content = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      const after = await lstat(this.leasePath);
      if (!sameStat(first, after)) fail('LEASE_LOST');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitMarkerCeremonyPgHostError) throw error;
      fail('LEASE_LOST');
    }
    if (content !== `${lease.requestSha256}\n${lease.fencingToken}\n`) fail('LEASE_LOST');
  }

  private async fsyncDirectory(): Promise<void> {
    try {
      const handle = await open(this.config.stateDirectory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      fail('STATE_FSYNC_FAILED');
    }
  }

  private async readRegular(path: string, maxBytes = MAX_PERSISTED_BYTES): Promise<string | null> {
    try {
      const first = await lstat(path);
      if (
        !first.isFile() ||
        first.isSymbolicLink() ||
        first.uid !== process.getuid() ||
        !isRegularMode(first.mode, MODE_0600) ||
        first.size > maxBytes
      )
        fail('PERSISTED_FILE_UNSAFE');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameStat(first, opened) || opened.size > maxBytes) fail('PERSISTED_FILE_UNSAFE');
        const content = await handle.readFile({ encoding: 'utf8' });
        const after = await lstat(path);
        if (!sameStat(first, after)) fail('PERSISTED_FILE_UNSAFE');
        return content;
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      if (error instanceof CommunitiesStagingRoleSplitMarkerCeremonyPgHostError) throw error;
      fail('PERSISTED_FILE_UNSAFE');
    }
  }

  private parseEnvelope(content: string): PersistedEnvelope {
    if (Buffer.byteLength(content, 'utf8') > MAX_PERSISTED_BYTES || !content.endsWith('\n'))
      fail('STATE_CORRUPT');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      fail('STATE_CORRUPT');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      fail('STATE_CORRUPT');
    const envelope = parsed as PersistedEnvelope;
    if (envelope.schemaVersion !== ENVELOPE_VERSION || canonicalEnvelope(envelope) !== content)
      fail('STATE_CORRUPT');
    try {
      assertCommunitiesStagingRoleSplitMarkerCeremonyState(envelope.state);
      if (envelope.artifacts !== undefined)
        assertCommunitiesStagingRoleSplitRestoreMarker(
          envelope.artifacts.payload,
          envelope.artifacts.marker,
        );
    } catch {
      fail('STATE_CORRUPT');
    }
    return envelope;
  }

  private async writeCas(expected: string | null, next: PersistedEnvelope): Promise<void> {
    const serialized = canonicalEnvelope(next);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTED_BYTES) fail('STATE_TOO_LARGE');
    const current = await this.readRegular(this.statePath);
    if (current !== expected) fail('STATE_CAS_MISMATCH');
    const temporary = join(
      this.config.stateDirectory,
      `.ceremony-state.${randomBytes(16).toString('hex')}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      );
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Re-read immediately before rename; a concurrent writer must not be overwritten.
      if ((await this.readRegular(this.statePath)) !== expected) fail('STATE_CAS_MISMATCH');
      await rename(temporary, this.statePath);
      await this.fsyncDirectory();
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof CommunitiesStagingRoleSplitMarkerCeremonyPgHostError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }

  private async catalog(
    client: CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
    name: string,
  ): Promise<CatalogRow | null> {
    const result = await client.query<CatalogRow>(
      'SELECT d.oid::text AS oid, r.rolname AS owner, d.datdba::text AS owner_oid FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba WHERE d.datname = $1',
      [name],
    );
    return result.rows.length === 1 ? result.rows[0]! : null;
  }

  private async exactClone(oid: string): Promise<CatalogRow | null> {
    const row = await this.catalog(this.config.admin, this.config.request.restoreDatabase).catch(
      () => fail('PG_CATALOG_UNAVAILABLE'),
    );
    return row !== null &&
      row.oid === oid &&
      row.owner === this.config.request.expectedCloneDatabaseOwner &&
      row.owner_oid === this.config.request.expectedCloneDatabaseOwnerOid
      ? row
      : null;
  }

  private async connectedDatabase(
    client: CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
  ): Promise<ConnectedDatabaseRow> {
    const result = await client.query<ConnectedDatabaseRow>(
      "SELECT current_database() AS database, d.oid::text AS oid, r.rolname AS owner, d.datdba::text AS owner_oid, system.system_identifier::text AS system_identifier, split_part(current_setting('server_version'), '.', 1) AS major FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba CROSS JOIN pg_catalog.pg_control_system() system WHERE d.datname = current_database()",
    );
    if (result.rows.length !== 1) fail('CONNECTED_DATABASE_INVALID');
    return result.rows[0]!;
  }

  private async assertAdminServerBinding(): Promise<void> {
    const result = await this.config.admin.query<{
      readonly system_identifier: string;
      readonly major: string;
    }>(
      "SELECT system_identifier::text AS system_identifier, split_part(current_setting('server_version'), '.', 1) AS major FROM pg_catalog.pg_control_system()",
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.system_identifier !== this.config.request.systemIdentifier ||
      result.rows[0]?.major !== '16'
    )
      fail('TARGET_SERVER_BINDING_INVALID');
  }

  private async assertConnectedClone(cloneDatabaseOid: string): Promise<ConnectedDatabaseRow> {
    const row = await this.connectedDatabase(this.config.clone).catch(() =>
      fail('CLONE_BINDING_INVALID'),
    );
    if (
      row.database !== this.config.request.restoreDatabase ||
      row.oid !== cloneDatabaseOid ||
      row.owner !== this.config.request.expectedCloneDatabaseOwner ||
      row.owner_oid !== this.config.request.expectedCloneDatabaseOwnerOid ||
      row.system_identifier !== this.config.request.systemIdentifier ||
      row.major !== '16'
    )
      fail('CLONE_BINDING_INVALID');
    return row;
  }

  private async readLedger(
    client: CommunitiesStagingRoleSplitMarkerCeremonyPgClient,
  ): Promise<readonly CommunitiesStagingRoleSplitLedgerEntry[]> {
    const result = await client.query<CommunitiesStagingRoleSplitLedgerEntry>(
      'SELECT filename, checksum FROM public.schema_migrations ORDER BY filename',
    );
    return result.rows;
  }

  private async hashHandle(
    handle: FileHandle,
    maxBytes: number,
  ): Promise<{
    readonly bytes: number;
    readonly digest: string;
  }> {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxBytes) fail('ARCHIVE_CUSTODY_INVALID');
      digest.update(chunk.subarray(0, bytesRead));
    }
    return { bytes: offset, digest: digest.digest('hex') };
  }

  private async verifyArchiveCustody(): Promise<FileHandle> {
    const files = [
      [
        this.config.archive.path,
        this.config.request.backupSha256,
        Number(this.config.request.backupBytes),
        this.config.request.backupBasename,
      ],
      [
        this.config.archive.evidencePath,
        this.config.request.backupEvidenceSha256,
        null,
        this.config.request.backupEvidenceBasename,
      ],
      [this.config.archive.tocPath, this.config.request.archiveTocSha256, null, null],
    ] as const;
    let verifiedArchive: FileHandle | null = null;
    try {
      for (const [path, expected, exactBytes, expectedBasename] of files) {
        let handle: FileHandle | null = null;
        let retainHandle = false;
        try {
          if (expectedBasename !== null && basename(path) !== expectedBasename)
            fail('ARCHIVE_CUSTODY_INVALID');
          const maxBytes = exactBytes ?? MAX_ARCHIVE_METADATA_BYTES;
          if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARCHIVE_BYTES)
            fail('ARCHIVE_CUSTODY_INVALID');
          const first = await lstat(path);
          if (
            !first.isFile() ||
            first.isSymbolicLink() ||
            first.uid !== process.getuid() ||
            !isRegularMode(first.mode, MODE_0600) ||
            first.size <= 0 ||
            first.size > maxBytes ||
            (exactBytes !== null && first.size !== exactBytes)
          )
            fail('ARCHIVE_CUSTODY_INVALID');
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const opened = await handle.stat();
          if (
            !sameStat(first, opened) ||
            opened.uid !== process.getuid() ||
            !isRegularMode(opened.mode, MODE_0600) ||
            opened.size <= 0 ||
            opened.size > maxBytes ||
            (exactBytes !== null && opened.size !== exactBytes)
          )
            fail('ARCHIVE_CUSTODY_INVALID');
          const hashed = await this.hashHandle(handle, maxBytes);
          if (hashed.bytes !== opened.size || hashed.digest !== expected)
            fail('ARCHIVE_CUSTODY_INVALID');
          const after = await lstat(path);
          if (!sameStat(first, after)) fail('ARCHIVE_CUSTODY_INVALID');
          if (path === this.config.archive.path) {
            verifiedArchive = handle;
            retainHandle = true;
          }
        } catch (error) {
          if (error instanceof CommunitiesStagingRoleSplitMarkerCeremonyPgHostError) throw error;
          fail('ARCHIVE_CUSTODY_INVALID');
        } finally {
          if (handle !== null && !retainHandle) await handle.close().catch(() => undefined);
        }
      }
      if (verifiedArchive === null) fail('ARCHIVE_CUSTODY_INVALID');
      return verifiedArchive;
    } catch (error) {
      if (verifiedArchive !== null) await verifiedArchive.close().catch(() => undefined);
      throw error;
    }
  }

  async acquireLease(
    requestSha256: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyLease> {
    await this.assertDirectory();
    if (
      requestSha256 !== communitiesStagingRoleSplitRestoreMarkerRequestSha256(this.config.request)
    )
      fail('REQUEST_SHA_INVALID');
    const lease = { requestSha256, fencingToken: randomBytes(32).toString('hex') } as const;
    try {
      const handle = await open(
        this.leasePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      );
      try {
        await handle.writeFile(`${lease.requestSha256}\n${lease.fencingToken}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fsyncDirectory();
      return lease;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') fail('LEASE_UNAVAILABLE');
      fail('LEASE_UNAVAILABLE');
    }
  }

  async releaseLease(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease): Promise<void> {
    await this.assertLease(lease);
    try {
      await unlink(this.leasePath);
      await this.fsyncDirectory();
    } catch {
      fail('LEASE_RELEASE_AMBIGUOUS');
    }
  }

  async loadState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyState | null> {
    await this.assertLease(lease);
    const content = await this.readRegular(this.statePath);
    return content === null ? null : this.parseEnvelope(content).state;
  }

  async createCandidate(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void> {
    await this.assertLease(lease);
    assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
    if (state.phase !== 'CANDIDATE') fail('STATE_INVALID');
    await this.writeCas(null, { schemaVersion: ENVELOPE_VERSION, state });
  }

  async advanceState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void> {
    await this.assertLease(lease);
    assertCommunitiesStagingRoleSplitMarkerCeremonyState(current);
    assertCommunitiesStagingRoleSplitMarkerCeremonyState(next);
    const content = await this.readRegular(this.statePath);
    if (content === null) fail('STATE_CAS_MISMATCH');
    const envelope = this.parseEnvelope(content);
    if (canonicalJson(envelope.state) !== canonicalJson(current)) fail('STATE_CAS_MISMATCH');
    await this.writeCas(content, { ...envelope, state: next });
  }

  async saveVerified(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
    artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  ): Promise<void> {
    await this.assertLease(lease);
    assertCommunitiesStagingRoleSplitRestoreMarker(artifacts.payload, artifacts.marker);
    const content = await this.readRegular(this.statePath);
    if (content === null) fail('STATE_CAS_MISMATCH');
    const envelope = this.parseEnvelope(content);
    if (
      canonicalJson(envelope.state) !== canonicalJson(current) ||
      envelope.artifacts !== undefined
    )
      fail('STATE_CAS_MISMATCH');
    await this.writeCas(content, { schemaVersion: ENVELOPE_VERSION, state: next, artifacts });
  }

  async loadVerifiedArtifacts(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyArtifacts> {
    await this.assertLease(lease);
    const content = await this.readRegular(this.statePath);
    if (content === null) fail('ARTIFACTS_REQUIRED');
    const artifacts = this.parseEnvelope(content).artifacts;
    if (artifacts === undefined) fail('ARTIFACTS_REQUIRED');
    return artifacts;
  }

  async observeClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string | null,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    await this.assertLease(lease);
    try {
      const row = await this.catalog(this.config.admin, this.config.request.restoreDatabase);
      return row === null
        ? 'absent'
        : expectedCloneDatabaseOid !== null &&
            row.oid === expectedCloneDatabaseOid &&
            row.owner === this.config.request.expectedCloneDatabaseOwner &&
            row.owner_oid === this.config.request.expectedCloneDatabaseOwnerOid
          ? 'exact'
          : 'different';
    } catch {
      return 'unknown';
    }
  }

  async observeMarkerPresence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
  ): Promise<'absent' | 'present' | 'unknown'> {
    await this.assertLease(lease);
    if ((await this.exactClone(expectedCloneDatabaseOid)) === null) return 'unknown';
    try {
      const result = await this.config.admin.query<{ readonly marker: string | null }>(
        "SELECT pg_catalog.shobj_description($1::oid, 'pg_database') AS marker",
        [expectedCloneDatabaseOid],
      );
      const value = result.rows[0]?.marker;
      return value === undefined ? 'unknown' : value === null ? 'absent' : 'present';
    } catch {
      return 'unknown';
    }
  }

  async observeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
    marker: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    await this.assertLease(lease);
    if ((await this.exactClone(expectedCloneDatabaseOid)) === null) return 'different';
    try {
      const result = await this.config.admin.query<{ readonly marker: string | null }>(
        "SELECT pg_catalog.shobj_description($1::oid, 'pg_database') AS marker",
        [expectedCloneDatabaseOid],
      );
      const value = result.rows[0]?.marker;
      return value === marker ? 'exact' : value === null ? 'absent' : 'different';
    } catch {
      return 'unknown';
    }
  }

  async observeEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    await this.assertLease(lease);
    const content = await this.readRegular(this.evidencePath);
    if (content === null) return 'absent';
    try {
      const parsed = JSON.parse(content) as CommunitiesStagingRoleSplitRestoreMarkerEvidence;
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
        (await this.loadVerifiedArtifacts(lease)).payload,
        (await this.loadVerifiedArtifacts(lease)).marker,
        parsed,
      );
      return content === `${canonicalJson(evidence)}\n` ? 'exact' : 'different';
    } catch {
      return 'unknown';
    }
  }

  async createClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<{ readonly cloneDatabaseOid: string }> {
    await this.assertLease(lease);
    await this.assertAdminServerBinding().catch(() => fail('TARGET_SERVER_BINDING_INVALID'));
    if ((await this.catalog(this.config.admin, this.config.request.restoreDatabase)) !== null)
      fail('CREATE_CLONE_INVALID');
    await this.config
      .createCloneDatabase(this.config.request.restoreDatabase)
      .catch(() => fail('CREATE_CLONE_FAILED'));
    await this.assertLease(lease);
    const row = await this.catalog(this.config.admin, this.config.request.restoreDatabase).catch(
      () => fail('PG_CATALOG_UNAVAILABLE'),
    );
    if (
      row === null ||
      row.owner !== this.config.request.expectedCloneDatabaseOwner ||
      row.owner_oid !== this.config.request.expectedCloneDatabaseOwnerOid
    )
      fail('CREATE_CLONE_INVALID');
    await this.assertConnectedClone(row.oid);
    return { cloneDatabaseOid: row.oid };
  }

  async restoreClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<void> {
    await this.assertLease(lease);
    await this.assertAdminServerBinding().catch(() => fail('TARGET_SERVER_BINDING_INVALID'));
    if ((await this.exactClone(cloneDatabaseOid)) === null) fail('CLONE_BINDING_INVALID');
    await this.assertConnectedClone(cloneDatabaseOid);
    const archiveFile = await this.verifyArchiveCustody();
    await this.assertLease(lease);
    try {
      await this.config
        .restoreArchive({ archiveFile, cloneDatabaseOid, request: this.config.request })
        .catch(() => fail('RESTORE_FAILED'));
      const rehashed = await this.hashHandle(archiveFile, Number(this.config.request.backupBytes));
      if (
        rehashed.bytes !== Number(this.config.request.backupBytes) ||
        rehashed.digest !== this.config.request.backupSha256
      )
        fail('ARCHIVE_CUSTODY_INVALID');
    } finally {
      await archiveFile.close().catch(() => undefined);
    }
    await this.assertLease(lease);
    if ((await this.exactClone(cloneDatabaseOid)) === null) fail('CLONE_BINDING_INVALID');
  }

  async verifyBindings(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyArtifacts> {
    await this.assertLease(lease);
    const clone = await this.exactClone(cloneDatabaseOid);
    if (clone === null) fail('CLONE_BINDING_INVALID');
    const source = await this.connectedDatabase(this.config.source).catch(() =>
      fail('SOURCE_BINDING_INVALID'),
    );
    if (
      source.database !== this.config.request.sourceDatabase ||
      source.oid !== this.config.request.sourceDatabaseOid ||
      source.owner !== this.config.request.sourceDatabaseOwner ||
      source.owner_oid !== this.config.request.sourceDatabaseOwnerOid
    )
      fail('SOURCE_BINDING_INVALID');
    if (source.system_identifier !== this.config.request.systemIdentifier || source.major !== '16')
      fail('SOURCE_BINDING_INVALID');
    await this.assertAdminServerBinding().catch(() => fail('TARGET_SERVER_BINDING_INVALID'));
    await this.assertConnectedClone(cloneDatabaseOid);
    const sourceLedger = await this.readLedger(this.config.source).catch(() =>
      fail('LEDGER_BINDING_INVALID'),
    );
    const restoredLedger = await this.readLedger(this.config.clone).catch(() =>
      fail('LEDGER_BINDING_INVALID'),
    );
    if (
      communitiesStagingRoleSplitLedgerSha256(sourceLedger) !==
        this.config.request.sourceLedgerSha256 ||
      String(sourceLedger.length) !== this.config.request.sourceLedgerCount ||
      canonicalCommunitiesStagingRoleSplitLedger(sourceLedger) !==
        canonicalCommunitiesStagingRoleSplitLedger(restoredLedger)
    )
      fail('LEDGER_BINDING_INVALID');
    const payload: CommunitiesStagingRoleSplitRestoreMarkerPayload = {
      requestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(this.config.request),
      restoreDatabase: this.config.request.restoreDatabase,
      cloneDatabaseOid,
      cloneDatabaseOwner: clone.owner,
      cloneDatabaseOwnerOid: clone.owner_oid,
      sourceDatabase: this.config.request.sourceDatabase,
      sourceDatabaseOid: source.oid,
      sourceDatabaseOwner: source.owner,
      sourceDatabaseOwnerOid: source.owner_oid,
      systemIdentifier: this.config.request.systemIdentifier,
      backupSha256: this.config.request.backupSha256,
      backupBytes: this.config.request.backupBytes,
      backupEvidenceSha256: this.config.request.backupEvidenceSha256,
      archiveTocSha256: this.config.request.archiveTocSha256,
      sourceLedgerSha256: this.config.request.sourceLedgerSha256,
      sourceLedgerCount: this.config.request.sourceLedgerCount,
      activeRelease: this.config.request.activeRelease,
      restoreRunId: this.config.request.restoreRunId,
      restoreRunAttempt: this.config.request.restoreRunAttempt,
      postgresMajor: '16',
      objectManifestSha256: this.config.request.objectManifestSha256,
      restoreHelperSha256: this.config.request.restoreHelperSha256,
      markerWriterSha256: this.config.request.markerWriterSha256,
    };
    const marker = communitiesStagingRoleSplitRestoreMarker(payload);
    assertCommunitiesStagingRoleSplitRestoreMarker(payload, marker);
    return { payload, marker };
  }

  async writeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
    marker: string,
  ): Promise<void> {
    await this.assertLease(lease);
    void cloneDatabaseOid;
    void marker;
    fail('CLUSTER_DDL_FENCE_REQUIRED');
  }

  async publishEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ): Promise<void> {
    await this.assertLease(lease);
    void evidence;
    fail('OWNERSHIP_ACL_ATTESTATION_REQUIRED');
  }

  async dropExactClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<void> {
    await this.assertLease(lease);
    void cloneDatabaseOid;
    fail('AUTOMATIC_DROP_UNAVAILABLE');
  }

  async clearState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void> {
    await this.assertLease(lease);
    const content = await this.readRegular(this.statePath);
    if (
      content === null ||
      canonicalJson(this.parseEnvelope(content).state) !== canonicalJson(current)
    )
      fail('STATE_CAS_MISMATCH');
    await unlink(this.statePath).catch(() => fail('STATE_CLEAR_FAILED'));
    await this.fsyncDirectory();
  }
}

/** Paths are intentionally never emitted by errors; useful only for unit assertions. */
export function communitiesStagingRoleSplitMarkerCeremonyPgHostFilenames(): readonly string[] {
  return ['ceremony-state.json', 'ceremony.lock', 'marker-evidence.json'].map(basename);
}
