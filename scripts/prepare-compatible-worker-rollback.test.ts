import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../deploy/jetson/prepare-compatible-worker-rollback.sh', import.meta.url),
);
const directories: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('compatible worker rollback preparation', () => {
  it('starts and verifies the attested saved worker when the current worker is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-compatible-worker-'));
    directories.push(directory);
    const appRoot = join(directory, 'opt', 'phub');
    const backupRoot = join(appRoot, 'backups', 'releases');
    const backup = join(backupRoot, 'pre-release');
    const fakeBin = join(directory, 'bin');
    const dockerLog = join(directory, 'docker.log');
    mkdirSync(backup, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(appRoot, 'infrastructure.env'), 'TEST_ONLY=true\n');
    writeFileSync(join(backup, 'compose.yaml'), 'name: phub-staging\nservices: {}\n');
    writeFileSync(join(backup, 'staging.auth.env'), 'AUTH_MODE=saved\n');
    writeFileSync(join(backup, 'staging.override.env'), 'FEATURE_MODE=saved\n');
    writeFileSync(join(backup, 'staging.games.env'), 'GAMES_MODE=saved\n');
    writeFileSync(
      join(backup, 'release.env'),
      `REGISTRY=ghcr.io/z6v6e6r\nWORKER_IMAGE_DIGEST=${digest}\nRELEASE=${'b'.repeat(40)}\n`,
    );
    writeFileSync(
      join(backup, 'worker-capabilities.env'),
      'API_CLIENT_MEDIA_ROLLBACK_V1=true\nWORKER_CLIENT_MEDIA_ROLLBACK_V1=true\n',
    );
    writeFileSync(join(backup, 'backup.complete'), `${'b'.repeat(40)}\n`);
    writeFileSync(
      join(fakeBin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'runtime-auth=%s runtime-override=%s runtime-games=%s\\n' \
  "\${RUNTIME_AUTH_ENV_FILE:-}" "\${RUNTIME_OVERRIDE_ENV_FILE:-}" "\${RUNTIME_GAMES_ENV_FILE:-}" \
  >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'ps --status running -q worker'*) printf 'saved-worker-id\\n' ;;
  *'inspect --format {{.Config.Image}} saved-worker-id'*)
    printf 'ghcr.io/z6v6e6r/phub-worker@${digest}\\n' ;;
esac
exit 0
`,
    );
    chmodSync(join(fakeBin, 'docker'), 0o755);

    const output = execFileSync('/bin/sh', [script, backup, 'PREPARE_COMPATIBLE_WORKER_ROLLBACK'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_ROLLBACK_APP_ROOT: appRoot,
        PHUB_ROLLBACK_BACKUP_ROOT: backupRoot,
        PHUB_ROLLBACK_HEALTH_ATTEMPTS: '1',
        PHUB_ROLLBACK_HEALTH_DELAY_SECONDS: '0',
        FAKE_DOCKER_LOG: dockerLog,
      },
    });

    expect(output).toContain('Saved compatible worker ready');
    const calls = readFileSync(dockerLog, 'utf8');
    expect(calls).toContain('backups/releases/pre-release/release.env');
    expect(calls).toContain('backups/releases/pre-release/staging.auth.env');
    expect(calls).toContain('backups/releases/pre-release/staging.override.env');
    expect(calls).toContain('backups/releases/pre-release/staging.games.env');
    expect(calls).toContain('up -d worker');
    expect(calls).toContain('exec saved-worker-id node -e');
  });
});
