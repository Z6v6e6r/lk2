/** Unwired Linux-only, descriptor-pinned pg_restore boundary. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const PREFLIGHT_ABORT_GRACE_MS = 2_000;
const TERM_GRACE_MS = 2_000;
const TERMINATION_CONFIRM_MS = 2_000;

export class CommunitiesStagingRoleSplitPgRestoreRunnerError extends Error {
  constructor(readonly code: string) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_PG_RESTORE_${code}`);
    this.name = 'CommunitiesStagingRoleSplitPgRestoreRunnerError';
  }
}

function fail(code: string): never {
  throw new CommunitiesStagingRoleSplitPgRestoreRunnerError(code);
}

const isName = (value: string) => /^[a-z_][a-z0-9_]{0,62}$/.test(value);
const isOid = (value: string) => /^[1-9][0-9]*$/.test(value);
const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1';

export interface CommunitiesStagingRoleSplitPgRestoreTarget {
  readonly database: string;
  readonly databaseOid: string;
  readonly sourceDatabase: string;
  readonly systemIdentifier: string;
  readonly postgresMajor: '16';
  readonly connectionUser: string;
  readonly connectionUserOid: string;
  readonly restoreRole: string;
  readonly restoreRoleOid: string;
  readonly host: string;
  readonly port: string;
  readonly sslMode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
}

export interface CommunitiesStagingRoleSplitPgRestorePreflightObservation {
  readonly database: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
  readonly postgresMajor: string;
  readonly sessionUser: string;
  readonly sessionUserOid: string;
  readonly currentUser: string;
  readonly currentUserOid: string;
}

export interface CommunitiesStagingRoleSplitPgRestoreRunnerConfig {
  readonly target: CommunitiesStagingRoleSplitPgRestoreTarget;
  /** Must use the same fixed clone-only connection factory as the restore command. */
  readonly preflight: (
    target: CommunitiesStagingRoleSplitPgRestoreTarget,
    signal: AbortSignal,
  ) => Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation>;
  /** SHA-256 of the reviewed root-owned executable supplied as executableFile. */
  readonly expectedPgRestoreSha256: string;
  readonly timeoutMs: number;
  readonly preflightTimeoutMs?: number;
}

export interface CommunitiesStagingRoleSplitPgRestoreResult {
  readonly discardedOutputBytes: number;
}

type Child = ReturnType<typeof spawn>;

function currentUid(): number {
  if (process.getuid === undefined) fail('PLATFORM_UNSUPPORTED');
  return process.getuid();
}

function currentGid(): number {
  if (process.getgid === undefined) fail('PLATFORM_UNSUPPORTED');
  return process.getgid();
}

function assertLinux(): void {
  if (process.platform !== 'linux') fail('PLATFORM_UNSUPPORTED');
}

function assertTarget(target: CommunitiesStagingRoleSplitPgRestoreTarget): void {
  const sslModes = new Set(['disable', 'require', 'verify-ca', 'verify-full']);
  if (
    !isName(target.database) ||
    !isName(target.sourceDatabase) ||
    target.database === target.sourceDatabase ||
    !isOid(target.databaseOid) ||
    !/^[0-9]{10,32}$/.test(target.systemIdentifier) ||
    target.postgresMajor !== '16' ||
    !isName(target.connectionUser) ||
    !isOid(target.connectionUserOid) ||
    !isName(target.restoreRole) ||
    !isOid(target.restoreRoleOid) ||
    !/^[A-Za-z0-9._:-]{1,255}$/.test(target.host) ||
    !/^[1-9][0-9]{0,4}$/.test(target.port) ||
    Number(target.port) > 65535 ||
    !sslModes.has(target.sslMode) ||
    (!isLoopback(target.host) && target.sslMode !== 'verify-full')
  )
    fail('TARGET_CONFIG_INVALID');
}

function assertObservation(
  target: CommunitiesStagingRoleSplitPgRestoreTarget,
  observation: CommunitiesStagingRoleSplitPgRestorePreflightObservation,
): void {
  if (
    observation.database !== target.database ||
    observation.database === target.sourceDatabase ||
    observation.databaseOid !== target.databaseOid ||
    observation.systemIdentifier !== target.systemIdentifier ||
    observation.postgresMajor !== '16' ||
    observation.sessionUser !== target.connectionUser ||
    observation.sessionUserOid !== target.connectionUserOid ||
    observation.currentUser !== target.restoreRole ||
    observation.currentUserOid !== target.restoreRoleOid
  )
    fail('TARGET_BINDING_INVALID');
}

async function descriptorFd(
  handle: FileHandle,
  code: string,
  options: { readonly maxBytes: number; readonly uid: number; readonly exactMode?: number },
): Promise<number> {
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) fail(code);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== options.uid ||
      stat.size <= 0 ||
      stat.size > options.maxBytes ||
      (options.exactMode === undefined
        ? (stat.mode & 0o6022) !== 0
        : (stat.mode & 0o777) !== options.exactMode)
    )
      fail(code);
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitPgRestoreRunnerError) throw error;
    fail(code);
  }
  return handle.fd;
}

