import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../deploy/jetson/verify-media-rollback-safe.sh',
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executeGuard(input: {
  readonly mode: 'pre-cutover' | 'compatible-client' | 'compatible-logo' | 'feature';
  readonly floor?: 'client-media' | 'community-logo';
  readonly cutoverActive: boolean;
  readonly queueInspectionFails?: boolean;
  readonly queueMessages?: number;
  readonly capabilityFails?: boolean;
  readonly apiProfileClient?: boolean;
  readonly apiStable?: boolean;
  readonly apiBackfill?: boolean;
  readonly profileCommands?: number;
  readonly profileGc?: number;
  readonly profileNullSources?: number;
  readonly runtimeStable?: boolean;
  readonly runtimeBackfill?: boolean;
  readonly workerStable?: boolean;
  readonly workerBackfill?: boolean;
  readonly apiPresent?: boolean;
  readonly workerPresent?: boolean;
  readonly preCutoverCounts?: string;
  readonly stableCounts?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-media-rollback-'));
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, 'bin');
  const dockerLog = join(directory, 'docker.log');
  mkdirSync(fakeBin);
  writeFileSync(dockerLog, '');
  writeFileSync(join(directory, 'infrastructure.env'), 'TEST_ONLY=true\n');
  writeFileSync(join(directory, 'release.env'), 'TEST_ONLY=true\n');
  const runtimeStable = input.runtimeStable ?? input.mode === 'compatible-logo';
  const apiStable = input.apiStable ?? input.mode === 'compatible-logo';
  const workerStable = input.workerStable ?? input.mode === 'compatible-logo';
  const baseRuntime = join(directory, 'staging.env');
  writeFileSync(
    baseRuntime,
    [
      'APP_ENV=staging',
      `PROFILE_PHOTO_CLIENT_SYNC_ENABLED=${input.apiProfileClient ? 'true' : 'false'}`,
      `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=${runtimeStable ? 'true' : 'false'}`,
      `COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=${input.runtimeBackfill ? 'true' : 'false'}`,
      '',
    ].join('\n'),
  );
  const docker = join(fakeBin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
args="$*"
case "$args" in
  *"ps --status running -q worker"*)
    test "\${FAKE_WORKER_PRESENT:-1}" = 0 || printf 'worker-id\\n' ;;
  *"ps --status running -q api"*)
    test "\${FAKE_API_PRESENT:-1}" = 0 || printf 'api-id\\n' ;;
  *"inspect --format"*"worker-id"*)
    printf 'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=%s\\n' "\${FAKE_WORKER_STABLE:-false}"
    printf 'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=%s\\n' "\${FAKE_WORKER_BACKFILL:-false}" ;;
  *"inspect --format"*"api-id"*)
    printf 'PROFILE_PHOTO_CLIENT_SYNC_ENABLED=%s\\n' "\${FAKE_API_PROFILE_CLIENT:-false}"
    printf 'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=%s\\n' "\${FAKE_API_STABLE:-false}"
    printf 'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=%s\\n' "\${FAKE_API_BACKFILL:-false}" ;;
  *"exec -T worker node -e"*) exit "\${FAKE_CAPABILITY_STATUS:-0}" ;;
  *"rabbitmq rabbitmqctl"*)
    test "\${FAKE_QUEUE_FAILURE:-0}" = 0 || exit 42
    printf 'phub.home-projector.v1 %s 0\\n' "\${FAKE_QUEUE_MESSAGES:-0}" ;;
  *"schema_migrations"*) printf '1\\n' ;;
  *"profile_photo_client_commands"*)
    printf '%s|%s\\n' "\${FAKE_PROFILE_NULL_SOURCES:-0}" "\${FAKE_PROFILE_COMMANDS:-0}" ;;
  *"profile_photo_object_gc"*) printf '%s\\n' "\${FAKE_PROFILE_GC:-0}" ;;
  *"select count"*"media_cutover_state"*) printf '%s\\n' "\${FAKE_CUTOVER_ACTIVE:-0}" ;;
  *"update integration.media_cutover_state"*) exit 0 ;;
  *"logo.object_key is null"*) printf '%s\\n' "\${FAKE_STABLE_COUNTS:-0|0|0|0|0}" ;;
  *"postgres"*) printf '%s\\n' "\${FAKE_PRECUTOVER_COUNTS:-0|0|0|0|0|0}" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);

  const floor =
    input.floor ??
    (input.mode === 'compatible-client'
      ? 'client-media'
      : input.mode === 'compatible-logo'
        ? 'community-logo'
        : undefined);
  const result = spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: directory,
      PHUB_BASE_RUNTIME_ENV: baseRuntime,
      PHUB_MEDIA_ROLLBACK_MODE: input.mode,
      PHUB_MEDIA_ROLLBACK_RECHECK_SECONDS: '0',
      ...(floor ? { PHUB_ROLLBACK_COMPATIBILITY_FLOOR: floor } : {}),
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_CUTOVER_ACTIVE: input.cutoverActive ? '1' : '0',
      FAKE_QUEUE_FAILURE: input.queueInspectionFails ? '1' : '0',
      FAKE_CAPABILITY_STATUS: input.capabilityFails ? '1' : '0',
      FAKE_API_PROFILE_CLIENT: input.apiProfileClient ? 'true' : 'false',
      FAKE_API_STABLE: apiStable ? 'true' : 'false',
      FAKE_API_BACKFILL: input.apiBackfill ? 'true' : 'false',
      FAKE_PROFILE_COMMANDS: String(input.profileCommands ?? 0),
      FAKE_PROFILE_GC: String(input.profileGc ?? 0),
      FAKE_PROFILE_NULL_SOURCES: String(input.profileNullSources ?? 0),
      FAKE_WORKER_STABLE: workerStable ? 'true' : 'false',
      FAKE_WORKER_BACKFILL: input.workerBackfill ? 'true' : 'false',
      FAKE_API_PRESENT: input.apiPresent === false ? '0' : '1',
      FAKE_WORKER_PRESENT: input.workerPresent === false ? '0' : '1',
      FAKE_QUEUE_MESSAGES: String(input.queueMessages ?? 0),
      FAKE_PRECUTOVER_COUNTS: input.preCutoverCounts ?? '0|0|0|0|0|0',
      FAKE_STABLE_COUNTS: input.stableCounts ?? '0|0|0|0|0',
    },
  });
  return { result, dockerLog: readFileSync(dockerLog, 'utf8') };
}

