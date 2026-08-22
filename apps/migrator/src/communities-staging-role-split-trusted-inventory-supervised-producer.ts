import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type {
  CommunitiesStagingRoleSplitInventoryPreparation,
  CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor } from '@phub/database';

import {
  assertCommunitiesStagingRoleSplitTrustedInventoryDescriptors,
  CommunitiesStagingRoleSplitTrustedInventoryFileOutputStore,
  runCommunitiesStagingRoleSplitTrustedInventory,
  type CommunitiesStagingRoleSplitTrustedInventoryCollector,
  type CommunitiesStagingRoleSplitTrustedInventoryCollectorOutcome,
} from './communities-staging-role-split-trusted-inventory-host.js';

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_CONFIRMATION_MILLIS = 2_000;

export class CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_INVALID'
      | 'DESCRIPTOR_INVALID'
      | 'STATE_INVALID'
      | 'PROCESS_UNAVAILABLE'
      | 'TERMINATION_FAILED'
      | 'TERMINATION_UNCONFIRMED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_SUPERVISED_PRODUCER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError';
  }
}

function fail(
  code: CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError['code'],
): never {
  throw new CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathSha256(path: string): string {
  return sha256(`${path}\n`);
}

function canonicalEvidencePath(path: string): boolean {
  const hasControlCharacter = [...path].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
  return path.startsWith('/') && resolve(path) === path && !hasControlCharacter;
}

function preparationPathSha256(
  preparation: CommunitiesStagingRoleSplitInventoryPreparation,
  code: 'MARKER_REQUEST' | 'MARKER_EVIDENCE' | 'ROLE_MAPPING',
): string {
  const entry = preparation.inputs.find((candidate) => candidate.code === code);
  if (!entry) fail('CONFIG_INVALID');
  return entry.pathSha256;
}

export type CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths = {
  readonly markerRequestPath: string;
  readonly markerEvidencePath: string;
  readonly roleMappingPath: string;
};

function assertEvidencePaths(input: {
  readonly preparation: CommunitiesStagingRoleSplitInventoryPreparation;
  readonly evidencePaths: CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths;
}): void {
  const paths = [
    input.evidencePaths.markerRequestPath,
    input.evidencePaths.markerEvidencePath,
    input.evidencePaths.roleMappingPath,
  ];
  if (
    paths.some((path) => !canonicalEvidencePath(path)) ||
    new Set(paths).size !== paths.length ||
    pathSha256(input.evidencePaths.markerRequestPath) !==
      preparationPathSha256(input.preparation, 'MARKER_REQUEST') ||
    pathSha256(input.evidencePaths.markerEvidencePath) !==
      preparationPathSha256(input.preparation, 'MARKER_EVIDENCE') ||
    pathSha256(input.evidencePaths.roleMappingPath) !==
      preparationPathSha256(input.preparation, 'ROLE_MAPPING')
  )
    fail('CONFIG_INVALID');
}

function producerEnvironment(
  descriptor: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  evidencePaths: CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths,
): NodeJS.ProcessEnv {
  const connection = `postgresql://${encodeURIComponent(descriptor.user)}@${descriptor.host}:${descriptor.port}/${encodeURIComponent(descriptor.database)}`;
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    DATABASE_URL: connection,
    PGHOST: descriptor.host,
    PGPORT: String(descriptor.port),
    PGDATABASE: descriptor.database,
    PGUSER: descriptor.user,
    PGSSLMODE: descriptor.sslMode,
    PGPASSFILE: '/proc/self/fd/3',
    PGCONNECT_TIMEOUT: String(descriptor.connectTimeoutMillis / 1_000),
    PGAPPNAME: descriptor.applicationName,
    PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${descriptor.statementTimeoutMillis} -c lock_timeout=${descriptor.lockTimeoutMillis}`,
    COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION:
      'PRODUCE_COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_V1',
    PHUB_ROLE_SPLIT_MARKER_REQUEST_PATH: evidencePaths.markerRequestPath,
    PHUB_ROLE_SPLIT_MARKER_REQUEST_SHA256: descriptor.markerRequestSha256,
    PHUB_ROLE_SPLIT_MARKER_EVIDENCE_PATH: evidencePaths.markerEvidencePath,
    PHUB_ROLE_SPLIT_MARKER_EVIDENCE_SHA256: descriptor.markerEvidenceSha256,
    PHUB_ROLE_SPLIT_ROLE_MAPPING_PATH: evidencePaths.roleMappingPath,
    PHUB_ROLE_SPLIT_ROLE_MAPPING_SHA256: descriptor.roleMappingSha256,
  };
}

class SupervisedProducerCollector implements CommunitiesStagingRoleSplitTrustedInventoryCollector {
  private child: ChildProcess | null = null;
  private state: 'IDLE' | 'RUNNING' | 'FINISHED' = 'IDLE';
  private killConfirmation: ReturnType<typeof setTimeout> | undefined;
  private rejectRun: ((error: Error) => void) | undefined;
  private readonly deliveredSignals = new Set<'SIGTERM' | 'SIGKILL'>();

  constructor(
    private readonly evidencePaths: CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths,
  ) {}

  run(input: Parameters<CommunitiesStagingRoleSplitTrustedInventoryCollector['run']>[0]) {
    if (this.state !== 'IDLE') fail('STATE_INVALID');
    try {
      assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
        input.connectionDescriptor,
      );
    } catch {
      fail('CONFIG_INVALID');
    }
    if (
      input.signal.aborted ||
      !Number.isSafeInteger(input.credentialFile.fd) ||
      input.credentialFile.fd < 0 ||
      !Number.isSafeInteger(input.producerFile.fd) ||
      input.producerFile.fd < 0 ||
      input.credentialFile.fd === input.producerFile.fd
    )
      fail('DESCRIPTOR_INVALID');

    this.state = 'RUNNING';
    try {
      this.child = spawn(
        '/proc/self/exe',
        ['--experimental-default-type=module', '--disable-proto=throw', '/proc/self/fd/4'],
        {
          cwd: '/',
          env: producerEnvironment(input.connectionDescriptor, this.evidencePaths),
          stdio: ['ignore', 'pipe', 'pipe', input.credentialFile.fd, input.producerFile.fd],
          detached: true,
          shell: false,
          uid: 0,
          gid: 0,
          windowsHide: true,
        },
      );
    } catch {
      this.state = 'FINISHED';
      fail('PROCESS_UNAVAILABLE');
    }
    const child = this.child;
    if (!child.stdout || !child.stderr || !Number.isSafeInteger(child.pid) || child.pid! < 1) {
      this.state = 'FINISHED';
      this.child = null;
      fail('PROCESS_UNAVAILABLE');
    }

    return new Promise<CommunitiesStagingRoleSplitTrustedInventoryCollectorOutcome>(
      (resolveRun, rejectRun) => {
        this.rejectRun = rejectRun;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let forcedFailure = false;
        let processError = false;
        const abort = () => void this.terminate('SIGTERM').catch(() => undefined);
        const forceOutputFailure = () => {
          if (forcedFailure) return;
          forcedFailure = true;
          void this.terminate('SIGKILL').catch(() => undefined);
        };
        input.signal.addEventListener('abort', abort, { once: true });
        child.stdout!.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
          stdoutBytes += bytes.length;
          if (stdoutBytes > MAX_STDOUT_BYTES) forceOutputFailure();
          else stdout.push(bytes);
        });
        child.stderr!.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
          stderrBytes += bytes.length;
          if (stderrBytes > MAX_STDERR_BYTES) forceOutputFailure();
          else stderr.push(bytes);
        });
        child.once('error', () => {
          processError = true;
          if (!Number.isSafeInteger(child.pid) || child.pid! < 1) {
            this.finish();
            input.signal.removeEventListener('abort', abort);
            rejectRun(
              new CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError(
                'PROCESS_UNAVAILABLE',
              ),
            );
          }
        });
        child.once('close', (exitCode, signal) => {
          this.finish();
          input.signal.removeEventListener('abort', abort);
          resolveRun({
            exitCode: forcedFailure || processError ? 1 : exitCode,
            signal,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
        });
      },
    );
  }

  terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    try {
      const child = this.child;
      if (this.state !== 'RUNNING' || child === null) return Promise.resolve();
      if (this.deliveredSignals.has(signal)) return Promise.resolve();
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid! < 1) fail('TERMINATION_FAILED');
      this.deliveredSignals.add(signal);
      try {
        process.kill(-pid!, signal);
      } catch {
        if (signal === 'SIGKILL') this.rejectUnconfirmedTermination();
        fail('TERMINATION_FAILED');
      }
      if (signal === 'SIGKILL') {
        this.killConfirmation = setTimeout(
          () => this.rejectUnconfirmedTermination(),
          KILL_CONFIRMATION_MILLIS,
        );
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('TERMINATION_FAILED'));
    }
  }

  private rejectUnconfirmedTermination(): void {
    if (this.state !== 'RUNNING') return;
    this.finish();
    this.rejectRun?.(
      new CommunitiesStagingRoleSplitTrustedInventorySupervisedProducerError(
        'TERMINATION_UNCONFIRMED',
      ),
    );
  }

  private finish(): void {
    if (this.killConfirmation !== undefined) clearTimeout(this.killConfirmation);
    this.killConfirmation = undefined;
    this.child = null;
    this.state = 'FINISHED';
  }
}

export function createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer(input: {
  readonly preparation: CommunitiesStagingRoleSplitInventoryPreparation;
  readonly evidencePaths: CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths;
}): CommunitiesStagingRoleSplitTrustedInventoryCollector {
  assertEvidencePaths(input);
  return new SupervisedProducerCollector(input.evidencePaths);
}

type TrustedInventoryHostInput = Parameters<
  typeof runCommunitiesStagingRoleSplitTrustedInventory
>[0];

export async function runCommunitiesStagingRoleSplitTrustedInventoryWithSupervisedProducer(
  input: Omit<TrustedInventoryHostInput, 'collector' | 'outputStore' | 'validateDescriptors'> & {
    readonly evidencePaths: CommunitiesStagingRoleSplitTrustedInventoryProducerEvidencePaths;
  },
) {
  const { evidencePaths, ...hostInput } = input;
  const collector = createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer({
    preparation: hostInput.preparation,
    evidencePaths,
  });
  const outputStore = new CommunitiesStagingRoleSplitTrustedInventoryFileOutputStore(
    hostInput.outputDirectoryPath,
    hostInput.outputArtifactPath,
    hostInput.outputReceiptPath,
  );
  return runCommunitiesStagingRoleSplitTrustedInventory({
    ...hostInput,
    collector,
    outputStore,
    validateDescriptors: assertCommunitiesStagingRoleSplitTrustedInventoryDescriptors,
  });
}