/**
 * The archive descriptor crosses the final trust boundary into pg_restore.
 * It must be immutable to the non-root runtime for the complete restore, not
 * merely hash-equal at the instant before dispatch.
 */
export async function assertCommunitiesStagingRoleSplitImmutableArchiveDescriptor(
  handle: FileHandle,
  expectedBytes?: number,
): Promise<void> {
  assertLinux();
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0 || currentUid() === 0)
    fail('ARCHIVE_DESCRIPTOR_INVALID');
  try {
    const fdInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const flagLines = [...fdInfo.matchAll(/^flags:\s+([0-7]+)$/gmu)];
    const descriptorFlags =
      flagLines.length === 1 ? Number.parseInt(flagLines[0]![1]!, 8) : Number.NaN;
    const stat = await handle.stat();
    if (
      !Number.isSafeInteger(descriptorFlags) ||
      (descriptorFlags & 0o3) !== 0 ||
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.gid !== currentGid() ||
      (stat.mode & 0o777) !== 0o440 ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > MAX_ARCHIVE_BYTES ||
      (expectedBytes !== undefined && stat.size !== expectedBytes)
    )
      fail('ARCHIVE_DESCRIPTOR_INVALID');
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitPgRestoreRunnerError) throw error;
    fail('ARCHIVE_DESCRIPTOR_INVALID');
  }
}

async function sha256Handle(handle: FileHandle, maxBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) return hash.digest('hex');
    offset += bytesRead;
    if (offset > maxBytes) fail('PG_RESTORE_EXECUTABLE_UNSAFE');
    hash.update(buffer.subarray(0, bytesRead));
  }
}

async function runPreflight(
  config: CommunitiesStagingRoleSplitPgRestoreRunnerConfig,
): Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation> {
  const timeoutMs = config.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    fail('PREFLIGHT_TIMEOUT_INVALID');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let preflight: Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation>;
  try {
    preflight = Promise.resolve(config.preflight(config.target, controller.signal));
  } catch {
    fail('PREFLIGHT_UNAVAILABLE');
  }
  preflight.catch(() => undefined);
  let observation: CommunitiesStagingRoleSplitPgRestorePreflightObservation | undefined;
  try {
    observation = await Promise.race([
      preflight,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CommunitiesStagingRoleSplitPgRestoreRunnerError('PREFLIGHT_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (
      error instanceof CommunitiesStagingRoleSplitPgRestoreRunnerError &&
      error.code === 'PREFLIGHT_TIMEOUT'
    ) {
      controller.abort();
      const acknowledged = await Promise.race([
        preflight.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), PREFLIGHT_ABORT_GRACE_MS),
        ),
      ]);
      if (!acknowledged) fail('PREFLIGHT_TERMINATION_UNCONFIRMED');
      throw error;
    }
    if (error instanceof CommunitiesStagingRoleSplitPgRestoreRunnerError) throw error;
    fail('PREFLIGHT_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (observation === undefined) fail('PREFLIGHT_UNAVAILABLE');
  return observation;
}

function waitForChild(
  child: Child,
  timeoutMs: number,
): Promise<CommunitiesStagingRoleSplitPgRestoreResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let termination: 'TIMEOUT' | 'OUTPUT_LIMIT' | null = null;
    let discarded = 0;
    const timers: {
      timeout?: ReturnType<typeof setTimeout>;
      killTimer?: ReturnType<typeof setTimeout>;
      confirmTimer?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (result: CommunitiesStagingRoleSplitPgRestoreResult | null, code?: string) => {
      if (settled) return;
      settled = true;
      if (timers.timeout !== undefined) clearTimeout(timers.timeout);
      if (timers.killTimer !== undefined) clearTimeout(timers.killTimer);
      if (timers.confirmTimer !== undefined) clearTimeout(timers.confirmTimer);
      if (result === null) reject(new CommunitiesStagingRoleSplitPgRestoreRunnerError(code!));
      else resolve(result);
    };
    const terminate = (reason: 'TIMEOUT' | 'OUTPUT_LIMIT') => {
      if (settled || termination !== null) return;
      termination = reason;
      child.kill('SIGTERM');
      timers.killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        timers.confirmTimer = setTimeout(
          () => finish(null, 'TERMINATION_UNCONFIRMED'),
          TERMINATION_CONFIRM_MS,
        );
      }, TERM_GRACE_MS);
    };
    timers.timeout = setTimeout(() => terminate('TIMEOUT'), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'utf8');
      if (discarded + bytes > MAX_STDERR_BYTES) {
        discarded = MAX_STDERR_BYTES;
        terminate('OUTPUT_LIMIT');
      } else discarded += bytes;
    });
    child.on('error', () => {
      if (termination === null) finish(null, 'PROCESS_UNAVAILABLE');
    });
    child.once('close', (code, signal) => {
      if (termination !== null) finish(null, termination);
      else if (code === 0 && signal === null) finish({ discardedOutputBytes: discarded });
      else if (code === null) finish(null, 'RESPONSE_LOST');
      else finish(null, 'NONZERO_EXIT');
    });
  });
}

