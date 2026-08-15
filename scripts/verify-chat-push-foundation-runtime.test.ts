import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const verifier = fileURLToPath(
  new URL('../deploy/jetson/verify-chat-push-foundation-runtime.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phub-chat-push-runtime-'));
  temporaryDirectories.push(root);
  const appRoot = join(root, 'app');
  const bin = join(root, 'bin');
  const log = join(root, 'docker.log');
  mkdirSync(appRoot);
  mkdirSync(bin);
  writeFileSync(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n');
  writeFileSync(join(appRoot, 'release.env'), 'RELEASE=test\n');
  const overlay = join(appRoot, 'staging.chat-push-foundation.env');
  writeFileSync(
    overlay,
    'WEB_PUSH_ENABLED=false\n' +
      'MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false\n' +
      'BOOKING_REMINDER_SCHEDULER_ENABLED=false\n',
    { mode: 0o600 },
  );
  const candidateDirectory = join(appRoot, 'backups', 'releases', 'pre-candidate-1-1');
  mkdirSync(candidateDirectory, { recursive: true });
  const candidateRelease = join(candidateDirectory, 'foundation.candidate-release.env');
  const candidateReleaseContents =
    'REGISTRY=ghcr.io/z6v6e6r\n' +
    `API_IMAGE_DIGEST=sha256:${'a'.repeat(64)}\n` +
    `WORKER_IMAGE_DIGEST=sha256:${'b'.repeat(64)}\n` +
    `REALTIME_IMAGE_DIGEST=sha256:${'c'.repeat(64)}\n` +
    `WEB_IMAGE_DIGEST=sha256:${'d'.repeat(64)}\n`;
  writeFileSync(candidateRelease, candidateReleaseContents, { mode: 0o600 });
  const candidateManifest = join(candidateDirectory, 'chat-push-foundation.recovery');
  const candidateManifestContents = `CANDIDATE_RELEASE_SHA256=${createHash('sha256').update(candidateReleaseContents).digest('hex')}\n`;
  writeFileSync(candidateManifest, candidateManifestContents, { mode: 0o600 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'ps --status running -q api'*) printf '%s\n' "\${FAKE_API_IDS:-}" ;;
  *'ps --status running -q worker'*) printf '%s\n' "\${FAKE_WORKER_IDS:-}" ;;
  *'ps --status running -q realtime'*) printf '%s\n' "\${FAKE_REALTIME_IDS:-}" ;;
  *'ps --status running -q web'*) printf '%s\n' "\${FAKE_WEB_IDS:-}" ;;
  *'exec '*' api') exit "\${FAKE_API_FLAG_STATUS:-0}" ;;
  *'exec '*' worker') exit "\${FAKE_WORKER_FLAG_STATUS:-0}" ;;
  *'inspect --format {{.State.Health.Status}} aa11'*) printf '%s\n' "\${FAKE_API_HEALTH:-healthy}" ;;
  *'inspect --format {{.State.Health.Status}} bb22'*) printf '%s\n' "\${FAKE_WORKER_HEALTH:-healthy}" ;;
  *'inspect --format {{.State.Health.Status}} cc33'*) printf '%s\n' "\${FAKE_REALTIME_HEALTH:-healthy}" ;;
  *'inspect --format {{.State.Health.Status}} dd44'*) printf '%s\n' "\${FAKE_WEB_HEALTH:-healthy}" ;;
  *'inspect --format {{.Config.Image}} aa11'*) printf '%s\n' "\${FAKE_API_IMAGE:-ghcr.io/z6v6e6r/phub-api@sha256:${'a'.repeat(64)}}" ;;
  *'inspect --format {{.Config.Image}} bb22'*) printf '%s\n' "\${FAKE_WORKER_IMAGE:-ghcr.io/z6v6e6r/phub-worker@sha256:${'b'.repeat(64)}}" ;;
  *'inspect --format {{.Config.Image}} cc33'*) printf '%s\n' "\${FAKE_REALTIME_IMAGE:-ghcr.io/z6v6e6r/phub-realtime@sha256:${'c'.repeat(64)}}" ;;
  *'inspect --format {{.Config.Image}} dd44'*) printf '%s\n' "\${FAKE_WEB_IMAGE:-ghcr.io/z6v6e6r/phub-web@sha256:${'d'.repeat(64)}}" ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'stat'), '#!/bin/sh\nprintf "%s\\n" 600\n');
  chmodSync(join(bin, 'stat'), 0o755);
  return {
    root,
    appRoot,
    bin,
    log,
    overlay,
    candidateRelease,
    candidateReleaseContents,
    candidateManifest,
    candidateManifestContents,
  };
}

