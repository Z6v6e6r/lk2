import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../deploy/jetson/prepare-compatible-worker-rollback.sh', import.meta.url),
);
const guardScript = fileURLToPath(
  new URL('../deploy/jetson/verify-media-rollback-safe.sh', import.meta.url),
);
const directories: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;
const release = 'b'.repeat(40);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(
  input: {
    readonly clientCapability?: boolean;
    readonly communityCapability?: boolean;
    readonly workerDigest?: string;
    readonly backupComplete?: string;
    readonly omitCompletionMarker?: boolean;
    readonly stable?: boolean;
  } = {},
) {
  const stable = input.stable ?? true;
  const directory = mkdtempSync(join(tmpdir(), 'phub-compatible-worker-'));
  directories.push(directory);
  const appRoot = join(directory, 'opt', 'phub');
  const backupRoot = join(appRoot, 'backups', 'releases');
  const backup = join(backupRoot, 'pre-release');
  const fakeBin = join(directory, 'bin');
  const dockerLog = join(directory, 'docker.log');
  const baseRuntime = join(directory, 'staging.env');
  mkdirSync(backup, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(appRoot, 'infrastructure.env'), 'TEST_ONLY=true\n');
  writeFileSync(join(appRoot, 'release.env'), 'TEST_ONLY=true\n');
  writeFileSync(
    baseRuntime,
    'PROFILE_PHOTO_CLIENT_SYNC_ENABLED=false\n' +
      'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false\n' +
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false\n',
  );
  writeFileSync(
    join(appRoot, 'staging.games.env'),
    `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=${stable ? 'true' : 'false'}\n` +
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false\n',
  );
  writeFileSync(join(backup, 'compose.yaml'), 'name: phub-staging\nservices: {}\n');
  writeFileSync(join(backup, 'staging.auth.env'), 'AUTH_MODE=saved\n');
  writeFileSync(join(backup, 'staging.override.env'), 'FEATURE_MODE=saved\n');
  writeFileSync(
    join(backup, 'staging.games.env'),
    [
      'GAMES_MODE=saved',
      `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=${stable ? 'true' : 'false'}`,
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(backup, 'release.env'),
    `REGISTRY=ghcr.io/z6v6e6r\nWORKER_IMAGE_DIGEST=${input.workerDigest ?? digest}\nRELEASE=${release}\n`,
  );
  writeFileSync(
    join(backup, 'worker-capabilities.env'),
    `API_CLIENT_MEDIA_ROLLBACK_V1=true\n` +
      `WORKER_CLIENT_MEDIA_ROLLBACK_V1=${input.clientCapability === false ? 'false' : 'true'}\n` +
      `API_COMMUNITY_LOGO_ROLLBACK_V1=true\n` +
      `WORKER_COMMUNITY_LOGO_ROLLBACK_V1=${input.communityCapability === false ? 'false' : 'true'}\n`,
  );
  if (!input.omitCompletionMarker) {
    writeFileSync(join(backup, 'backup.complete'), `${input.backupComplete ?? release}\n`);
  }
  writeFileSync(
    join(fakeBin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'runtime-auth=%s runtime-override=%s runtime-games=%s\\n' \\
  "\${RUNTIME_AUTH_ENV_FILE:-}" "\${RUNTIME_OVERRIDE_ENV_FILE:-}" "\${RUNTIME_GAMES_ENV_FILE:-}" \\
  >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'ps --status running -q worker'*) printf 'saved-worker-id\\n' ;;
  *'inspect --format {{.Config.Image}} saved-worker-id'*)
    printf 'ghcr.io/z6v6e6r/phub-worker@${digest}\\n' ;;
  *'inspect --format {{range .Config.Env}}'*'saved-worker-id'*)
    printf 'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=${stable ? 'true' : 'false'}\\n'
    printf 'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false\\n' ;;
  *'exec -T worker node -e'*) exit 0 ;;
  *'rabbitmq rabbitmqctl'*)
    printf 'phub.home-projector.v1 0 0\\n' ;;
  *'schema_migrations'*) printf '1\\n' ;;
  *'user_profile_photo_sync'*) printf '0|0\\n' ;;
  *'media_cutover_state'*) printf '${stable ? '1' : '0'}\\n' ;;
  *'logo.object_key is null'*) printf '0|0|0|0|0\\n' ;;
  *'postgres'*) printf '0|0|0|0|0|0\\n' ;;