describe('media rollback safety guard', () => {
  it('keeps pre-cutover rollback available before stable delivery is observed', () => {
    const { result, dockerLog } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (pre-cutover)');
    expect(dockerLog).not.toContain('rabbitmq rabbitmqctl');
  });

  it('keeps pre-cutover classification available when failed API and worker are absent', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      apiPresent: false,
      workerPresent: false,
    });

    expect(result.status).toBe(0);
  });

  it('classifies a durable stable-delivery cutover as community-logo compatible', () => {
    const { result } = executeGuard({ mode: 'pre-cutover', cutoverActive: true });

    expect(result.status).toBe(43);
    expect(result.stderr).toContain('community-logo compatibility floor');
  });

  it('fails closed while client-assisted profile writes are active', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      apiProfileClient: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('client-assisted profile-photo writes are active');
  });

  it('classifies nullable client mappings as client-media compatible', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      profileNullSources: 1,
    });

    expect(result.status).toBe(42);
    expect(result.stderr).toContain('client-media compatibility floor');
  });

  it('gives stable-logo evidence precedence over nullable client mappings', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: true,
      profileNullSources: 1,
    });

    expect(result.status).toBe(43);
    expect(result.stderr).toContain('community-logo compatibility floor');
  });

  it('allows the client-media floor to retain nullable client-photo mappings', () => {
    const { result } = executeGuard({
      mode: 'compatible-client',
      cutoverActive: false,
      profileNullSources: 1,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (compatible-client)');
  });

  it('allows the client-media floor while the failed API is absent', () => {
    const { result } = executeGuard({
      mode: 'compatible-client',
      cutoverActive: false,
      profileNullSources: 1,
      apiPresent: false,
    });

    expect(result.status).toBe(0);
  });

  it('rejects rollback while profile-photo client commands are not drained', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      profileCommands: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('profile-photo client commands are not drained (1)');
  });

  it('accepts an attested stable saved worker and drains the Home queue', () => {
    const { result, dockerLog } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      workerStable: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (compatible-logo)');
    expect(dockerLog).toContain('exec -T worker node -e');
    expect(dockerLog.match(/rabbitmq rabbitmqctl/g)).toHaveLength(1);
    expect(dockerLog).not.toContain('stop worker');
  });

  it('rejects an automatic compatible rollback that would disable stable delivery', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      workerStable: false,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'running worker must have COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=true',
    );
  });

  it('rejects compatibility backfill in the stable-to-stable automatic rollback path', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      workerStable: true,
      workerBackfill: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'running worker must have COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false',
    );
  });

  it('keeps the compatible stable API route while proving client profile writes are disabled', () => {
    const { result, dockerLog } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      apiStable: true,
      workerStable: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (compatible-logo)');
    expect(dockerLog).toContain('ps --status running -q api');
    expect(dockerLog).toContain('inspect --format {{range .Config.Env}}');
  });

  it('allows the community-logo floor while the failed API is absent', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      apiPresent: false,
    });

    expect(result.status).toBe(0);
  });

  it('rejects a present API that would select legacy logo URLs on the community-logo floor', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      apiStable: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'running api must have COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=true',
    );
  });

  it('rejects a community-logo floor whose effective runtime flag is disabled', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      runtimeStable: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stable community-logo delivery is not active');
  });

  it('never routes stable payload evidence through the client-media floor', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      profileNullSources: 1,
      preCutoverCounts: '1|0|0|0|0|0',
    });

    expect(result.status).toBe(43);
    expect(result.stderr).toContain('community-logo compatibility floor');
  });

  it('rejects the client-media floor after a stable-logo cutover', () => {
    const { result } = executeGuard({
      mode: 'compatible-client',
      cutoverActive: true,
      profileNullSources: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot cross a stable-logo cutover');
  });

  it('rejects a mismatched explicit compatibility floor', () => {
    const { result, dockerLog } = executeGuard({
      mode: 'compatible-client',
      floor: 'community-logo',
      cutoverActive: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rollback mode and PHUB_ROLLBACK_COMPATIBILITY_FLOOR disagree');
    expect(dockerLog).toBe('');
  });

  it('rejects unresolved stable mappings before a stable-to-stable rollback', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      workerStable: true,
      stableCounts: '1|0|0|0|0',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stable community-logo state has unresolved mappings');
  });

  it('rejects a stable-to-stable rollback while the Home queue is not drained', () => {
    const { result } = executeGuard({
      mode: 'compatible-logo',
      cutoverActive: true,
      workerStable: true,
      queueMessages: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Home projector queue is missing or not drained');
  });

  it('fails closed when compatibility backfill is active during classification', () => {
    const { result } = executeGuard({
      mode: 'pre-cutover',
      cutoverActive: false,
      runtimeBackfill: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('community-logo compatibility backfill is active');
  });

  it('stops the worker and clears the marker only after a converged feature drain', () => {
    const { result, dockerLog } = executeGuard({ mode: 'feature', cutoverActive: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified (feature)');
    expect(dockerLog).toContain('stop worker');
    expect(dockerLog).toContain('update integration.media_cutover_state');
    expect(dockerLog.match(/rabbitmq rabbitmqctl/g)).toHaveLength(2);
  });

  it('refuses a feature rollback while the running API still selects stable URLs', () => {
    const { result } = executeGuard({
      mode: 'feature',
      cutoverActive: true,
      apiStable: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'running api must have COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false',
    );
  });

  it('fails closed when RabbitMQ queue inspection fails', () => {
    const { result } = executeGuard({
      mode: 'feature',
      cutoverActive: true,
      queueInspectionFails: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot inspect the Home projector queue');
  });

  it('rejects a feature rollback while profile-photo object GC is not drained', () => {
    const { result } = executeGuard({
      mode: 'feature',
      cutoverActive: true,
      profileGc: 1,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('profile-photo feature drain still has object GC rows (1)');
  });
});