function execute(
  input: ReturnType<typeof fixture>,
  mode: string,
  environment: Record<string, string> = {},
  modeArguments: readonly string[] = [],
) {
  return spawnSync('/bin/sh', [verifier, mode, ...modeArguments], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${input.bin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: input.appRoot,
      FAKE_DOCKER_LOG: input.log,
      FAKE_API_IDS: 'aa11',
      FAKE_WORKER_IDS: 'bb22',
      FAKE_REALTIME_IDS: 'cc33',
      FAKE_WEB_IDS: 'dd44',
      ...environment,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('chat/push foundation runtime verifier', () => {
  it('checks every current API and worker replica before drain', () => {
    const input = fixture();
    const result = execute(input, 'preflight', { FAKE_API_IDS: 'aa11\naa12' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mode=preflight');
    const calls = readFileSync(input.log, 'utf8');
    expect(calls).toContain('exec aa11 node --input-type=module -e');
    expect(calls).toContain('exec aa12 node --input-type=module -e');
    expect(calls).toContain('exec bb22 node --input-type=module -e');
  });

  it('fails when a runtime reports an enabled or invalid gate', () => {
    const input = fixture();
    const result = execute(input, 'preflight', { FAKE_WORKER_FLAG_STATUS: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker has an enabled or invalid foundation gate');
  });

  it('requires a complete drain and enforces API then worker then realtime ordering', () => {
    const input = fixture();
    expect(execute(input, 'drained').status).toBe(1);
    expect(
      execute(input, 'drained', {
        FAKE_API_IDS: '',
        FAKE_WORKER_IDS: '',
        FAKE_REALTIME_IDS: '',
      }).status,
    ).toBe(0);
    expect(execute(input, 'api-ready', { FAKE_WORKER_IDS: '', FAKE_REALTIME_IDS: '' }).status).toBe(
      0,
    );
    expect(execute(input, 'worker-ready', { FAKE_REALTIME_IDS: '' }).status).toBe(0);
    expect(execute(input, 'realtime-ready').status).toBe(0);
  });

  it('rejects extra, duplicate or unsafe overlay settings', () => {
    const input = fixture();
    writeFileSync(
      input.overlay,
      'WEB_PUSH_ENABLED=false\n' +
        'MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false\n' +
        'BOOKING_REMINDER_SCHEDULER_ENABLED=false\n' +
        'DATABASE_URL=forbidden\n',
      { mode: 0o600 },
    );

    const result = execute(input, 'overlay');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly three lines');
  });

  it('rejects every Compose interpolation path that redirects the effective overlay', () => {
    const input = fixture();
    expect(
      execute(input, 'overlay', {
        RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE: join(input.root, 'redirected.env'),
      }).status,
    ).toBe(1);

    writeFileSync(
      join(input.appRoot, 'release.env'),
      'RELEASE=test\nRUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE=/tmp/redirected.env\n',
    );
    const result = execute(input, 'overlay');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release.env redirects the foundation overlay');
  });

  it('checks the same process environment keys used by config defaults', () => {
    const source = readFileSync(verifier, 'utf8');
    expect(source).toContain('WEB_PUSH_ENABLED');
    expect(source).toContain('MESSAGING_USER_BLOCK_COMMANDS_ENABLED');
    expect(source).toContain('BOOKING_REMINDER_SCHEDULER_ENABLED');
    expect(source).toContain('loadConfig(process.env, { profilePhotoStorage: true })');
    expect(source).toContain('config[key] !== undefined && config[key] !== false');
    expect(source).not.toMatch(/^\s*env\s*\|/m);
  });

  it('keeps an active candidate only when release, health and every image digest match', () => {
    const input = fixture();
    writeFileSync(join(input.appRoot, 'release.env'), input.candidateReleaseContents, {
      mode: 0o600,
    });

    expect(execute(input, 'candidate-active', {}, [input.candidateRelease]).status).toBe(0);
    expect(
      execute(input, 'candidate-active', { FAKE_WORKER_HEALTH: 'unhealthy' }, [
        input.candidateRelease,
      ]).status,
    ).toBe(1);
    expect(
      execute(input, 'candidate-active', { FAKE_WORKER_IMAGE: 'unexpected' }, [
        input.candidateRelease,
      ]).status,
    ).toBe(1);

    writeFileSync(input.candidateManifest, `CANDIDATE_RELEASE_SHA256=${'0'.repeat(64)}\n`, {
      mode: 0o600,
    });
    expect(execute(input, 'candidate-active', {}, [input.candidateRelease]).status).toBe(1);
    writeFileSync(input.candidateManifest, input.candidateManifestContents, { mode: 0o600 });

    writeFileSync(join(input.appRoot, 'release.env'), 'RELEASE=old\n');
    expect(execute(input, 'candidate-active', {}, [input.candidateRelease]).status).toBe(1);
  });
});
