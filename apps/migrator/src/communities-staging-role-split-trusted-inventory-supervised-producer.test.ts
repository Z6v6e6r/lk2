import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import type {
  CommunitiesStagingRoleSplitInventoryPreparation,
  CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
} from '@phub/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer } from './communities-staging-role-split-trusted-inventory-supervised-producer.js';

const spawnMock = vi.mocked(spawn);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const evidencePaths = {
  markerRequestPath: '/evidence/marker-request.json',
  markerEvidencePath: '/evidence/marker-evidence.json',
  roleMappingPath: '/evidence/role-mapping.json',
} as const;

const preparation = {
  inputs: [
    {
      code: 'MARKER_REQUEST',
      pathSha256: sha256(`${evidencePaths.markerRequestPath}\n`),
    },
    {
      code: 'MARKER_EVIDENCE',
      pathSha256: sha256(`${evidencePaths.markerEvidencePath}\n`),
    },
    {
      code: 'ROLE_MAPPING',
      pathSha256: sha256(`${evidencePaths.roleMappingPath}\n`),
    },
  ],
} as unknown as CommunitiesStagingRoleSplitInventoryPreparation;

const connectionDescriptor = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-connection-v1',
  sourceKind: 'INDEPENDENTLY_SOURCED_CLEAN_CLONE',
  host: 'postgres',
  port: 5432,
  database: 'phub_restore_123_4',
  user: 'inventory_reader',
  sslMode: 'disable',
  passwordTransport: 'FD_3',
  defaultTransactionReadOnly: true,
  applicationName: 'phub-communities-role-split-input-c-v1',
  connectTimeoutMillis: 10_000,
  statementTimeoutMillis: 30_000,
  lockTimeoutMillis: 5_000,
  markerRequestSha256: sha256('request'),
  markerEvidenceSha256: sha256('evidence'),
  roleMappingSha256: sha256('mapping'),
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;

function fakeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function collector() {
  return createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer({
    preparation,
    evidencePaths,
  });
}

function runInput(overrides: Partial<{ credentialFd: number; producerFd: number }> = {}) {
  return {
    signal: new AbortController().signal,
    credentialFile: { fd: overrides.credentialFd ?? 11 } as FileHandle,
    producerFile: { fd: overrides.producerFd ?? 12 } as FileHandle,
    connectionDescriptor,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe('trusted role-split inventory supervised producer composition', () => {
  it('spawns one pinned bundle through the current Node runtime with exact FD and read-only environment bindings', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);
    const running = collector().run(runInput());
    child.stdout.write('canonical inventory');
    child.emit('close', 0, null);

    await expect(running).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from('canonical inventory'),
      stderr: Buffer.alloc(0),
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/proc/self/exe',
      ['--experimental-default-type=module', '--disable-proto=throw', '/proc/self/fd/4'],
      expect.objectContaining({
        cwd: '/',
        detached: true,
        shell: false,
        uid: 0,
        gid: 0,
        stdio: ['ignore', 'pipe', 'pipe', 11, 12],
      }),
    );
    const environment = spawnMock.mock.calls[0]?.[2]?.env;
    expect(environment).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      DATABASE_URL: 'postgresql://inventory_reader@postgres:5432/phub_restore_123_4',
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGDATABASE: 'phub_restore_123_4',
      PGUSER: 'inventory_reader',
      PGSSLMODE: 'disable',
      PGPASSFILE: '/proc/self/fd/3',
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'phub-communities-role-split-input-c-v1',
      PGOPTIONS:
        '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
      COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION:
        'PRODUCE_COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_V1',
      PHUB_ROLE_SPLIT_MARKER_REQUEST_PATH: evidencePaths.markerRequestPath,
      PHUB_ROLE_SPLIT_MARKER_REQUEST_SHA256: connectionDescriptor.markerRequestSha256,
      PHUB_ROLE_SPLIT_MARKER_EVIDENCE_PATH: evidencePaths.markerEvidencePath,
      PHUB_ROLE_SPLIT_MARKER_EVIDENCE_SHA256: connectionDescriptor.markerEvidenceSha256,
      PHUB_ROLE_SPLIT_ROLE_MAPPING_PATH: evidencePaths.roleMappingPath,
      PHUB_ROLE_SPLIT_ROLE_MAPPING_SHA256: connectionDescriptor.roleMappingSha256,
    });
    expect(JSON.stringify(environment)).not.toMatch(/password|secret|token/iu);
  });

  it('rejects path drift and control characters before spawn', () => {
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer({
        preparation,
        evidencePaths: { ...evidencePaths, markerRequestPath: '/evidence/different.json' },
      }),
    ).toThrow(/CONFIG_INVALID/u);
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventorySupervisedProducer({
        preparation,
        evidencePaths: { ...evidencePaths, markerRequestPath: '/evidence/marker\nrequest.json' },
      }),
    ).toThrow(/CONFIG_INVALID/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted run or aliased credential and producer descriptors before spawn', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(() => collector().run({ ...runInput(), signal: aborted.signal })).toThrow(
      /DESCRIPTOR_INVALID/u,
    );
    expect(() => collector().run(runInput({ credentialFd: 11, producerFd: 11 }))).toThrow(
      /DESCRIPTOR_INVALID/u,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('revalidates the canonical connection descriptor before it can construct the child environment', () => {
    expect(() =>
      collector().run({
        ...runInput(),
        connectionDescriptor: {
          ...connectionDescriptor,
          statementTimeoutMillis: 30_001,
        } as never,
      }),
    ).toThrow(/CONFIG_INVALID/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('signals the dedicated process group and confirms close after TERM escalation', async () => {
    const child = fakeChild();
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    spawnMock.mockReturnValue(child as never);
    const composed = collector();
    const running = composed.run(runInput());

    await composed.terminate('SIGTERM');
    await composed.terminate('SIGTERM');
    await composed.terminate('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(running).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' });
    expect(signal.mock.calls).toEqual([
      [-4321, 'SIGTERM'],
      [-4321, 'SIGKILL'],
    ]);
  });

  it('fails closed when SIGKILL cannot be confirmed', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    spawnMock.mockReturnValue(child as never);
    const composed = collector();
    const running = composed.run(runInput());
    const rejection = expect(running).rejects.toThrow(/TERMINATION_UNCONFIRMED/u);

    await composed.terminate('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });

  it('kills an output-flooding producer without retaining its excess stderr', async () => {
    const child = fakeChild();
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    spawnMock.mockReturnValue(child as never);
    const running = collector().run(runInput());
    child.stderr.write(Buffer.alloc(64 * 1024 + 1));
    child.emit('close', null, 'SIGKILL');

    await expect(running).resolves.toMatchObject({ exitCode: 1, signal: 'SIGKILL' });
    expect(signal).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('refuses collector replay after the supervised process has completed', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);
    const composed = collector();
    const first = composed.run(runInput());
    child.emit('close', 0, null);
    await first;

    expect(() => composed.run(runInput())).toThrow(/STATE_INVALID/u);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
