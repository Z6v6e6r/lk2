import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION =
  'communities-staging-role-split-v3-external-phase-anchor-v1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_PHASES = [
  'OWNED',
  'RESTORE_PENDING',
  'RESTORED',
  'VERIFIED',
  'MARKER_PENDING',
  'MARKED',
  'EVIDENCED',
] as const;

export type CommunitiesStagingRoleSplitV3DurablePhase =
  (typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_PHASES)[number];

export interface CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION;
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly phaseIndex: number;
  readonly phase: CommunitiesStagingRoleSplitV3DurablePhase;
  readonly envelopeSha256: string;
  readonly previousEnvelopeSha256: string | null;
}

export interface CommunitiesStagingRoleSplitV3ExternalPhaseAnchor {
  readonly subjectSha256: string;
  assertIndependent(input: {
    readonly stateDirectory: string;
    readonly requestSha256: string;
    readonly creationReceiptSha256: string;
  }): Promise<void>;
  observe(): Promise<CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null>;
  advance(input: {
    readonly expected: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null;
    readonly next: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation;
  }): Promise<void>;
}

const MODE_0700 = 0o700;
const MODE_0600 = 0o600;
const MAX_ANCHOR_BYTES = 16 * 1024;
const ANCHOR_PREFIX = 'v3-external-phase-anchor';
const LOCK_BASENAME = 'v3-external-phase-anchor.lock';
const sha256 = /^[a-f0-9]{64}$/u;
const anchorName =
  /^v3-external-phase-anchor-(\d{2})-(owned|restore_pending|restored|verified|marker_pending|marked|evidenced)-([a-f0-9]{64})\.json$/u;

export class CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError extends Error {
  constructor(
    readonly code:
      | 'BINDING_INVALID'
      | 'DIRECTORY_UNSAFE'
      | 'FILE_UNSAFE'
      | 'ANCHOR_CORRUPT'
      | 'ANCHOR_CONFLICT'
      | 'LOCK_UNAVAILABLE'
      | 'LOCK_LOST'
      | 'LOCK_RELEASE_FAILED'
      | 'WRITE_FAILED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError['code']): never {
  throw new CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError(code);
}

function currentUid(): number {
  if (process.getuid === undefined) fail('DIRECTORY_UNSAFE');
  return process.getuid();
}

function sameStat(
  left: { ino: number; dev: number },
  right: { ino: number; dev: number },
): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

function regular0600(stat: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  nlink: number;
}): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === currentUid() &&
    stat.nlink === 1 &&
    (stat.mode & 0o777) === MODE_0600
  );
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function assertCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(
  value: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
): void {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'requestSha256',
      'creationReceiptSha256',
      'phaseIndex',
      'phase',
      'envelopeSha256',
      'previousEnvelopeSha256',
    ]) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION ||
    !sha256.test(value.requestSha256) ||
    !sha256.test(value.creationReceiptSha256) ||
    !Number.isSafeInteger(value.phaseIndex) ||
    value.phaseIndex < 0 ||
    value.phaseIndex >= COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_PHASES.length ||
    COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_PHASES[value.phaseIndex] !== value.phase ||
    !sha256.test(value.envelopeSha256) ||
    (value.previousEnvelopeSha256 !== null && !sha256.test(value.previousEnvelopeSha256)) ||
    (value.phaseIndex === 0) !== (value.previousEnvelopeSha256 === null)
  )
    fail('ANCHOR_CORRUPT');
}

export function canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(
  value: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
): string {
  assertCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(value);
  return `${JSON.stringify({
    schemaVersion: value.schemaVersion,
    requestSha256: value.requestSha256,
    creationReceiptSha256: value.creationReceiptSha256,
    phaseIndex: value.phaseIndex,
    phase: value.phase,
    envelopeSha256: value.envelopeSha256,
    previousEnvelopeSha256: value.previousEnvelopeSha256,
  })}\n`;
}

