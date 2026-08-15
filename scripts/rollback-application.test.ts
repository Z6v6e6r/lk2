import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const rollbackScript = fileURLToPath(
  new URL('../deploy/jetson/rollback-application.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;

interface Fixture {
  readonly root: string;
  readonly backup: string;
  readonly backupRoot: string;
  readonly bin: string;
  readonly dockerLog: string;
  readonly images: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
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
  const temporary = await mkdtemp(join(tmpdir(), 'phub-rollback-'));
  temporaryDirectories.push(temporary);
  const root = join(temporary, 'opt', 'phub');
  const backupRoot = join(root, 'backups');
  const backup = join(backupRoot, 'release-previous');
  const bin = join(temporary, 'bin');
  const dockerLog = join(temporary, 'docker.log');
  await mkdir(backup, { recursive: true });
  await mkdir(bin, { recursive: true });

  await write(join(root, 'infrastructure.env'), 'POSTGRES_USER=phub\n', 0o600);
  await write(join(root, 'compose.infrastructure.yaml'), 'services: {}\n');
  await write(join(root, 'tls-ingress', 'compose.yaml'), 'services: {}\n');
  await write(join(root, 'compose.yaml'), 'current compose\n');
  await write(join(root, 'release.env'), 'current release\n', 0o600);
  await write(join(root, 'nginx', 'default.conf'), 'current nginx\n');
  await write(join(root, 'staging.auth.env'), 'CURRENT_SECRET=current\n', 0o600);
  await write(join(root, 'staging.override.env'), 'HOME_READ_MODE=current\n', 0o600);
  await write(join(root, 'staging.communities.env'), 'COMMUNITIES_READ_MODE=legacy\n', 0o600);
  await write(join(root, 'tls-ingress', 'Caddyfile'), 'current caddy\n');

  const images = [
    `ghcr.io/z6v6e6r/phub-web@${digest}`,
    `ghcr.io/z6v6e6r/phub-api@${digest}`,
    `ghcr.io/z6v6e6r/phub-worker@${digest}`,
    `ghcr.io/z6v6e6r/phub-realtime@${digest}`,
    `ghcr.io/z6v6e6r/phub-migrator@${digest}`,
  ].join('\n');
  await write(join(backup, 'compose.yaml'), 'previous compose\n');
  await write(
    join(backup, 'release.env'),
    [
      'REGISTRY=ghcr.io/z6v6e6r',
      `WEB_IMAGE_DIGEST=${digest}`,
      `API_IMAGE_DIGEST=${digest}`,
      `WORKER_IMAGE_DIGEST=${digest}`,
      `REALTIME_IMAGE_DIGEST=${digest}`,
      `MIGRATOR_IMAGE_DIGEST=${digest}`,
      `RELEASE=${'b'.repeat(40)}`,
      'LATEST_MIGRATION=0059_game_conversations.sql',
      'S3_PUBLIC_ENDPOINT=https://lk.nano.padlhub.su',
      '',
    ].join('\n'),
    0o600,
  );
  await write(join(backup, 'nginx', 'default.conf'), 'previous nginx\n');
  await write(join(backup, 'staging.auth.env'), 'ROLLBACK_TEST_SECRET=never-print-me\n', 0o600);
  await write(join(backup, 'staging.override.env'), 'HOME_READ_MODE=previous\n', 0o600);
  await write(join(backup, 'staging.communities.env'), 'COMMUNITIES_READ_MODE=mock\n', 0o600);
  await write(join(backup, 'staging.games.env.absent'), '', 0o600);
  await write(join(backup, 'tls-ingress', 'Caddyfile'), 'previous caddy\n');
  await write(
    join(backup, 'process-state.env'),
    'WEB=running\nAPI=running\nWORKER=running\nREALTIME=running\n',
    0o600,
  );
  await write(join(backup, 'backup.complete'), `${'b'.repeat(40)}\n`, 0o600);
  await write(
    join(backup, 'worker-capabilities.env'),
    'API_CLIENT_MEDIA_ROLLBACK_V1=true\nWORKER_CLIENT_MEDIA_ROLLBACK_V1=true\n',
    0o600,
  );

  await write(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'--profile migration config --images'*) printf '%s\\n' "$FAKE_DOCKER_IMAGES" ;;
  *'config --images'*) printf '%s\\n' "$FAKE_DOCKER_IMAGES" | sed '/phub-migrator/d' ;;
  *'ps --status running -q worker'*) printf '%s\\n' "\${FAKE_COMPATIBLE_WORKER_ID:-}" ;;
  *"inspect --format {{.Config.Image}} \${FAKE_COMPATIBLE_WORKER_ID:-__missing__}"*)
    printf '%s\\n' "\${FAKE_COMPATIBLE_WORKER_IMAGE:-}" ;;
  *"exec \${FAKE_COMPATIBLE_WORKER_ID:-__missing__} node -e"*)
    exit "\${FAKE_WORKER_CAPABILITY_STATUS:-0}" ;;