esac
exit 0
`,
  );
  chmodSync(join(fakeBin, 'docker'), 0o755);
  return { directory, appRoot, backupRoot, backup, fakeBin, dockerLog, baseRuntime, stable };
}

function execute(
  input: ReturnType<typeof fixture>,
  floor: 'client-media' | 'community-logo' = input.stable ? 'community-logo' : 'client-media',
) {
  return spawnSync('/bin/sh', [script, input.backup, 'PREPARE_COMPATIBLE_WORKER_ROLLBACK'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${input.fakeBin}:${process.env.PATH ?? ''}`,
      PHUB_ROLLBACK_APP_ROOT: input.appRoot,
      PHUB_ROLLBACK_BACKUP_ROOT: input.backupRoot,
      PHUB_ROLLBACK_HEALTH_ATTEMPTS: '1',
      PHUB_ROLLBACK_HEALTH_DELAY_SECONDS: '0',
      PHUB_ROLLBACK_BASE_RUNTIME_ENV: input.baseRuntime,
      PHUB_ROLLBACK_COMPATIBILITY_FLOOR: floor,
      FAKE_DOCKER_LOG: input.dockerLog,
    },
  });
}

function executeGuard(input: ReturnType<typeof fixture>) {
  return spawnSync('/bin/sh', [guardScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${input.fakeBin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: input.appRoot,
      PHUB_BASE_RUNTIME_ENV: input.baseRuntime,
      PHUB_MEDIA_ROLLBACK_MODE: input.stable ? 'compatible-logo' : 'compatible-client',
      PHUB_ROLLBACK_COMPATIBILITY_FLOOR: input.stable ? 'community-logo' : 'client-media',
      PHUB_MEDIA_ROLLBACK_RECHECK_SECONDS: '0',
      FAKE_DOCKER_LOG: input.dockerLog,
    },
  });
}

describe('compatible worker rollback preparation', () => {
  it('starts and verifies the attested stable saved worker when the current worker is unavailable', () => {
    const input = fixture();
    const result = execute(input);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saved compatible worker ready');
    const calls = readFileSync(input.dockerLog, 'utf8');
    expect(calls).toContain('backups/releases/pre-release/release.env');
    expect(calls).toContain('backups/releases/pre-release/staging.auth.env');
    expect(calls).toContain('backups/releases/pre-release/staging.override.env');
    expect(calls).toContain('backups/releases/pre-release/staging.games.env');
    expect(calls).toContain('up -d worker');
    expect(calls).toContain('exec saved-worker-id node -e');

    const guard = executeGuard(input);
    expect(guard.status, guard.stderr).toBe(0);
    expect(guard.stdout).toContain('verified (compatible-logo)');
  });

  it('restores a client-only saved worker without requiring the community-logo capability', () => {
    const input = fixture({ stable: false, communityCapability: false });
    const result = execute(input);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ready (client-media)');
    const guard = executeGuard(input);
    expect(guard.status, guard.stderr).toBe(0);
    expect(guard.stdout).toContain('verified (compatible-client)');
  });

  it('rejects a saved worker without the community-logo capability attestation', () => {
    const result = execute(fixture({ communityCapability: false }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lacks phub.community-logo-rollback.v1 attestation');
  });

  it('rejects a saved worker without the client-media capability attestation', () => {
    const input = fixture({ stable: false, clientCapability: false, communityCapability: false });
    const result = execute(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lacks phub.client-media-rollback.v1 attestation');
    expect(() => readFileSync(input.dockerLog, 'utf8')).toThrow();
  });

  it('rejects saved flags that do not match the explicit compatibility floor before compose up', () => {
    const input = fixture({ stable: false });
    const result = execute(input, 'community-logo');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('saved worker flags do not match');
    const calls = readFileSync(input.dockerLog, 'utf8');
    expect(calls).not.toContain('up -d worker');
  });

  it('rejects a mutable saved worker image reference', () => {
    const result = execute(fixture({ workerDigest: 'latest' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('saved worker digest is not immutable');
  });

  it('rejects an incomplete saved release before starting Docker', () => {
    const input = fixture({ omitCompletionMarker: true });
    const result = execute(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('saved backup.complete is absent or unsafe');
    expect(() => readFileSync(input.dockerLog, 'utf8')).toThrow();
  });
});