export function communitiesStagingRoleSplitV3ExternalPhaseAnchorObservationSha256(
  value: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(value), 'utf8')
    .digest('hex');
}

function parseObservation(
  bytes: string,
): CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation {
  let value: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation;
  try {
    value = JSON.parse(bytes) as CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation;
    assertCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(value);
  } catch {
    fail('ANCHOR_CORRUPT');
  }
  if (canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(value) !== bytes)
    fail('ANCHOR_CORRUPT');
  return value;
}

export class CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor implements CommunitiesStagingRoleSplitV3ExternalPhaseAnchor {
  readonly subjectSha256: string;
  private readonly lockPath: string;

  constructor(
    subjectSha256: string,
    private readonly anchorDirectory: string,
    private readonly requestSha256: string,
    private readonly creationReceiptSha256: string,
  ) {
    if (
      !sha256.test(subjectSha256) ||
      !sha256.test(requestSha256) ||
      !sha256.test(creationReceiptSha256) ||
      !isAbsolute(anchorDirectory)
    )
      fail('BINDING_INVALID');
    this.subjectSha256 = subjectSha256;
    this.lockPath = join(anchorDirectory, LOCK_BASENAME);
  }

  private async assertDirectory(): Promise<void> {
    try {
      const stat = await lstat(this.anchorDirectory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== currentUid() ||
        (stat.mode & 0o777) !== MODE_0700
      )
        fail('DIRECTORY_UNSAFE');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError) throw error;
      fail('DIRECTORY_UNSAFE');
    }
  }

  async assertIndependent(input: {
    readonly stateDirectory: string;
    readonly requestSha256: string;
    readonly creationReceiptSha256: string;
  }): Promise<void> {
    if (
      !isAbsolute(input.stateDirectory) ||
      input.requestSha256 !== this.requestSha256 ||
      input.creationReceiptSha256 !== this.creationReceiptSha256
    )
      fail('BINDING_INVALID');
    await this.assertDirectory();
    try {
      const anchorReal = await realpath(this.anchorDirectory);
      const stateReal = await realpath(input.stateDirectory);
      const within = (parent: string, child: string): boolean => {
        const value = relative(parent, child);
        return value === '' || (!value.startsWith('..') && !isAbsolute(value));
      };
      const [anchorStat, stateStat] = await Promise.all([lstat(anchorReal), lstat(stateReal)]);
      if (
        anchorReal !== resolve(anchorReal) ||
        stateReal !== resolve(stateReal) ||
        within(anchorReal, stateReal) ||
        within(stateReal, anchorReal) ||
        sameStat(anchorStat, stateStat)
      )
        fail('BINDING_INVALID');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError) throw error;
      fail('BINDING_INVALID');
    }
  }

  private async fsyncDirectory(): Promise<void> {
    try {
      const directory = await open(this.anchorDirectory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      fail('WRITE_FAILED');
    }
  }

  private async readExact(path: string): Promise<string> {
    try {
      const first = await lstat(path);
      if (!regular0600(first) || first.size < 1 || first.size > MAX_ANCHOR_BYTES)
        fail('FILE_UNSAFE');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameStat(first, opened) || opened.size < 1 || opened.size > MAX_ANCHOR_BYTES)
          fail('FILE_UNSAFE');
        const value = await handle.readFile({ encoding: 'utf8' });
        const after = await lstat(path);
        if (!sameStat(first, after)) fail('FILE_UNSAFE');
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError) throw error;
      fail('FILE_UNSAFE');
    }
  }

  private fileName(value: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation): string {
    return `${ANCHOR_PREFIX}-${String(value.phaseIndex).padStart(2, '0')}-${value.phase.toLowerCase()}-${value.envelopeSha256}.json`;
  }

  private async readAll(): Promise<
    readonly CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation[]
  > {
    await this.assertDirectory();
    let names: string[];
    try {
      names = (await readdir(this.anchorDirectory)).filter((name) =>
        name.startsWith(`${ANCHOR_PREFIX}-`),
      );
    } catch {
      fail('DIRECTORY_UNSAFE');
    }
    if (names.length > COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_PHASES.length)
      fail('ANCHOR_CORRUPT');
    const byIndex = new Map<number, string>();
    for (const name of names) {
      const match = anchorName.exec(name);
      if (match === null) fail('ANCHOR_CORRUPT');
      const index = Number(match[1]);
      if (byIndex.has(index)) fail('ANCHOR_CORRUPT');
      byIndex.set(index, name);
    }
    const values: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation[] = [];
    for (let index = 0; index < byIndex.size; index += 1) {
      const name = byIndex.get(index);
      if (name === undefined) fail('ANCHOR_CORRUPT');
      const value = parseObservation(await this.readExact(join(this.anchorDirectory, name)));
      const previous = values.at(-1) ?? null;
      if (
        value.requestSha256 !== this.requestSha256 ||
        value.creationReceiptSha256 !== this.creationReceiptSha256 ||
        value.phaseIndex !== index ||
        name !== this.fileName(value) ||
        value.previousEnvelopeSha256 !== (previous?.envelopeSha256 ?? null)
      )
        fail('ANCHOR_CORRUPT');
      values.push(value);
    }
    return values;
  }

  async observe(): Promise<CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null> {
    return (await this.readAll()).at(-1) ?? null;
  }

  private async acquireLock(): Promise<{ readonly token: string; readonly handle: FileHandle }> {
    const token = randomBytes(32).toString('hex');
    try {
      const handle = await open(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      );
      try {
        await handle.writeFile(`${token}\n`, 'utf8');
        await handle.sync();
        await this.fsyncDirectory();
        return { token, handle };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch {
      fail('LOCK_UNAVAILABLE');
    }
  }

  private async releaseLock(lock: {
    readonly token: string;
    readonly handle: FileHandle;
  }): Promise<void> {
    try {
      await lock.handle.close();
      if ((await this.readExact(this.lockPath)) !== `${lock.token}\n`) fail('LOCK_LOST');
      await unlink(this.lockPath);
      await this.fsyncDirectory();
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3ExternalPhaseAnchorError) throw error;
      fail('LOCK_RELEASE_FAILED');
    }
  }

  async advance(input: {
    readonly expected: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null;
    readonly next: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation;
  }): Promise<void> {
    assertCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(input.next);
    if (
      input.next.requestSha256 !== this.requestSha256 ||
      input.next.creationReceiptSha256 !== this.creationReceiptSha256 ||
      input.next.phaseIndex !== (input.expected?.phaseIndex ?? -1) + 1 ||
      input.next.previousEnvelopeSha256 !== (input.expected?.envelopeSha256 ?? null)
    )
      fail('ANCHOR_CONFLICT');
    const lock = await this.acquireLock();
    let operationError: unknown;
    try {
      if (!isDeepStrictEqual(await this.observe(), input.expected)) fail('ANCHOR_CONFLICT');
      const canonical = canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(
        input.next,
      );
      const path = join(this.anchorDirectory, this.fileName(input.next));
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      ).catch(() => fail('ANCHOR_CONFLICT'));
      try {
        await handle.writeFile(canonical, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fsyncDirectory();
      if ((await this.readExact(path)) !== canonical) fail('WRITE_FAILED');
      if (!isDeepStrictEqual(await this.observe(), input.next)) fail('WRITE_FAILED');
    } catch (error) {
      operationError = error;
    }
    try {
      await this.releaseLock(lock);
    } catch (error) {
      if (operationError === undefined) throw error;
      fail('LOCK_RELEASE_FAILED');
    }
    if (operationError instanceof Error) throw operationError;
    if (operationError !== undefined) fail('WRITE_FAILED');
  }
}
