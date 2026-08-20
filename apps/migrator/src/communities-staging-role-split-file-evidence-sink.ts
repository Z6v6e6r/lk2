import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type {
  CommunitiesStagingRoleSplitMarkerCeremonyObservation,
  CommunitiesStagingRoleSplitRestoreMarkerEvidence,
} from '@phub/database';

import type { CommunitiesStagingRoleSplitCanonicalEvidenceSink } from './communities-staging-role-split-canonical-host-adapter.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const EVIDENCE_FILENAME = 'marker-evidence.json';
const MAX_EVIDENCE_BYTES = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class CommunitiesStagingRoleSplitFileEvidenceSinkError extends Error {
  constructor(
    readonly code:
      'CONFIG_INVALID' | 'DIRECTORY_UNSAFE' | 'EVIDENCE_CONFLICT' | 'EVIDENCE_WRITE_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_FILE_EVIDENCE_SINK_${code}`);
    this.name = 'CommunitiesStagingRoleSplitFileEvidenceSinkError';
  }
}

function fail(code: CommunitiesStagingRoleSplitFileEvidenceSinkError['code']): never {
  throw new CommunitiesStagingRoleSplitFileEvidenceSinkError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  fail('CONFIG_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitMarkerEvidence(
  evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
): Buffer {
  const bytes = Buffer.from(`${canonicalJson(evidence)}\n`, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) fail('CONFIG_INVALID');
  return bytes;
}

function currentUid(): number {
  if (process.getuid === undefined) fail('DIRECTORY_UNSAFE');
  return process.getuid();
}

export class CommunitiesStagingRoleSplitFileEvidenceSink implements CommunitiesStagingRoleSplitCanonicalEvidenceSink {
  private readonly evidencePath: string;

  constructor(
    readonly subjectSha256: string,
    private readonly directory: string,
  ) {
    if (!sha256Pattern.test(subjectSha256) || !isAbsolute(directory)) fail('CONFIG_INVALID');
    this.evidencePath = join(directory, EVIDENCE_FILENAME);
  }

  private async assertDirectory(): Promise<void> {
    try {
      const metadata = await lstat(this.directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== 0 ||
        (metadata.mode & 0o777) !== 0o700 ||
        currentUid() !== 0
      )
        fail('DIRECTORY_UNSAFE');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitFileEvidenceSinkError) throw error;
      fail('DIRECTORY_UNSAFE');
    }
  }

  private async fsyncDirectory(): Promise<void> {
    let handle;
    try {
      handle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch {
      fail('EVIDENCE_WRITE_AMBIGUOUS');
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  async observe(
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    await this.assertDirectory();
    const expected = canonicalCommunitiesStagingRoleSplitMarkerEvidence(evidence);
    try {
      await lstat(this.evidencePath);
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') return 'absent';
      return 'unknown';
    }
    try {
      const actual = await readRootOwnedEvidence(this.evidencePath, MAX_EVIDENCE_BYTES);
      return actual.equals(expected) ? 'exact' : 'different';
    } catch {
      return 'unknown';
    }
  }

  async publish(evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence): Promise<void> {
    await this.assertDirectory();
    const expected = canonicalCommunitiesStagingRoleSplitMarkerEvidence(evidence);
    const existing = await this.observe(evidence);
    if (existing === 'exact') return;
    if (existing !== 'absent') fail('EVIDENCE_CONFLICT');

    const temporaryPath = join(
      this.directory,
      `.${EVIDENCE_FILENAME}.${randomBytes(16).toString('hex')}.tmp`,
    );
    let temporaryCreated = false;
    let installed = false;
    try {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
      temporaryCreated = true;
      try {
        await handle.writeFile(expected);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, this.evidencePath);
      installed = true;
      await unlink(temporaryPath);
      temporaryCreated = false;
      await this.fsyncDirectory();
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'EEXIST') {
        const observed = await this.observe(evidence);
        if (observed === 'exact') return;
        fail('EVIDENCE_CONFLICT');
      }
      fail('EVIDENCE_WRITE_AMBIGUOUS');
    } finally {
      if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    }
    if (!installed || (await this.observe(evidence)) !== 'exact') fail('EVIDENCE_WRITE_AMBIGUOUS');
  }
}
