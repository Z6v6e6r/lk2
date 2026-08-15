import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('media rollback safety guard', () => {
  it('fails closed when RabbitMQ queue inspection fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-media-rollback-'));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(directory, 'infrastructure.env'), 'TEST_ONLY=true\n');
    writeFileSync(join(directory, 'release.env'), 'TEST_ONLY=true\n');
    const baseRuntime = join(directory, 'staging.env');
    writeFileSync(baseRuntime, 'APP_ENV=staging\n');
    const docker = join(fakeBin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
args="$*"
case "$args" in
  *"rabbitmq rabbitmqctl"*) exit 42 ;;
  *"postgres"*"0079_profile_photo_client_assisted_source.sql"*) printf '0\\n' ;;
  *"postgres"*"0080_community_logo_stable_delivery.sql"*) printf '1\\n' ;;
  *"postgres"*"media_cutover_state"*) printf '1\\n' ;;
  *"postgres"*) printf '0|0|0|0|0|0\\n' ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../deploy/jetson/verify-media-rollback-safe.sh',
    );

    const result = spawnSync('sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: directory,
        PHUB_BASE_RUNTIME_ENV: baseRuntime,
        PHUB_MEDIA_ROLLBACK_RECHECK_SECONDS: '0',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot inspect the Home projector queue');
  });

  it('keeps pre-cutover rollback available with legacy GC and no incompatible writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-media-rollback-'));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(directory, 'infrastructure.env'), 'TEST_ONLY=true\n');
    writeFileSync(join(directory, 'release.env'), 'TEST_ONLY=true\n');
    const baseRuntime = join(directory, 'staging.env');
    writeFileSync(baseRuntime, 'APP_ENV=staging\n');
    const docker = join(fakeBin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
args="$*"
case "$args" in
  *"rabbitmq rabbitmqctl"*) exit 42 ;;
  *"postgres"*"0079_profile_photo_client_assisted_source.sql"*) printf '1\\n' ;;
  *"postgres"*"0080_community_logo_stable_delivery.sql"*) printf '1\\n' ;;
  *"postgres"*"media_cutover_state"*) printf '0\\n' ;;
  *"postgres"*"profile_photo_client_commands"*) printf '0|0\\n' ;;
  *"postgres"*) printf '0|0|0|0|0|0\\n' ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../deploy/jetson/verify-media-rollback-safe.sh',
    );

    const result = spawnSync('sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: directory,
        PHUB_BASE_RUNTIME_ENV: baseRuntime,
        PHUB_MEDIA_ROLLBACK_MODE: 'pre-cutover',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (pre-cutover)');
  });

  it('rejects pre-cutover rollback after a durable stable-delivery cutover', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-media-rollback-'));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(directory, 'infrastructure.env'), 'TEST_ONLY=true\n');
    writeFileSync(join(directory, 'release.env'), 'TEST_ONLY=true\n');
    const baseRuntime = join(directory, 'staging.env');
    writeFileSync(baseRuntime, 'APP_ENV=staging\n');
    const docker = join(fakeBin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
args="$*"
case "$args" in
  *"postgres"*"0079_profile_photo_client_assisted_source.sql"*) printf '0\\n' ;;
  *"postgres"*"0080_community_logo_stable_delivery.sql"*) printf '1\\n' ;;
  *"postgres"*"media_cutover_state"*) printf '1\\n' ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../deploy/jetson/verify-media-rollback-safe.sh',
    );

    const result = spawnSync('sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: directory,
        PHUB_BASE_RUNTIME_ENV: baseRuntime,
        PHUB_MEDIA_ROLLBACK_MODE: 'pre-cutover',
      },
    });

    expect(result.status).toBe(42);
    expect(result.stderr).toContain('compatible saved release');
  });

  it('drains the Home queue in compatible-worker mode without requiring source URLs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-media-rollback-'));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(directory, 'infrastructure.env'), 'TEST_ONLY=true\n');
    writeFileSync(join(directory, 'release.env'), 'TEST_ONLY=true\n');
    const baseRuntime = join(directory, 'staging.env');
    writeFileSync(baseRuntime, 'APP_ENV=staging\n');
    const docker = join(fakeBin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
args="$*"
case "$args" in
  *"rabbitmq rabbitmqctl"*) exit 42 ;;
  *"postgres"*"0079_profile_photo_client_assisted_source.sql"*) printf '1\\n' ;;
  *"postgres"*"0080_community_logo_stable_delivery.sql"*) printf '1\\n' ;;
  *"postgres"*"profile_photo_client_commands"*) printf '1|0\\n' ;;
  *"postgres"*"media_cutover_state"*) printf '1\\n' ;;
  *"postgres"*) printf '0|0|0|0|0|0\\n' ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../deploy/jetson/verify-media-rollback-safe.sh',
    );

    const result = spawnSync('sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: directory,
        PHUB_BASE_RUNTIME_ENV: baseRuntime,
        PHUB_MEDIA_ROLLBACK_RECHECK_SECONDS: '0',
        PHUB_MEDIA_ROLLBACK_MODE: 'compatible-worker',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot inspect the Home projector queue');
  });
});
