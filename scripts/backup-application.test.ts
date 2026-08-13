import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const backupScript = fileURLToPath(
  new URL('../deploy/jetson/backup-application.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

interface Fixture {
  readonly appRoot: string;
  readonly backupDirectory: string;
  readonly backupRoot: string;
  readonly bin: string;
}

class CommandFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

async function write(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  if (mode !== undefined) await chmod(path, mode);
}

async function fixture(): Promise<Fixture> {
  const temporary = await mkdtemp(join(tmpdir(), 'phub-backup-'));
  temporaryDirectories.push(temporary);
  const appRoot = join(temporary, 'opt', 'phub');
  const backupRoot = join(appRoot, 'backups', 'releases');
  const bin = join(temporary, 'bin');
  await mkdir(bin, { recursive: true });
  await write(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n', 0o600);
  await write(join(appRoot, 'compose.yaml'), 'compose\n');
  await write(
    join(appRoot, 'release.env'),
    `RELEASE_SECRET=never-print-me\nRELEASE=${'a'.repeat(40)}\n`,
    0o600,
  );
  await write(join(appRoot, 'nginx', 'default.conf'), 'nginx\n');
  await write(join(appRoot, 'staging.auth.env'), 'AUTH_SECRET=never-print-me\n', 0o600);
  await write(join(appRoot, 'tls-ingress', 'Caddyfile'), 'caddy\n');
  await write(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
case "$*" in
  *'ps -q web'*) echo web-container ;;
  *'ps -q api'*) echo api-container ;;
  *'ps -q worker'*) echo worker-container ;;
  *'ps -q realtime'*) echo realtime-container ;;
esac
`,
    0o755,
  );
  await mkdir(backupRoot, { recursive: true });
  return {
    appRoot,
    backupRoot,
    bin,
    backupDirectory: join(backupRoot, 'pre-abcdef-123-1'),
  };
}

function execute(
  input: Fixture,
  confirmation = 'BACKUP_STAGING_RELEASE',
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      [backupScript, input.backupDirectory, confirmation],
      {
        env: {
          ...process.env,
          PATH: `${input.bin}:${process.env.PATH ?? ''}`,
          PHUB_BACKUP_APP_ROOT: input.appRoot,
          PHUB_BACKUP_ROOT: input.backupRoot,
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new CommandFailure(error.message, stdout, stderr));
        else resolve({ stdout, stderr });
      },
    );
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Nano staging application backup primitive', () => {
  it('atomically snapshots all release definitions and writes the completion marker last', async () => {
    const input = await fixture();
    await write(join(input.appRoot, 'staging.override.env'), 'HOME_READ_MODE=projection\n', 0o600);
    await write(
      join(input.appRoot, 'staging.communities.env'),
      'COMMUNITIES_READ_MODE=legacy\n',
      0o600,
    );
    const result = await execute(input);

    await expect(readFile(join(input.backupDirectory, 'compose.yaml'), 'utf8')).resolves.toBe(
      'compose\n',
    );
    await expect(readFile(join(input.backupDirectory, 'staging.auth.env'), 'utf8')).resolves.toBe(
      'AUTH_SECRET=never-print-me\n',
    );
    await expect(
      readFile(join(input.backupDirectory, 'staging.override.env'), 'utf8'),
    ).resolves.toBe('HOME_READ_MODE=projection\n');
    await expect(
      readFile(join(input.backupDirectory, 'staging.communities.env'), 'utf8'),
    ).resolves.toBe('COMMUNITIES_READ_MODE=legacy\n');
    await expect(readFile(join(input.backupDirectory, 'backup.complete'), 'utf8')).resolves.toBe(
      `${'a'.repeat(40)}\n`,
    );
    await expect(readFile(join(input.backupDirectory, 'process-state.env'), 'utf8')).resolves.toBe(
      'WEB=running\nAPI=running\nWORKER=running\nREALTIME=running\n',
    );
    expect((await lstat(input.backupDirectory)).isDirectory()).toBe(true);
    expect(result.stdout).not.toContain('never-print-me');
    expect(result.stderr).not.toContain('never-print-me');
  });

  it('records that the optional runtime override was absent', async () => {
    const input = await fixture();
    await execute(input);

    await expect(
      readFile(join(input.backupDirectory, 'staging.override.env.absent'), 'utf8'),
    ).resolves.toBe('');
    await expect(
      readFile(join(input.backupDirectory, 'staging.communities.env.absent'), 'utf8'),
    ).resolves.toBe('');
  });

  it('refuses to create a snapshot without the explicit confirmation', async () => {
    const input = await fixture();
    const failure = await execute(input, 'NO').catch((error: CommandFailure) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('BACKUP_STAGING_RELEASE');
    await expect(lstat(input.backupDirectory)).rejects.toThrow();
  });

  it('refuses a symlinked release definition before creating the snapshot', async () => {
    const input = await fixture();
    await rm(join(input.appRoot, 'staging.auth.env'));
    await symlink(join(input.appRoot, 'release.env'), join(input.appRoot, 'staging.auth.env'));
    const failure = await execute(input).catch((error: CommandFailure) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain(
      'required current file is absent or unsafe: staging.auth.env',
    );
    await expect(lstat(input.backupDirectory)).rejects.toThrow();
  });
});
