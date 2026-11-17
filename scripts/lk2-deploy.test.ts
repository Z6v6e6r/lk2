import { describe, expect, it } from 'vitest';

import {
  buildV5Request,
  confirmationFor,
  mountLeaks,
  planVerdict,
  pinVerdict,
  releaseId,
} from './lk2-deploy.js';

const goodMount = { count: 0, sameRoot: true };
const goodPlan = {
  mount: goodMount,
  pin: 'ok',
  artifactPresent: true,
  artifactDigestMismatch: false,
  backupPresent: true,
  backupFresh: true,
  backupExpired: false,
  lockPresent: false,
};

describe('lk2-deploy plan', () => {
  it('accepts a fully prepared operation', () => {
    expect(planVerdict(goodPlan)).toEqual({ verdict: 'GO', blockers: [] });
  });

  it('reports every blocker by category', () => {
    expect(
      planVerdict({
        mount: { count: 3, sameRoot: false },
        pin: 'enroll_required',
        artifactPresent: true,
        artifactDigestMismatch: true,
        backupPresent: true,
        backupFresh: false,
        backupExpired: true,
        lockPresent: true,
      }),
    ).toEqual({
      verdict: 'NO-GO',
      blockers: [
        'mount_leak',
        'mount_foreign',
        'enroll_required',
        'artifact_digest',
        'backup_stale',
        'backup_expired',
        'lock_present',
      ],
    });
  });

  it('requires a fresh backup before GO', () => {
    expect(planVerdict({ ...goodPlan, backupPresent: false }).blockers).toEqual([
      'backup_required',
    ]);
  });
});

describe('mountLeaks', () => {
  it('ignores the root filesystem', () => {
    const info = '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n';
    expect(mountLeaks(info, '/opt/phub/timeweb-beta/backups')).toEqual({
      count: 0,
      sameRoot: true,
    });
  });

  it('counts stacked self-binds of the backups root', () => {
    const line =
      '55 1 8:1 /opt/phub/timeweb-beta/backups /opt/phub/timeweb-beta/backups rw - ext4 /dev/sda1 rw';
    expect(mountLeaks([line, line, line].join('\n'), '/opt/phub/timeweb-beta/backups')).toEqual({
      count: 3,
      sameRoot: true,
    });
  });

  it('flags a foreign mount root', () => {
    const a =
      '55 1 8:1 /opt/phub/timeweb-beta/backups /opt/phub/timeweb-beta/backups rw - ext4 /dev/sda1 rw';
    const b = '56 1 8:17 / /opt/phub/timeweb-beta/backups rw - ext4 /dev/sdb1 rw';
    expect(mountLeaks([a, b].join('\n'), '/opt/phub/timeweb-beta/backups')).toMatchObject({
      sameRoot: false,
    });
  });
});

describe('pinVerdict', () => {
  const base = { controllerSha: 'a', candidateSha: 'a', headSha: 'a', configSha: 'a', clean: true };
  it('accepts an exact pin', () => expect(pinVerdict(base)).toBe('ok'));
  it('requires enrollment for a newer candidate', () =>
    expect(pinVerdict({ ...base, candidateSha: 'b' })).toBe('enroll_required'));
  it('detects config drift', () =>
    expect(pinVerdict({ ...base, configSha: 'b' })).toBe('controller_config_mismatch'));
  it('detects a dirty checkout', () =>
    expect(pinVerdict({ ...base, clean: false })).toBe('controller_checkout_dirty'));
});

describe('buildV5Request', () => {
  const baseline = {
    containers: {
      api: {
        id: 'a1',
        image: 'ghcr.io/z6v6e6r/phub-api@sha256:' + '1'.repeat(64),
        releaseId: 'r1',
      },
      web: {
        id: 'w1',
        image: 'ghcr.io/z6v6e6r/phub-web@sha256:' + '2'.repeat(64),
        releaseId: 'r1',
      },
      worker: {
        id: 'k1',
        image: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '3'.repeat(64),
        releaseId: null,
      },
    },
  };
  const template = {
    sourceCiRunId: '1',
    artifactId: '2',
    ownerDecisions: { alertDrill: { status: 'NOT_TESTED_OWNER_DECLINED' } },
  };

  it('derives continuation inputs from the installed baseline', () => {
    const op = buildV5Request({
      template,
      baseline,
      backupOperationSha256: 'f'.repeat(64),
      candidateSha: 'c'.repeat(40),
      candidateTree: 't'.repeat(40),
      publicationRunId: '7',
      artifactId: '8',
      artifactDigest: 'sha256:' + '9'.repeat(64),
      manifestSha256: 'e'.repeat(64),
      expiresAt: '2026-01-01T00:00:00.000Z',
      legacyBaselineHash: () => 'b'.repeat(64),
      ownerDirectedScopeSha256: () => 's'.repeat(64),
    });

    expect(op.expectedApi).toEqual({
      id: 'a1',
      image: baseline.containers.api.image,
      releaseId: 'r1',
    });
    expect(op.expectedWorker.releaseId).toBeNull();
    expect(op.publicationRunId).toBe('7');
    expect(op.confirmation).toBe(confirmationFor('c'.repeat(40), 'b'.repeat(64)));
    expect(op.ownerDecisions.alertDrill.scopeSha256).toBe('s'.repeat(64));
    expect(op.expiresAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('matches the controller confirmation grammar', () => {
    expect(confirmationFor('c452ed818b162f618047a2fbeb6c56b5ea99eb1c', 'e1a5888a125a3ae9')).toBe(
      'UPGRADE_CANONICAL_PRODUCTION_API_WORKER_WEB_OWNER_SKIPPED_ALERT_DRILL_PROVIDER_READBACK_REPEAT_RESTORE_C452ED818B16_FROM_E1A5888A125A_KEEP_DATA_AND_ACCOUNTS',
    );
  });
});

describe('releaseId', () => {
  it('matches the canonical single-segment layout', () => {
    expect(releaseId('c'.repeat(40), '44021596128')).toBe('c'.repeat(40) + '-44021596128-1');
  });
});
