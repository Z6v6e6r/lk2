import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(
  new URL('../deploy/jetson/run-communities-staged-migration-rehearsal.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const activeRelease = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const migratorDigest = `sha256:${'c'.repeat(64)}`;
const systemIdentifier = '7482081092357201457';
const sourceLedger = `0001_initial.sql|${'d'.repeat(64)}`;
const sourceLedgerSha = createHash('sha256').update(`${sourceLedger}\n`).digest('hex');
const migrationManifest = `${'e'.repeat(64)}|0001_initial.sql\n`;
const manifestBase64 = Buffer.from(migrationManifest).toString('base64');
const manifestSha = createHash('sha256').update(migrationManifest).digest('hex');

function execute(env: NodeJS.ProcessEnv) {
  return new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    execFile('/bin/sh', [wrapper], { env }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const failure = new Error(error.message, { cause: error });
      Object.assign(failure, { stdout, stderr });
      reject(failure);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(join(directory, 'app'), 0o755).catch(() => undefined);
      await chmod(join(directory, 'secrets'), 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('Communities staged migration protected dispatch', () => {
  it('binds every artifact and source value before retaining an ACL-preserving backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-communities-staged-dispatch-'));
    temporaryDirectories.push(directory);
    const appRoot = join(directory, 'app');
    const backupRoot = join(directory, 'backups');
    const secretRoot = join(directory, 'secrets');
    const bin = join(directory, 'bin');
    const runtimeEnv = join(directory, 'staging.env');
    const migratorEnv = join(directory, 'staging.migrator.env');
    const releaseEnv = join(appRoot, `release.communities-rehearsal-${candidateSha}.env`);
    const composeFile = join(appRoot, `compose.communities-rehearsal-${candidateSha}.yaml`);
    const rehearsal = join(directory, 'rehearse.sh');
    const ledgerVerifier = join(directory, 'verify-ledger.sh');
    const restoreHelper = join(directory, 'verify-restore.sh');
    const dockerLog = join(directory, 'docker.log');
    await Promise.all([mkdir(appRoot), mkdir(backupRoot), mkdir(secretRoot), mkdir(bin)]);
    await Promise.all([
      writeFile(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n'),
      writeFile(join(appRoot, 'compose.infrastructure.yaml'), 'services: {}\n'),
      writeFile(composeFile, 'services: {}\n'),
      writeFile(join(appRoot, 'release.env'), `RELEASE=${activeRelease}\n`),
      writeFile(runtimeEnv, 'DATABASE_URL=postgresql://runtime:secret@postgres:5432/phub\n'),
      writeFile(migratorEnv, 'DATABASE_URL=postgresql://migrator:secret@postgres:5432/phub\n'),
      writeFile(releaseEnv, `RELEASE=${candidateSha}\nMIGRATOR_IMAGE_DIGEST=${migratorDigest}\n`),
      writeFile(ledgerVerifier, '#!/bin/sh\nexit 0\n'),
      writeFile(
        restoreHelper,
        '#!/bin/sh\ntest "$3" = VERIFY_STAGING_POSTGRES_CAPACITY\nprintf "%s\\n" capacity-ok\n',
      ),
      writeFile(dockerLog, ''),
    ]);
    await writeFile(
      rehearsal,
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_REHEARSAL_LOG"
if test "\${FAKE_REHEARSAL_FAIL:-}" = true; then
  printf '%s\n' 'do-not-publish-provider-secret' >&2
  exit 1
fi
printf '%s\n' 'communities_profile_privacy_audit missing_before=2 missing_after=0 authority=postgres_superuser status=passed'
for index in a b c d; do
  printf 'community_media_quota_index_measurement index=%s operation=reindex duration_ms=1 rollback=confirmed status=passed\n' "$index"
done
printf 'communities_staged_migration_rehearsal database=%s pre_foundation=16 foundation=5 post_foundation=8 quota_index_measurements=4 source_ledger_sha=%s cleanup=confirmed status=passed\n' "$2" "$COMMUNITIES_STAGED_REHEARSAL_EXPECTED_SOURCE_LEDGER_SHA"
`,
    );
    await writeFile(join(bin, 'readlink'), '#!/bin/sh\ntest "$1" = -f\nprintf "%s\\n" "$2"\n');
    await writeFile(
      join(bin, 'stat'),
      `#!/bin/sh
set -eu
field=$2
path=$3
case "$field:$path" in
  '%u:${composeFile}') test "\${FAKE_COMPOSE_OWNER_BAD:-}" != true && echo 0 || echo 1 ;;
  '%a:${composeFile}') test "\${FAKE_COMPOSE_MODE_BAD:-}" != true && echo 444 || echo 666 ;;
  '%u:${wrapper}'|'%u:${rehearsal}'|'%u:${ledgerVerifier}'|'%u:${restoreHelper}'|'%u:${releaseEnv}') echo 0 ;;
  '%a:${wrapper}'|'%a:${rehearsal}'|'%a:${ledgerVerifier}'|'%a:${restoreHelper}') echo 755 ;;
  '%a:${releaseEnv}') echo 400 ;;
  '%u:${backupRoot}') id -u ;;
  '%a:${backupRoot}') echo 700 ;;
  %a:${backupRoot}/*) echo 600 ;;
  %u:${appRoot}*|%u:${runtimeEnv}|%u:${migratorEnv}) echo 1 ;;
  %a:*) echo 444 ;;
  %u:*) id -u ;;
  *) exit 1 ;;
esac
`,
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *' pull migrator') exit 0 ;;
  *' config --images') printf '%s\n' 'ghcr.io/example/phub-migrator@${migratorDigest}' ;;
  'image inspect '*) exit 0 ;;
  *'select filename, checksum from public.schema_migrations order by filename'*) printf '%s\n' '${sourceLedger}' ;;
  *'select current_database(); select system_identifier'*) printf '%s\n' phub '${systemIdentifier}' ;;
  *'pg_dump -U'*'--format=custom'*) printf '%s' ownership-preserving-archive ;;
  *'pg_restore --list'*)
    printf '%s\n' '1; 0 0 TABLE profile privacy_commands phub_owner'
    printf '%s\n' '2; 0 0 ACL - TABLE profile privacy_commands phub_owner'
    printf '%s\n' '3; 0 0 DEFAULT ACL - DEFAULT PRIVILEGES FOR TABLES phub_owner'
    ;;
  *) printf 'unexpected docker command: %s\n' "$*" >&2; exit 1 ;;
esac
`,
    );
    await writeFile(
      join(bin, 'ln'),
      '#!/bin/sh\nif test "${FAKE_LN_COLLISION:-}" = true; then printf collision > "$2"; exit 1; fi\nexec /bin/ln "$@"\n',
    );
    await Promise.all(
      [
        appRoot,
        secretRoot,
        join(appRoot, 'infrastructure.env'),
        join(appRoot, 'compose.infrastructure.yaml'),
        composeFile,
        join(appRoot, 'release.env'),
        runtimeEnv,
        migratorEnv,
        releaseEnv,
        rehearsal,
        ledgerVerifier,
        restoreHelper,
        join(bin, 'readlink'),
        join(bin, 'stat'),
        join(bin, 'docker'),
        join(bin, 'ln'),
      ].map((path) =>
        chmod(
          path,
          path === appRoot
            ? 0o555
            : path === secretRoot
              ? 0o100
              : [rehearsal, ledgerVerifier, restoreHelper].includes(path) || path.startsWith(bin)
                ? 0o755
                : 0o444,
        ),
      ),
    );
    await chmod(backupRoot, 0o700);

    const sha = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    const arguments_ = [
      'REHEARSE_COMMUNITIES_STAGING_29_V1',
      '29_V1',
      '13b5ca1d0930fdc4b67852f01418c27f8946f538f2311d7e5f755ecb2df12747',
      activeRelease,
      sourceLedgerSha,
      'phub',
      systemIdentifier,
      candidateSha,
      migratorDigest,
      await sha(releaseEnv),
      await sha(composeFile),
      manifestSha,
      manifestBase64,
      await sha(wrapper),
      await sha(rehearsal),
      await sha(ledgerVerifier),
      await sha(restoreHelper),
    ];
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: appRoot,
      PHUB_MEDIA_LEDGER_VERIFIER: ledgerVerifier,
      PHUB_MIGRATOR_ENV: migratorEnv,
      PHUB_POSTGRES_STORAGE_PATH: directory,
      PHUB_REHEARSAL_BACKUP_ROOT: backupRoot,
      PHUB_REHEARSAL_COMMAND: rehearsal,
      PHUB_REHEARSAL_TIMEOUT_ACTIVE: '1',
      PHUB_RESTORE_HELPER: restoreHelper,
      PHUB_RUNTIME_ENV: runtimeEnv,
      PHUB_SECRET_ROOT: secretRoot,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_REHEARSAL_LOG: join(directory, 'rehearsal.log'),
      SSH_ORIGINAL_COMMAND: arguments_.join(' '),
    };

    const result = await execute(environment);
    const retained = await readdir(backupRoot);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(31);
    expect(result.stdout).toContain('META|rehearsalStatus|passed');
    expect(result.stdout).toContain(`META|candidateSha|${candidateSha}`);
    expect(result.stdout).toContain('META|contractVersion|29_V1');
    expect(result.stdout).toContain(
      'META|pendingSetSha|13b5ca1d0930fdc4b67852f01418c27f8946f538f2311d7e5f755ecb2df12747',
    );
    expect(result.stdout).toContain('META|authorizesSharedMigration|false');
    expect(result.stdout.match(/community_media_quota_index_measurement index=/gu)).toHaveLength(4);
    expect(result.stdout).toContain('communities_profile_privacy_audit missing_before=2');
    expect(retained.filter((name) => name.endsWith('.dump'))).toHaveLength(1);
    expect(retained).not.toContain(expect.stringContaining('.stderr.'));
    const successfulDockerLog = await readFile(dockerLog, 'utf8');
    expect(successfulDockerLog).toContain('pg_dump -U');
    expect(successfulDockerLog).toContain('--profile migration config --images');
    expect(successfulDockerLog.indexOf('pull migrator')).toBeLessThan(
      successfulDockerLog.indexOf('pg_dump -U'),
    );
    expect(successfulDockerLog).not.toContain('--no-owner');
    expect(successfulDockerLog).not.toContain('--no-acl');

    const beforeMismatch = await readdir(backupRoot);
    const dockerBeforeMismatch = await readFile(dockerLog, 'utf8');
    const mismatched = await execute({
      ...environment,
      SSH_ORIGINAL_COMMAND: [
        ...arguments_.slice(0, 9),
        'f'.repeat(64),
        ...arguments_.slice(10),
      ].join(' '),
    }).catch((error: Error) => error);
    expect(mismatched).toBeInstanceOf(Error);
    expect(await readdir(backupRoot)).toEqual(beforeMismatch);
    expect(await readFile(dockerLog, 'utf8')).toBe(dockerBeforeMismatch);

    const oldFifteenFieldTuple = [arguments_[0], ...arguments_.slice(3)];
    expect(oldFifteenFieldTuple).toHaveLength(15);
    const staleProtocol = await execute({
      ...environment,
      SSH_ORIGINAL_COMMAND: oldFifteenFieldTuple.join(' '),
    }).catch((error: Error) => error);
    expect(staleProtocol).toBeInstanceOf(Error);
    expect(await readdir(backupRoot)).toEqual(beforeMismatch);
    expect(await readFile(dockerLog, 'utf8')).toBe(dockerBeforeMismatch);

    for (const unsafeComposeEnv of [
      { FAKE_COMPOSE_OWNER_BAD: 'true' },
      { FAKE_COMPOSE_MODE_BAD: 'true' },
    ]) {
      const unsafeCompose = await execute({ ...environment, ...unsafeComposeEnv }).catch(
        (error: Error) => error,
      );
      expect(unsafeCompose).toBeInstanceOf(Error);
      expect(await readFile(dockerLog, 'utf8')).toBe(dockerBeforeMismatch);
    }

    const collision = await execute({ ...environment, FAKE_LN_COLLISION: 'true' }).catch(
      (error: Error) => error,
    );
    expect(collision).toBeInstanceOf(Error);
    const archivesAfterCollision = (await readdir(backupRoot)).filter((name) =>
      name.endsWith('.dump'),
    );
    const archiveContents = await Promise.all(
      archivesAfterCollision.map((name) => readFile(join(backupRoot, name), 'utf8')),
    );
    expect(archiveContents).toContain('collision');

    const failed = await execute({ ...environment, FAKE_REHEARSAL_FAIL: 'true' }).catch(
      (error: Error & { stderr?: string }) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error & { stderr?: string }).stderr).not.toContain(
      'do-not-publish-provider-secret',
    );
    expect((await readdir(backupRoot)).filter((name) => name.endsWith('.dump'))).toHaveLength(2);
  }, 20_000);

  it('keeps the workflow manual, exact-SHA pinned and isolated from deploy/shared migration', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/communities-staged-migration-rehearsal.yaml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+(push|pull_request|schedule):/u);
    expect(workflow).toContain('environment: staging-rehearsal');
    expect(workflow).toContain('STAGING_REHEARSAL_KEY');
    expect(workflow).not.toContain('STAGING_DEPLOY_KEY');
    expect(workflow).toContain('REHEARSE_COMMUNITIES_STAGING_29_V1');
    expect(workflow).toContain('REHEARSE_COMMUNITIES_STAGING_32_V1');
    expect(workflow).toContain('32_V1 is clone-evidence preparation only');
    expect(workflow).toContain('COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES');
    expect(workflow).toContain('phase_binding_sha');
    expect(workflow).toContain('sha256sum deploy/compose.staging.yaml');
    expect(workflow).toContain('expected_rehearsal_release_sha');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=30s 190m');
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v[0-9]+/u);
    expect(workflow).not.toMatch(
      /(?:docker compose up|docker compose restart|npm run db:migrate|\bscp )/u,
    );
    expect(workflow).toContain('authorizesSharedMigration');
    expect(workflow).toContain('authorizesActivation');
    expect(
      await readFile(
        new URL('../deploy/jetson/rehearse-media-migration.sh', import.meta.url),
        'utf8',
      ),
    ).toContain('PHUB_MEDIA_LEDGER_VERIFIER');
  });

  it('rejects the reserved 32_V1 forced-command token before any backup or Docker access', async () => {
    const error = await execute({
      ...process.env,
      SSH_ORIGINAL_COMMAND: 'REHEARSE_COMMUNITIES_STAGING_32_V1',
    }).catch((value: Error) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { stderr?: string }).stderr).toContain(
      '32_V1 is clone-evidence preparation only',
    );
  });
});
