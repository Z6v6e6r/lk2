/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
} from '@phub/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommunitiesStagingRoleSplitV3DurableRestoreCoordinator,
  type CommunitiesStagingRoleSplitV3RestoreRunner,
  type CommunitiesStagingRoleSplitV3StateCasResult,
} from './communities-staging-role-split-v3-durable-restore-coordinator.js';
import {
  createCommunitiesStagingRoleSplitV3Fixture,
  fixtureSha,
} from './communities-staging-role-split-v3-test-fixtures.js';

const fixture = createCommunitiesStagingRoleSplitV3Fixture();
let root = '';
let archivePath = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phub-v3-durable-restore-'));
  archivePath = join(root, 'archive.dump');
  await writeFile(archivePath, 'archive', { mode: 0o600, flag: 'wx' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: false });
});

function scenario(
  casResults: CommunitiesStagingRoleSplitV3StateCasResult[] = ['advanced', 'advanced'],
) {
  const cas = vi.fn(async () => casResults.shift() ?? 'conflict');
  const fence = {
    subjectSha256: fixture.executionAuthorization.components.ddlFenceSha256,
    assertHeld: vi.fn(async () => undefined),
  };
  const run = vi.fn<CommunitiesStagingRoleSplitV3RestoreRunner['run']>(async () => undefined);
  const runner: CommunitiesStagingRoleSplitV3RestoreRunner = {
    subjectSha256: fixture.executionAuthorization.components.runnerAdapterSha256,
    run,
  };
  const archiveCustody = {
    subjectSha256: fixture.executionAuthorization.components.archiveCustodySha256,
    openArchive: vi.fn(async () => open(archivePath, 'r')),
  };
  const config = {
    request: structuredClone(fixture.request),
    cloneCreationAuthorization: structuredClone(fixture.cloneCreationAuthorization),
    preparationEnvelope: structuredClone(fixture.preparationEnvelope),
    restoreAuthorization: structuredClone(fixture.restoreAuthorization),
    hostAuthorization: structuredClone(fixture.hostAuthorization),
    durableRestoreAuthorization: structuredClone(fixture.durableRestoreAuthorization),
    expectedDurableRestoreAuthorizationSha256:
      communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(
        fixture.durableRestoreAuthorization,
      ),
    executionAuthorization: structuredClone(fixture.executionAuthorization),
    expectedExecutionAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
      fixture.executionAuthorization,
    ),
    ownedEnvelope: structuredClone(fixture.ownedEnvelope),
    restorePendingEnvelope: structuredClone(fixture.restorePendingEnvelope),
    restoredEnvelope: structuredClone(fixture.restoredEnvelope),
    stateStore: {
      subjectSha256: fixture.executionAuthorization.components.stateStoreSha256,
      compareAndSwap: cas,
    },
    archiveCustody,
    runner,
    fence,
  };
  const coordinator = new CommunitiesStagingRoleSplitV3DurableRestoreCoordinator(config);
  const input = {
    lease: { requestSha256: fixture.requestSha256, fencingToken: fixtureSha('lease') },
    current: fixture.ownedState,
    pending: fixture.restorePendingState,
    restored: fixture.restoredState,
  };
  return { coordinator, input, config, cas, fence, run, runner, archiveCustody };
}

describe('V3 durable restore coordinator', () => {
  it('creates and consumes the one-shot edge only after the successful pending CAS', async () => {
    const current = scenario();
    await expect(current.coordinator.restoreOwned(current.input)).resolves.toBeUndefined();
    expect(current.cas).toHaveBeenCalledTimes(2);
    expect(current.run).toHaveBeenCalledTimes(1);
    expect(current.fence.assertHeld).toHaveBeenCalledTimes(5);
    await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(current.run).toHaveBeenCalledTimes(1);
    expect(current.archiveCustody.openArchive).toHaveBeenCalledTimes(1);
  });

  it('does not reach the archive runner after a conflict or ambiguous pending write', async () => {
    for (const result of ['conflict', 'ambiguous'] as const) {
      const current = scenario([result]);
      await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
        code: result === 'conflict' ? 'STATE_WRITE_CONFLICT' : 'STATE_WRITE_AMBIGUOUS',
      });
      expect(current.run).not.toHaveBeenCalled();
      expect(current.cas).toHaveBeenCalledTimes(1);
    }
  });

  it('maps a thrown CAS result to an ambiguous durable write without reaching the runner', async () => {
    const current = scenario();
    current.cas.mockRejectedValueOnce(new Error('private store detail'));
    await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
      code: 'STATE_WRITE_AMBIGUOUS',
      message: 'COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_STATE_WRITE_AMBIGUOUS',
    });
    expect(current.run).not.toHaveBeenCalled();
  });

  it('retains consumed capability after a lost restore result and never retries in-process', async () => {
    const current = scenario(['advanced']);
    current.run.mockRejectedValueOnce(new Error('response lost'));
    await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
      code: 'RESTORE_OUTCOME_AMBIGUOUS',
    });
    await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
    expect(current.run).toHaveBeenCalledTimes(1);
    expect(current.cas).toHaveBeenCalledTimes(1);
  });

  it('detects archive mutation between restore and the restored-state CAS', async () => {
    const current = scenario(['advanced']);
    current.run.mockImplementationOnce(async () => {
      await writeFile(archivePath, 'changed');
    });
    await expect(current.coordinator.restoreOwned(current.input)).rejects.toMatchObject({
      code: 'ARCHIVE_CHANGED',
    });
    expect(current.cas).toHaveBeenCalledTimes(1);
  });

  it('uses only its immutable authorization and collaborator snapshot after construction', async () => {
    const current = scenario();
    (
      current.config.executionAuthorization as unknown as { cloneDatabaseOid: string }
    ).cloneDatabaseOid = '99999';
    (current.config.request as unknown as { backupSha256: string }).backupSha256 =
      fixtureSha('substituted-backup');
    const substitutedRun = vi.fn(async () => undefined);
    current.runner.run = substitutedRun;

    await expect(current.coordinator.restoreOwned(current.input)).resolves.toBeUndefined();
    expect(substitutedRun).not.toHaveBeenCalled();
    expect(current.run).toHaveBeenCalledWith(
      expect.objectContaining({
        cloneDatabaseOid: fixture.executionAuthorization.cloneDatabaseOid,
        request: fixture.request,
      }),
    );
  });
});
