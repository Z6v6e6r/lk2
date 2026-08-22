import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION } from './communities-staging-role-split-v3-external-phase-anchor.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_VERSION,
  canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject,
  communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256,
  parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject,
  type CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
} from './communities-staging-role-split-v3-external-anchor-subject.js';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(
  new URL('./communities-staging-role-split-v3-anchor-rehearsal.ts', import.meta.url),
);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const entrypoint = process.env.PHUB_V10_REHEARSAL_ENTRYPOINT ?? source;
const productionArtifact = join(
  repository,
  'deploy/jetson/communities-role-split-v3-production-external-anchor-subject.json',
);
const rehearsalArtifact = join(
  repository,
  'deploy/jetson/communities-role-split-v3-anchor-rehearsal-subject.json',
);
const shellRunner = join(
  repository,
  'deploy/jetson/run-communities-role-split-anchor-rehearsal.sh',
);
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function subject(input: {
  purpose: 'PRODUCTION' | 'REHEARSAL';
  anchorDirectory: string;
  stateDirectory: string;
  backupDirectory: string;
  uid: number;
  gid: number;
  parentMode: 448 | 493;
}): CommunitiesStagingRoleSplitV3ExternalAnchorSubject {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_ANCHOR_SUBJECT_VERSION,
    candidateCommit: '74478e8f2ec91443709159ced1ee123345eb29e6',
    purpose: input.purpose,
    providerVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXTERNAL_PHASE_ANCHOR_VERSION,
    processOwner: 'phub-preflight',
    processUid: input.uid,
    processGid: input.gid,
    anchorDirectory: input.anchorDirectory,
    stateDirectory: input.stateDirectory,
    backupDirectory: input.backupDirectory,
    anchorParentUid: input.uid,
    anchorParentGid: input.gid,
    anchorParentMode: input.parentMode,
    anchorDirectoryMode: 0o700,
    stateDirectoryMode: 0o700,
    backupDirectoryUid: input.uid,
    backupDirectoryGid: input.gid,
    backupDirectoryMode: 0o700,
    targetFilesystem: 'LINUX_LOCAL',
    crashDomain: 'SUPERVISED_WORKER_PROCESS',
    authorizesLeaseRemoval: false,
    authorizesCeremony: false,
    authorizesDatabaseMutation: false,
    authorizesProductionActivation: false,
  };
}