esac
`,
    0o755,
  );

  return { root, backup, backupRoot, bin, dockerLog, images };
}

function execute(
  input: Fixture,
  operation: string | null = '--confirm=ROLLBACK_STAGING_RELEASE',
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      [rollbackScript, input.backup, ...(operation === null ? [] : [operation])],
      {
        env: {
          ...process.env,
          PATH: `${input.bin}:${process.env.PATH ?? ''}`,
          PHUB_ROLLBACK_APP_ROOT: input.root,
          PHUB_ROLLBACK_BACKUP_ROOT: input.backupRoot,
          PHUB_ROLLBACK_HEALTH_ATTEMPTS: '1',
          PHUB_ROLLBACK_HEALTH_DELAY_SECONDS: '0',
          FAKE_DOCKER_LOG: input.dockerLog,
          FAKE_DOCKER_IMAGES: input.images,
          ...extraEnvironment,
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

describe('Nano staging application rollback primitive', () => {
  it('restores a complete saved release, never runs migrations and verifies all services', async () => {
    const input = await fixture();
    const result = await execute(input);

    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'previous compose\n',
    );
    await expect(readFile(join(input.root, 'nginx', 'default.conf'), 'utf8')).resolves.toBe(
      'previous nginx\n',
    );
    await expect(readFile(join(input.root, 'staging.auth.env'), 'utf8')).resolves.toBe(
      'ROLLBACK_TEST_SECRET=never-print-me\n',
    );
    await expect(readFile(join(input.root, 'staging.override.env'), 'utf8')).resolves.toBe(
      'HOME_READ_MODE=previous\n',
    );
    await expect(readFile(join(input.root, 'staging.communities.env'), 'utf8')).resolves.toBe(
      'COMMUNITIES_READ_MODE=mock\n',
    );
    await expect(readFile(join(input.root, 'tls-ingress', 'Caddyfile'), 'utf8')).resolves.toBe(
      'previous caddy\n',
    );
    expect((await stat(join(input.root, 'staging.auth.env'))).mode & 0o777).toBe(0o600);

    const dockerCalls = await readFile(input.dockerLog, 'utf8');
    expect(dockerCalls).toContain('--profile migration config --quiet');
    expect(dockerCalls).toContain('--profile migration config --images');
    expect(dockerCalls).toContain('image inspect');
    expect(dockerCalls).not.toContain(' pull ');
    expect(dockerCalls).toContain('up -d --remove-orphans web api');
    expect(dockerCalls).toContain('up -d worker');
    expect(dockerCalls).toContain('up -d realtime');
    expect(dockerCalls).toContain('exec -T api node -e');
    expect(dockerCalls).toContain('exec -T realtime node -e');
    expect(dockerCalls).toContain('exec -T worker node -e');
    expect(dockerCalls).not.toContain('--profile migration run');
    expect(dockerCalls).not.toContain(' run --rm migrator');
    expect(result.stdout).not.toContain('never-print-me');
    expect(result.stderr).not.toContain('never-print-me');

    const recoveryDirectories = (await readdir(input.backupRoot)).filter((name) =>
      name.startsWith('rollback-recovery-'),
    );
    expect(recoveryDirectories).toHaveLength(1);
    await expect(
      readFile(join(input.backupRoot, recoveryDirectories[0] as string, 'compose.yaml'), 'utf8'),
    ).resolves.toBe('current compose\n');
  });

  it('refuses a saved release without the completion marker', async () => {
    const input = await fixture();
    await rm(join(input.backup, 'backup.complete'));

    const failure = await execute(input).catch((error: CommandFailure) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain(
      'required saved file is absent: backup.complete',
    );
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
    await expect(readFile(input.dockerLog, 'utf8')).rejects.toThrow();
  });

  it('refuses to run without the explicit rollback confirmation', async () => {
    const input = await fixture();

    const failure = await execute(input, null).catch((error: CommandFailure) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('--confirm=ROLLBACK_STAGING_RELEASE');
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
    await expect(readFile(input.dockerLog, 'utf8')).rejects.toThrow();
  });

  it('validates rollback readiness without changing the active release', async () => {
    const input = await fixture();
    const result = await execute(input, '--validate-only');

    expect(result.stdout).toContain('rollback snapshot validated');
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
    const recoveryDirectories = (await readdir(input.backupRoot)).filter((name) =>
      name.startsWith('rollback-recovery-'),
    );
    expect(recoveryDirectories).toHaveLength(0);
    expect(await readFile(input.dockerLog, 'utf8')).toContain('image inspect');
  });

  it('removes a candidate runtime override when the saved release had none', async () => {
    const input = await fixture();
    await rm(join(input.backup, 'staging.override.env'));
    await writeFile(join(input.backup, 'staging.override.env.absent'), '');
    await execute(input);

    await expect(readFile(join(input.root, 'staging.override.env'), 'utf8')).rejects.toThrow();
  });

  it('removes a candidate Communities API profile when the saved release had none', async () => {
    const input = await fixture();
    await rm(join(input.backup, 'staging.communities.env'));
    await writeFile(join(input.backup, 'staging.communities.env.absent'), '');
    await execute(input);

    await expect(readFile(join(input.root, 'staging.communities.env'), 'utf8')).rejects.toThrow();
  });

  it('keeps worker and realtime stopped when restoring a read-only Communities profile', async () => {
    const input = await fixture();
    await writeFile(
      join(input.backup, 'process-state.env'),
      'WEB=running\nAPI=running\nWORKER=stopped\nREALTIME=stopped\n',
    );
    await execute(input);

    const dockerCalls = await readFile(input.dockerLog, 'utf8');
    expect(dockerCalls).toContain('up -d --remove-orphans web api');
    expect(dockerCalls).toContain('stop worker');
    expect(dockerCalls).toContain('stop realtime');
    expect(dockerCalls).toContain('ps --status running -q worker');
    expect(dockerCalls).toContain('ps --status running -q realtime');
    expect(dockerCalls).not.toContain('up -d worker');
    expect(dockerCalls).not.toContain('up -d realtime');
    expect(dockerCalls).not.toContain('exec -T worker node -e');
    expect(dockerCalls).not.toContain('exec -T realtime node -e');
  });

  it('restores the attested saved worker without replacing it during rollback', async () => {
    const input = await fixture();
    const compatibleImage = `ghcr.io/z6v6e6r/phub-worker@${digest}`;

    await execute(input, '--confirm=ROLLBACK_STAGING_RELEASE', {
      PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER: 'true',
      FAKE_COMPATIBLE_WORKER_ID: 'worker-compatible-id',
      FAKE_COMPATIBLE_WORKER_IMAGE: compatibleImage,
    });

    const restoredRelease = await readFile(join(input.root, 'release.env'), 'utf8');
    expect(restoredRelease).toContain(`WORKER_IMAGE_DIGEST=${digest}`);
    const dockerCalls = await readFile(input.dockerLog, 'utf8');
    expect(dockerCalls).not.toContain('up -d worker');
    expect(dockerCalls.match(/ps --status running -q worker/g)).toHaveLength(2);
    expect(dockerCalls).toContain('inspect --format {{.Config.Image}} worker-compatible-id');
  });

  it('refuses rollback before mutation when the attested worker fails runtime capability', async () => {
    const input = await fixture();
    const compatibleImage = `ghcr.io/z6v6e6r/phub-worker@${digest}`;

    const failure = await execute(input, '--confirm=ROLLBACK_STAGING_RELEASE', {
      PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER: 'true',
      FAKE_COMPATIBLE_WORKER_ID: 'worker-compatible-id',
      FAKE_COMPATIBLE_WORKER_IMAGE: compatibleImage,
      FAKE_WORKER_CAPABILITY_STATUS: '1',
    }).catch((error: CommandFailure) => error);

    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).stderr).toContain('phub.client-media-rollback.v1');
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
  });

  it('fails before changing files when a saved image reference is mutable', async () => {
    const input = await fixture();
    const releasePath = join(input.backup, 'release.env');
    const release = await readFile(releasePath, 'utf8');
    await writeFile(
      releasePath,
      release.replace(`API_IMAGE_DIGEST=${digest}`, 'API_IMAGE_DIGEST=latest'),
    );

    const failure = await execute(input).catch((error: CommandFailure) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain(
      'every saved image reference must use a full sha256 digest',
    );
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
    await expect(readFile(input.dockerLog, 'utf8')).rejects.toThrow();
  });

  it('reports malformed release metadata without disclosing its value', async () => {
    const input = await fixture();
    const releasePath = join(input.backup, 'release.env');
    const release = await readFile(releasePath, 'utf8');
    const secretValue = 'rollback-secret-value';
    await writeFile(releasePath, release.replace('REGISTRY=', `REGISTRY=${secretValue}\r\n#`));

    const failure = await execute(input).catch((error: CommandFailure) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('release_env_invalid line=1 key=REGISTRY');
    expect((failure as CommandFailure).stderr).toContain(
      'saved release.env contains an unsafe line',
    );
    expect((failure as CommandFailure).stdout).not.toContain(secretValue);
    expect((failure as CommandFailure).stderr).not.toContain(secretValue);
    await expect(readFile(join(input.root, 'compose.yaml'), 'utf8')).resolves.toBe(
      'current compose\n',
    );
    await expect(readFile(input.dockerLog, 'utf8')).rejects.toThrow();
  });
});
