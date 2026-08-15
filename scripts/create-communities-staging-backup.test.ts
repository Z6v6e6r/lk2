import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const command = fileURLToPath(
  new URL('../deploy/jetson/create-communities-staging-backup.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const sourceLedgerManifest = `0001_initial.sql|${'a'.repeat(64)}`;
const sourceLedgerDigest = createHash('sha256').update(`${sourceLedgerManifest}\n`).digest('hex');

function execute(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', [command, ...args], { env }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(error.message, { cause: error });
        Object.assign(failure, { stdout, stderr });
        reject(failure);
      } else resolve({ stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await chmod(join(path, 'app'), 0o755).catch(() => undefined);
      await rm(path, { recursive: true });
    }),
  );
});

describe('Communities staging backup forced command', () => {
  it('emits exactly the strict phase-bound metadata contract and retains one private archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phub-communities-backup-'));
    temporaryDirectories.push(root);
    const appRoot = join(root, 'app');
    const backupRoot = join(root, 'backups');
    const bin = join(root, 'bin');
    const helper = join(root, 'verify-helper.sh');
    const dockerLog = join(root, 'docker.log');
    await Promise.all([mkdir(appRoot), mkdir(backupRoot), mkdir(bin)]);
    await Promise.all([
      writeFile(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n', 'utf8'),
      writeFile(join(appRoot, 'compose.infrastructure.yaml'), 'services: {}\n', 'utf8'),
      writeFile(join(appRoot, 'release.env'), `RELEASE=${'c'.repeat(40)}\n`, 'utf8'),
      writeFile(
        helper,
        '#!/bin/sh\nset -eu\ncase "$3" in VERIFY_STAGING_POSTGRES_CAPACITY) echo capacity-ok ;; VERIFY_STAGING_POSTGRES_BACKUP) echo restore-ok; echo tools-ok ;; *) exit 64 ;; esac\n',
        'utf8',
      ),
    ]);
    await Promise.all([
      chmod(appRoot, 0o555),
      chmod(join(appRoot, 'infrastructure.env'), 0o444),
      chmod(join(appRoot, 'compose.infrastructure.yaml'), 0o444),
      chmod(join(appRoot, 'release.env'), 0o444),
      chmod(backupRoot, 0o700),
      chmod(helper, 0o755),
    ]);
    await writeFile(join(bin, 'readlink'), '#!/bin/sh\nprintf "%s\\n" "$2"\n', 'utf8');
    await writeFile(
      join(bin, 'stat'),
      `#!/bin/sh
set -eu
field=$2
path=$3
case "$field:$path" in
  '%u:${command}'|'%u:${helper}') echo 0 ;;
  '%a:${command}'|'%a:${helper}') echo 755 ;;
  '%u:${backupRoot}') id -u ;;
  '%a:${backupRoot}') echo 700 ;;
  %u:${appRoot}*) echo 1 ;;
  %a:${appRoot}*) echo 444 ;;
  %a:*) echo 600 ;;
  %u:*) id -u ;;
  *) exit 1 ;;
esac
`,
      'utf8',
    );
    await writeFile(
      join(bin, 'mktemp'),
      '#!/bin/sh\npath=$(printf "%s" "$1" | sed "s/XXXXXX/123456/")\n: > "$path"\nprintf "%s\\n" "$path"\n',
      'utf8',
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$PHUB_TEST_DOCKER_LOG"
case "$*" in
  *'select filename, checksum from public.schema_migrations order by filename'*)
    printf '%s\n' '${sourceLedgerManifest}'
    ;;
  *'select current_database(); select system_identifier'*)
    printf '%s\n' phub 7482081092357201457
    ;;
  *'pg_dump -U'*)
    if [ "\${PHUB_TEST_SIGNAL_ON_DUMP:-}" = 1 ]; then
      kill -TERM "$PPID"
      exit 143
    fi
    printf '%s' synthetic-custom-archive
    ;;
  *'pg_restore --list'*) : ;;
  *'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 16.9 (Debian)' ;;
  *'pg_restore --version'*) echo 'pg_restore (PostgreSQL) 16.9 (Debian)' ;;
  *'psql --version'*) echo 'psql (PostgreSQL) 16.9 (Debian)' ;;
  *) echo "unexpected docker command: $*" >&2; exit 1 ;;