describe('V3 external-anchor subject and crash rehearsal', () => {
  it('pins exact non-authorizing production and rehearsal subjects', async () => {
    const productionBytes = await readFile(productionArtifact, 'utf8');
    const rehearsalBytes = await readFile(rehearsalArtifact, 'utf8');
    const production = parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
      productionBytes,
      sha(productionBytes),
    );
    const rehearsal = parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
      rehearsalBytes,
      sha(rehearsalBytes),
    );

    expect(sha(productionBytes)).toBe(
      '078103b490907098b0815185a2442d5744ecf124c89aa92e103b94aef34dff77',
    );
    expect(sha(rehearsalBytes)).toBe(
      '035f03b71776c475e90236f90f789d44eb491fa4af67a34289ced9833f42e7cb',
    );

    expect(production).toMatchObject({
      purpose: 'PRODUCTION',
      processUid: 998,
      processGid: 993,
      anchorParentUid: 0,
      backupDirectoryUid: 0,
      backupDirectoryGid: 993,
      backupDirectoryMode: 0o750,
      anchorDirectory:
        '/var/lib/phub-role-split-external-anchor/74478e8f2ec91443709159ced1ee123345eb29e6/production',
      authorizesCeremony: false,
      authorizesDatabaseMutation: false,
      authorizesProductionActivation: false,
    });
    expect(rehearsal).toMatchObject({
      purpose: 'REHEARSAL',
      anchorDirectory: '/rehearsal/anchor',
      stateDirectory: '/rehearsal/state',
      backupDirectory: '/rehearsal/backup',
    });
    expect(production.anchorDirectory).not.toContain('/var/lib/phub-preflight/');
    expect(production.stateDirectory).toContain('/var/lib/phub-preflight/');
    expect(production.backupDirectory).toContain('/var/lib/phub-preflight/');
  });

  it('rejects digest drift, non-canonical bytes and overlapping custody paths', async () => {
    const bytes = await readFile(productionArtifact, 'utf8');
    expect(() =>
      parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(bytes, sha('different')),
    ).toThrow('DIGEST_MISMATCH');
    expect(() =>
      parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(` ${bytes}`, sha(` ${bytes}`)),
    ).toThrow('CANONICAL_ENCODING_INVALID');

    const uid = process.getuid!();
    const gid = process.getgid!();
    const invalid = subject({
      purpose: 'REHEARSAL',
      anchorDirectory: '/tmp/rehearsal',
      stateDirectory: '/tmp/rehearsal/state',
      backupDirectory: '/tmp/backup',
      uid,
      gid,
      parentMode: 0o700,
    });
    expect(() => canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(invalid)).toThrow(
      'PATH_INVALID',
    );
  });

  it('kills real child processes at both CAS windows, recovers, then detects full local rollback', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phub-v10-anchor-rehearsal-')));
    await chmod(root, 0o700);
    const anchorDirectory = join(root, 'anchor');
    const stateDirectory = join(root, 'state');
    const backupDirectory = join(root, 'backup');
    await Promise.all(
      [anchorDirectory, stateDirectory, backupDirectory].map(async (directory) => {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }),
    );
    const rootStat = await stat(root);
    const rehearsal = subject({
      purpose: 'REHEARSAL',
      anchorDirectory,
      stateDirectory,
      backupDirectory,
      uid: rootStat.uid,
      gid: rootStat.gid,
      parentMode: 0o700,
    });
    const production = subject({
      purpose: 'PRODUCTION',
      anchorDirectory: join(root, 'unused-production-anchor'),
      stateDirectory: join(root, 'unused-production-state'),
      backupDirectory: join(root, 'unused-production-backup'),
      uid: rootStat.uid,
      gid: rootStat.gid,
      parentMode: 0o700,
    });
    const productionPath = join(root, 'production.json');
    const rehearsalPath = join(root, 'rehearsal.json');
    const productionBytes = canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(production);
    const rehearsalBytes = canonicalCommunitiesStagingRoleSplitV3ExternalAnchorSubject(rehearsal);
    await writeFile(productionPath, productionBytes, { mode: 0o600 });
    await writeFile(rehearsalPath, rehearsalBytes, { mode: 0o600 });

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        entrypoint,
        'run',
        productionPath,
        communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(production),
        rehearsalPath,
        communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(rehearsal),
        entrypoint,
      ],
      { cwd: repository, timeout: 30_000, maxBuffer: 64 * 1024 },
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      beforeAnchorCrash: 'RECOVERED_TO_RESTORE_PENDING',
      afterAnchorCrash: 'RECOVERED_TO_RESTORED',
      completeLocalRollback: 'STATE_ROLLBACK_DETECTED',
      retainedAnchorPhase: 'RESTORED',
      crashDomain: 'SUPERVISED_WORKER_PROCESS',
      wholeHostCrashTested: false,
      productionAnchorTouched: false,
      databaseAccessed: false,
      authorizesCeremony: false,
      authorizesLeaseRemoval: false,
      authorizesDatabaseMutation: false,
    });
    expect((await readdirNames(anchorDirectory)).some((name) => name.includes('restored'))).toBe(
      true,
    );
    expect(await readFile(join(stateDirectory, 'v3-durable-state.json'), 'utf8')).toContain(
      '"phase":"OWNED"',
    );
  });

  it('keeps the Linux runner networkless, digest-pinned and non-authorizing', async () => {
    const sourceBytes = await readFile(shellRunner, 'utf8');
    expect(sourceBytes).toContain('--network none');
    expect(sourceBytes).toContain('--pull never');
    expect(sourceBytes).toContain('/usr/bin/timeout --signal=TERM --kill-after=10s 120s');
    expect(sourceBytes).toContain('--read-only');
    expect(sourceBytes).toContain('--cap-drop ALL');
    expect(sourceBytes).toContain('--user 998:993');
    expect(sourceBytes).toContain('[ -x /bin/readlink ] || fail INPUT_CUSTODY_INVALID');
    expect(sourceBytes).toContain(
      'INPUT_REAL=$(/bin/readlink -f -- "$INPUT_PATH") || fail INPUT_CUSTODY_INVALID',
    );
    expect(sourceBytes).not.toContain('/usr/bin/readlink');
    expect(sourceBytes).toContain('PRODUCTION_ANCHOR_TOUCHED');
    expect(sourceBytes).toContain("'directory|0|0|700'");
    expect(sourceBytes).toContain('authorizes_ceremony=false');
    expect(sourceBytes).toContain('authorizes_database_mutation=false');
    expect(sourceBytes).not.toMatch(/psql|pg_restore|postgres:\/\//u);
    await expect(execFileAsync('/bin/sh', ['-n', shellRunner])).resolves.toMatchObject({
      stderr: '',
    });
  });
});

async function readdirNames(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(path);
}
