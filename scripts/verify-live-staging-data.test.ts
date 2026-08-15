import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../deploy/jetson/verify-live-staging-data.sh', import.meta.url),
  'utf8',
);
const runtimeAttestation = source.match(
  /require_running_flag\(\) \{[\s\S]*?require_running_flag worker COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false/,
)?.[0];
if (!runtimeAttestation) throw new Error('Community-logo runtime attestation block is missing');
const temporaryDirectories: string[] = [];

function runPreflight(input: {
  readonly stableDelivery: 'false' | 'true';
  readonly compatibilityBackfill: 'false' | 'true';
  readonly mode?: 'preflight' | 'runtime-flags';
  readonly apiStable?: 'false' | 'true';
  readonly workerStable?: 'false' | 'true';
}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-live-staging-flags-'));
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, 'bin');
  mkdirSync(fakeBin);
  const stat = join(fakeBin, 'stat');
  writeFileSync(stat, '#!/bin/sh\nprintf "600\\n"\n');
  chmodSync(stat, 0o755);
  const docker = join(fakeBin, 'docker');
  writeFileSync(
    docker,
    [
      '#!/bin/sh',
      'args="$*"',
      'case "$args" in',
      '  *"exec -T api node -e"*) service=api ;;',
      '  *"exec -T worker node -e"*) service=worker ;;',
      '  *) exit 1 ;;',
      'esac',
      'while test "$#" -gt 2; do shift; done',
      'key="$1"',
      'expected="$2"',
      'case "${service}:${key}" in',
      '  api:COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED) actual="$API_STABLE" ;;',
      '  worker:COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED) actual="$WORKER_STABLE" ;;',
      '  api:COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED) actual="$API_BACKFILL" ;;',
      '  worker:COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED) actual="$WORKER_BACKFILL" ;;',
      '  *) exit 1 ;;',
      'esac',
      'test "$actual" = "$expected"',
      '',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);

  const base = join(directory, 'staging.env');
  const auth = join(directory, 'staging.auth.env');
  const home = join(directory, 'staging.override.env');
  const games = join(directory, 'staging.games.env');
  writeFileSync(
    base,
    [
      'APP_ENV=staging',
      'VIVA_MODE=sandbox',
      'VIVA_OAUTH_ENABLED=true',
      'HOME_BASE_SYNC_ENABLED=true',
      'HOME_READ_MODE=projection',
      'COMMUNITIES_READ_MODE=legacy',
      'PROMOTIONS_READ_MODE=legacy',
      'GAMES_READ_ENABLED=true',
      'GAMES_COMMANDS_ENABLED=false',
      'LEGACY_GAMES_ROSTER_SYNC_ENABLED=true',
      'LEGACY_GAMES_ROSTER_SYNC_SOURCE=mongo',
      'LEGACY_GAMES_MONGODB_URI=mongodb://synthetic.invalid/phub',
      'LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY=synthetic',
      'ACTIVITY_HISTORY_ENABLED=true',
      'ACTIVITY_HISTORY_SYNC_ENABLED=true',
      'ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED=true',
    ].join('\n'),
  );
  writeFileSync(
    auth,
    [
      'CORS_ORIGINS=https://lk.nano.padlhub.su',
      'VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED=true',
      'VIVA_OAUTH_REDIRECT_URI=https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback',
      'VIVA_OAUTH_SUCCESS_REDIRECT_URL=https://lk.nano.padlhub.su/',
    ].join('\n'),
  );
  writeFileSync(home, '');
  writeFileSync(
    games,
    [
      `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=${input.stableDelivery}`,
      `COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=${input.compatibilityBackfill}`,
    ].join('\n'),
  );
  chmodSync(auth, 0o600);
  chmodSync(games, 0o600);

  const script = join(directory, 'verify-live-staging-data.sh');
  writeFileSync(
    script,
    source
      .replace('cd /opt/phub', `cd ${JSON.stringify(directory)}`)
      .replace('/etc/phub/staging.env', base)
      .replace('/opt/phub/staging.auth.env', auth)
      .replace('/opt/phub/staging.override.env', home)
      .replace('/opt/phub/staging.games.env', games),
  );
  chmodSync(script, 0o755);
  return spawnSync('sh', [script, input.mode ?? 'preflight'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      API_STABLE: input.apiStable ?? input.stableDelivery,
      WORKER_STABLE: input.workerStable ?? input.stableDelivery,
      API_BACKFILL: 'false',
      WORKER_BACKFILL: 'false',
    },
  });
}

function runRuntimeAttestation(input: {
  readonly apiStable: 'false' | 'true';
  readonly workerStable: 'false' | 'true';
}) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-live-staging-runtime-flags-'));
  temporaryDirectories.push(directory);
  const script = join(directory, 'attest-runtime-flags.sh');
  writeFileSync(
    script,
    `#!/bin/sh
set -eu
compose() {
  service="$3"
  key="$7"
  expected="$8"
  case "${'${service}'}:${'${key}'}" in
    api:COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED) actual="$API_STABLE" ;;
    worker:COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED) actual="$WORKER_STABLE" ;;
    api:COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED) actual="$API_BACKFILL" ;;
    worker:COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED) actual="$WORKER_BACKFILL" ;;
    *) return 1 ;;
  esac
  test "$actual" = "$expected"
}
community_logo_stable_delivery=true
${runtimeAttestation}
`,
  );
  chmodSync(script, 0o755);
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      API_STABLE: input.apiStable,
      WORKER_STABLE: input.workerStable,
      API_BACKFILL: 'false',
      WORKER_BACKFILL: 'false',
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('live staging community-logo flag preflight', () => {
  it('accepts a repeat deploy in the stable state', () => {
    const result = runPreflight({ stableDelivery: 'true', compatibilityBackfill: 'false' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Real staging data configuration verified');
  });

  it('keeps compatibility backfill outside the normal deploy path', () => {
    const result = runPreflight({ stableDelivery: 'false', compatibilityBackfill: 'true' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED must equal false',
    );
  });

  it('attests the selected stable state in both running API and worker processes', () => {
    const result = runRuntimeAttestation({ apiStable: 'true', workerStable: 'true' });

    expect(result.status, result.stderr).toBe(0);
  });

  it('runs the flag-only postcheck through the complete verifier entrypoint', () => {
    const result = runPreflight({
      stableDelivery: 'true',
      compatibilityBackfill: 'false',
      mode: 'runtime-flags',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Community-logo runtime flags verified');
  });

  it('fails the complete flag-only postcheck when one runtime kept the old state', () => {
    const result = runPreflight({
      stableDelivery: 'true',
      compatibilityBackfill: 'false',
      mode: 'runtime-flags',
      workerStable: 'false',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED must equal true',
    );
  });

  it('fails when a running process did not receive the selected stable flag', () => {
    const result = runRuntimeAttestation({ apiStable: 'true', workerStable: 'false' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED must equal true',
    );
  });
});
