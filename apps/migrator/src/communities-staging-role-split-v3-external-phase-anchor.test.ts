import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION,
  CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor,
  canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
  type CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
} from './communities-staging-role-split-v3-external-phase-anchor.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const requestSha256 = sha('request');
const receiptSha256 = sha('receipt');
const subjectSha256 = sha('external-anchor-subject');

function observation(
  phaseIndex: number,
  phase: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation['phase'],
  previousEnvelopeSha256: string | null,
): CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION,
    requestSha256,
    creationReceiptSha256: receiptSha256,
    phaseIndex,
    phase,
    envelopeSha256: sha(`envelope:${phase}`),
    previousEnvelopeSha256,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phub-v3-external-anchor-'));
  await chmod(directory, 0o700);
  return {
    directory,
    anchor: new CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor(
      subjectSha256,
      directory,
      requestSha256,
      receiptSha256,
    ),
  };
}

describe('V3 external monotonic phase anchor', () => {
  it('publishes only the exact append-only forward phase chain', async () => {
    const { directory, anchor } = await fixture();
    const owned = observation(0, 'OWNED', null);
    const pending = observation(1, 'RESTORE_PENDING', owned.envelopeSha256);

    await anchor.advance({ expected: null, next: owned });
    await anchor.advance({ expected: owned, next: pending });

    expect(await anchor.observe()).toEqual(pending);
    expect(
      await readFile(
        join(
          directory,
          `v3-external-phase-anchor-01-restore_pending-${pending.envelopeSha256}.json`,
        ),
        'utf8',
      ),
    ).toBe(canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(pending));
  });

  it('rejects replay, skipped phase and changed predecessor without replacing an anchor', async () => {
    const { anchor } = await fixture();
    const owned = observation(0, 'OWNED', null);
    await anchor.advance({ expected: null, next: owned });

    await expect(anchor.advance({ expected: null, next: owned })).rejects.toMatchObject({
      code: 'ANCHOR_CONFLICT',
    });
    await expect(
      anchor.advance({
        expected: owned,
        next: observation(2, 'RESTORED', owned.envelopeSha256),
      }),
    ).rejects.toMatchObject({ code: 'ANCHOR_CONFLICT' });
    await expect(
      anchor.advance({
        expected: owned,
        next: observation(1, 'RESTORE_PENDING', sha('different predecessor')),
      }),
    ).rejects.toMatchObject({ code: 'ANCHOR_CONFLICT' });
    expect(await anchor.observe()).toEqual(owned);
  });

  it('fails closed on a partial published anchor and on a retained lock', async () => {
    const { directory, anchor } = await fixture();
    const owned = observation(0, 'OWNED', null);
    await writeFile(
      join(directory, `v3-external-phase-anchor-00-owned-${owned.envelopeSha256}.json`),
      '{',
      { mode: 0o600 },
    );
    await expect(anchor.observe()).rejects.toMatchObject({ code: 'ANCHOR_CORRUPT' });

    const locked = await fixture();
    await writeFile(join(locked.directory, 'v3-external-phase-anchor.lock'), `${sha('lock')}\n`, {
      mode: 0o600,
    });
    await expect(locked.anchor.advance({ expected: null, next: owned })).rejects.toMatchObject({
      code: 'LOCK_UNAVAILABLE',
    });
  });

  it('rejects unsafe custody and linked anchor files', async () => {
    const unsafe = await fixture();
    await chmod(unsafe.directory, 0o755);
    await expect(unsafe.anchor.observe()).rejects.toMatchObject({ code: 'DIRECTORY_UNSAFE' });

    const linked = await fixture();
    const owned = observation(0, 'OWNED', null);
    const external = join(linked.directory, 'external');
    await writeFile(
      external,
      canonicalCommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation(owned),
      {
        mode: 0o600,
      },
    );
    await symlink(
      external,
      join(linked.directory, `v3-external-phase-anchor-00-owned-${owned.envelopeSha256}.json`),
    );
    await expect(linked.anchor.observe()).rejects.toMatchObject({ code: 'FILE_UNSAFE' });
  });

  it('requires custody outside the durable state directory and rejects reordered canonical bytes', async () => {
    const separated = await fixture();
    const stateDirectory = await mkdtemp(join(tmpdir(), 'phub-v3-state-for-anchor-'));
    await chmod(stateDirectory, 0o700);
    await expect(
      separated.anchor.assertIndependent({
        stateDirectory,
        requestSha256,
        creationReceiptSha256: receiptSha256,
      }),
    ).resolves.toBeUndefined();
    await expect(
      separated.anchor.assertIndependent({
        stateDirectory: separated.directory,
        requestSha256,
        creationReceiptSha256: receiptSha256,
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });

    const reordered = await fixture();
    const owned = observation(0, 'OWNED', null);
    await writeFile(
      join(reordered.directory, `v3-external-phase-anchor-00-owned-${owned.envelopeSha256}.json`),
      `${JSON.stringify({
        requestSha256: owned.requestSha256,
        schemaVersion: owned.schemaVersion,
        creationReceiptSha256: owned.creationReceiptSha256,
        phaseIndex: owned.phaseIndex,
        phase: owned.phase,
        envelopeSha256: owned.envelopeSha256,
        previousEnvelopeSha256: owned.previousEnvelopeSha256,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(reordered.anchor.observe()).rejects.toMatchObject({ code: 'ANCHOR_CORRUPT' });
  });
});