esac
`,
      'utf8',
    );
    await Promise.all(
      ['readlink', 'stat', 'mktemp', 'docker'].map((name) => chmod(join(bin, name), 0o755)),
    );

    const backupScriptSha = createHash('sha256')
      .update(await readFile(command))
      .digest('hex');
    const restoreHelperSha = createHash('sha256')
      .update(await readFile(helper))
      .digest('hex');
    const boundArguments = [
      'BACKUP_RESTORE_COMMUNITIES_STAGING',
      'c'.repeat(40),
      sourceLedgerDigest,
      'phub',
      '7482081092357201457',
      backupScriptSha,
      restoreHelperSha,
    ] as const;
    const originalCommand = boundArguments.join(' ');
    const commandEnvironment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: appRoot,
      PHUB_BACKUP_TIMEOUT_ACTIVE: '1',
      PHUB_BACKUP_ROOT: backupRoot,
      PHUB_POSTGRES_STORAGE_PATH: root,
      PHUB_RESTORE_HELPER: helper,
      PHUB_TEST_DOCKER_LOG: dockerLog,
      SSH_ORIGINAL_COMMAND: originalCommand,
    };
    const result = await execute([], commandEnvironment);
    const lines = result.stdout.trim().split('\n');
    const retained = await readdir(backupRoot);

    expect(lines).toHaveLength(14);
    expect(lines.every((line) => line.startsWith('META|'))).toBe(true);
    expect(result.stdout).toContain(`META|targetDatabase|phub`);
    expect(result.stdout).toContain(`META|systemIdentifier|7482081092357201457`);
    expect(result.stdout).toContain(`META|activeRelease|${'c'.repeat(40)}`);
    expect(result.stdout).toContain('META|pgDumpVersion|16.9');
    expect(result.stdout).toContain('META|pgRestoreVersion|16.9');
    expect(result.stdout).toContain('META|psqlVersion|16.9');
    expect(result.stdout).not.toContain('capacity-ok');
    expect(result.stdout).not.toContain('restore-ok');
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatch(/^postgres-communities-preflight-.*\.dump$/u);
    expect(await readFile(join(backupRoot, retained[0]!), 'utf8')).toBe('synthetic-custom-archive');

    const logBeforeMismatch = await readFile(dockerLog, 'utf8');
    const backupRootModeBeforeMismatch = (await stat(backupRoot)).mode & 0o777;
    const mismatchCommands = [
      [boundArguments[0], 'd'.repeat(40), ...boundArguments.slice(2)],
      [...boundArguments.slice(0, 2), 'd'.repeat(64), ...boundArguments.slice(3)],
      [...boundArguments.slice(0, 3), 'other', ...boundArguments.slice(4)],
      [...boundArguments.slice(0, 4), '1', ...boundArguments.slice(5)],
      [...boundArguments.slice(0, 5), 'd'.repeat(64), boundArguments[6]],
      [...boundArguments.slice(0, 6), 'd'.repeat(64)],
    ];
    for (const mismatchCommand of mismatchCommands) {
      const mismatch = await execute([], {
        ...commandEnvironment,
        SSH_ORIGINAL_COMMAND: mismatchCommand.join(' '),
      }).catch((error: Error) => error);
      expect(mismatch).toBeInstanceOf(Error);
    }
    const logAfterMismatch = await readFile(dockerLog, 'utf8');

    expect(await readdir(backupRoot)).toEqual(retained);
    expect((await stat(backupRoot)).mode & 0o777).toBe(backupRootModeBeforeMismatch);
    expect(logAfterMismatch.match(/pg_dump -U/gu)?.length ?? 0).toBe(
      logBeforeMismatch.match(/pg_dump -U/gu)?.length ?? 0,
    );

    const missingOriginalCommand = await execute([], {
      ...commandEnvironment,
      SSH_ORIGINAL_COMMAND: '',
    }).catch((error: Error) => error);
    expect(missingOriginalCommand).toBeInstanceOf(Error);

    const interrupted = await execute([], {
      ...commandEnvironment,
      PHUB_TEST_SIGNAL_ON_DUMP: '1',
    }).catch((error: Error) => error);
    expect(interrupted).toBeInstanceOf(Error);
    expect(await readdir(backupRoot)).toEqual(retained);
  }, 15_000);
});