async function probeVersion(executableFd: number): Promise<void> {
  let child: Child;
  try {
    child = spawn('/proc/self/fd/4', ['--version'], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore', 'ignore', executableFd],
      shell: false,
    });
  } catch {
    fail('PG_RESTORE_VERSION_UNAVAILABLE');
  }
  const output: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    if (Buffer.concat(output).length < 256) output.push(chunk.subarray(0, 256));
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timers: {
      timeout?: ReturnType<typeof setTimeout>;
      kill?: ReturnType<typeof setTimeout>;
      confirm?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (code: string | null) => {
      if (settled) return;
      settled = true;
      if (timers.timeout !== undefined) clearTimeout(timers.timeout);
      if (timers.kill !== undefined) clearTimeout(timers.kill);
      if (timers.confirm !== undefined) clearTimeout(timers.confirm);
      if (code === null) resolve();
      else reject(new CommunitiesStagingRoleSplitPgRestoreRunnerError(code));
    };
    timers.timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      timers.kill = setTimeout(() => {
        child.kill('SIGKILL');
        timers.confirm = setTimeout(
          () => finish('TERMINATION_UNCONFIRMED'),
          TERMINATION_CONFIRM_MS,
        );
      }, TERM_GRACE_MS);
    }, PREFLIGHT_TIMEOUT_MS);
    child.on('error', () => {
      if (!timedOut) finish('PG_RESTORE_VERSION_UNAVAILABLE');
    });
    child.once('close', (code) => {
      if (timedOut) finish('PG_RESTORE_VERSION_UNAVAILABLE');
      else {
        const text = Buffer.concat(output).subarray(0, 256).toString('utf8');
        if (code === 0 && /^pg_restore \(PostgreSQL\) 16(?:\.|\s|$)/.test(text)) finish(null);
        else finish('PG_RESTORE_VERSION_INVALID');
      }
    });
  });
}

export async function runCommunitiesStagingRoleSplitPgRestore(
  config: CommunitiesStagingRoleSplitPgRestoreRunnerConfig,
  input: {
    readonly archiveFile: FileHandle;
    readonly passwordFile: FileHandle;
    readonly executableFile: FileHandle;
  },
): Promise<CommunitiesStagingRoleSplitPgRestoreResult> {
  assertLinux();
  assertTarget(config.target);
  if (!/^[a-f0-9]{64}$/.test(config.expectedPgRestoreSha256)) fail('PG_RESTORE_EXECUTABLE_UNSAFE');
  if (
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 30 * 60_000
  )
    fail('TIMEOUT_INVALID');
  await assertCommunitiesStagingRoleSplitImmutableArchiveDescriptor(input.archiveFile);
  const archiveFd = input.archiveFile.fd;
  const passwordFd = await descriptorFd(input.passwordFile, 'PASSWORD_DESCRIPTOR_INVALID', {
    maxBytes: MAX_PASSWORD_BYTES,
    uid: currentUid(),
    exactMode: 0o600,
  });
  const executableFd = await descriptorFd(input.executableFile, 'PG_RESTORE_EXECUTABLE_UNSAFE', {
    maxBytes: 256 * 1024 * 1024,
    uid: 0,
  });
  if (
    (await sha256Handle(input.executableFile, 256 * 1024 * 1024)) !== config.expectedPgRestoreSha256
  )
    fail('PG_RESTORE_EXECUTABLE_UNSAFE');
  await probeVersion(executableFd).catch((error: unknown) => {
    if (error instanceof CommunitiesStagingRoleSplitPgRestoreRunnerError) throw error;
    fail('PG_RESTORE_VERSION_UNAVAILABLE');
  });
  assertObservation(config.target, await runPreflight(config));
  let child: Child;
  try {
    child = spawn(
      '/proc/self/fd/4',
      [
        '--format=custom',
        '--exit-on-error',
        '--single-transaction',
        `--dbname=${config.target.database}`,
        `--host=${config.target.host}`,
        `--port=${config.target.port}`,
        `--username=${config.target.connectionUser}`,
        `--role=${config.target.restoreRole}`,
        '--no-password',
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          PGCONNECT_TIMEOUT: '10',
          PGHOST: config.target.host,
          PGPORT: config.target.port,
          PGUSER: config.target.connectionUser,
          PGSSLMODE: config.target.sslMode,
          PGPASSFILE: '/proc/self/fd/3',
        },
        stdio: [archiveFd, 'ignore', 'pipe', passwordFd, executableFd],
        shell: false,
      },
    );
  } catch {
    fail('PROCESS_UNAVAILABLE');
  }
  return await waitForChild(child, config.timeoutMs);
}
