import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/legacy-otp-hotfix-canary.yaml', 'utf8');
const controller = readFileSync('deploy/jetson/run-legacy-otp-hotfix-canary.sh', 'utf8');
const verifier = readFileSync('deploy/jetson/verify-legacy-otp-hotfix-source.sh', 'utf8');
const checkout = readFileSync('deploy/jetson/checkout-legacy-otp-hotfix-candidate.sh', 'utf8');
const guard = readFileSync('deploy/jetson/verify-runtime-secret-transition-clear.sh', 'utf8');
const integrationIdentityMigration = readFileSync(
  'packages/database/migrations/0004_integration_identity_boundary.sql',
  'utf8',
);

const authorityStart = workflow.indexOf('      - id: authority\n');
const authorityRun = workflow.indexOf('        run: |\n', authorityStart);
const authorityEnd = workflow.indexOf('\n      - uses:', authorityRun);
const authorityScript = workflow
  .slice(authorityRun + '        run: |\n'.length, authorityEnd)
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n');

const validAuthority = {
  OPERATION: 'RECOVER',
  EXPECTED_ACTIVE_RELEASE: 'e308181da5222645d9a87d03642923c6841be8d1',
  CANDIDATE_SHA: '1'.repeat(40),
  CONFIRMATION: 'RECOVER_LEGACY_OTP_HOTFIX_CANARY',
  ORIGINAL_CONTROL_SHA: '2'.repeat(40),
  ORIGINAL_RUN_ID: '12345',
  ORIGINAL_RUN_ATTEMPT: '1',
  REQUEST_REF: 'refs/heads/main',
  CONTROL_SHA: '3'.repeat(40),
  WORKFLOW_SHA: '3'.repeat(40),
  SUPPORTED_ACTIVE_RELEASE: 'e308181da5222645d9a87d03642923c6841be8d1',
};

function runAuthority(overrides: Record<string, string>) {
  return spawnSync('sh', ['-c', authorityScript], {
    env: { ...process.env, GITHUB_OUTPUT: '/dev/null', ...validAuthority, ...overrides },
  });
}

const activeRelease = 'e308181da5222645d9a87d03642923c6841be8d1';
const candidateRelease = '1'.repeat(40);
const controlRelease = '2'.repeat(40);
const composeSha = 'a9227a66be5044d0286592afb27aca073d50aa8d2ff21067504a0ffdb1804c2a';

function releaseFile(release: string, digestCharacter: string) {
  return [
    'REGISTRY=ghcr.io/z6v6e6r',
    `RELEASE=${release}`,
    'LATEST_MIGRATION=0059_example.sql',
    `WEB_IMAGE_DIGEST=sha256:${digestCharacter.repeat(64)}`,
    `API_IMAGE_DIGEST=sha256:${digestCharacter.repeat(64)}`,
    `WORKER_IMAGE_DIGEST=sha256:${digestCharacter.repeat(64)}`,
    `REALTIME_IMAGE_DIGEST=sha256:${digestCharacter.repeat(64)}`,
    `MIGRATOR_IMAGE_DIGEST=sha256:${digestCharacter.repeat(64)}`,
    '',
  ].join('\n');
}

function digestManifest(release: string, digestCharacter: string) {
  return releaseFile(release, digestCharacter)
    .split('\n')
    .filter((line) => !line.startsWith('LATEST_MIGRATION='))
    .join('\n');
}

function executable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function prepareControllerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'phub-legacy-otp-controller-'));
  const appRoot = join(root, 'app');
  const bundle = join(appRoot, 'legacy-otp-hotfix-candidates', '123-1');
  const fakeBin = join(root, 'bin');
  mkdirSync(join(appRoot, 'backups', 'releases'), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(appRoot, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(bundle, 'compose.staging.yaml'), 'services: {}\n');
  writeFileSync(join(appRoot, 'release.env'), releaseFile(activeRelease, 'a'));
  writeFileSync(join(appRoot, 'infrastructure.env'), 'COMPOSE_PROJECT_NAME=phub-staging\n');
  writeFileSync(join(appRoot, 'compose.infrastructure.yaml'), 'services: {}\n');
  writeFileSync(join(bundle, 'image-digests.env'), digestManifest(candidateRelease, 'b'));

  executable(
    join(bundle, 'backup-application.sh'),
    `#!/bin/sh
set -eu
mkdir -p "$1"
cp "$PHUB_APP_ROOT/compose.yaml" "$1/compose.yaml"
cp "$PHUB_APP_ROOT/release.env" "$1/release.env"
`,
  );
  executable(join(bundle, 'rollback-application.sh'), '#!/bin/sh\nset -eu\nexit 0\n');

  executable(
    join(fakeBin, 'docker'),
    `#!/bin/sh
set -eu
if test "$1" = ps; then
  service=''
  for argument in "$@"; do
    case "$argument" in label=com.docker.compose.service=*) service=\${argument##*=} ;; esac
  done
  test -z "$service" || printf '%s-id\\n' "$service"
  exit 0
fi
if test "$1" = inspect; then
  format=$3
  id=$4
  service=\${id%-id}
  case "$format" in
    *State.Running*) printf 'true\\n' ;;
    *State.Health.Status*) printf 'healthy\\n' ;;
    *Config.Image*)
      registry=$(sed -n 's/^REGISTRY=//p' "$PHUB_APP_ROOT/release.env")
      upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
      digest=$(sed -n "s/^\${upper}_IMAGE_DIGEST=//p" "$PHUB_APP_ROOT/release.env")
      printf '%s/phub-%s@%s\\n' "$registry" "$service" "$digest"
      ;;
    *Config.Env*) printf 'NODE_ENV=staging\\n' ;;
  esac
  exit 0
fi
if test "$1" = image && test "$2" = inspect; then exit 0; fi
if test "$1" = pull; then exit 0; fi
if test "$1" = stop; then
  test "\${PHUB_FAKE_FAIL_RESTORE_STOP:-0}" != 1 || exit 91
  exit 0
fi
if test "$1" = compose; then
  release_file=''
  previous=''
  for argument in "$@"; do
    if test "$previous" = --env-file; then release_file=$argument; fi
    previous=$argument
  done
  case " $* " in
    *' config --images '*)
      registry=$(sed -n 's/^REGISTRY=//p' "$release_file")
      for service in web api worker realtime migrator; do
        upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
        digest=$(sed -n "s/^\${upper}_IMAGE_DIGEST=//p" "$release_file")
        printf '%s/phub-%s@%s\\n' "$registry" "$service" "$digest"
      done
      ;;
    *' exec -T postgres sh -c '*)
      test "\${PHUB_FAKE_FAIL_DUMP:-0}" != 1 || exit 92
      printf 'synthetic-pg-backup\\n'
      ;;
    *' exec -T postgres sh -eu -c '*) printf '1\\n' ;;
    *' exec -T postgres pg_restore --list '*) : ;;
    *' up -d '*) : ;;
  esac
  exit 0
fi
exit 1
`,
  );
  executable(
    join(fakeBin, 'curl'),
    `#!/bin/sh
set -eu
release=$(sed -n 's/^RELEASE=//p' "$PHUB_APP_ROOT/release.env")
printf '{"release":"%s"}\\n' "$release"
`,
  );
  executable(
    join(fakeBin, 'df'),
    `#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf 'fixture 20000000 1 19999999 1%% /fixture\\n'
`,
  );
  executable(join(fakeBin, 'flock'), '#!/bin/sh\nexit 0\n');
  executable(join(fakeBin, 'sync'), '#!/bin/sh\nexit 0\n');
  executable(
    join(fakeBin, 'date'),
    `#!/bin/sh
case " $* " in *' -d '*) printf '2026-08-20T12:00:00Z\\n' ;; *) /bin/date "$@" ;; esac
`,
  );
  executable(
    join(fakeBin, 'sha256sum'),
    `#!/bin/sh
printf '${composeSha}  %s\\n' "$1"
`,
  );
  executable(
    join(fakeBin, 'stat'),
    `#!/bin/sh
if test "$1" = -c; then printf 'regular file:1:%s:%s:600\\n' "$(id -u)" "$(id -g)"; else /usr/bin/stat "$@"; fi
`,
  );

  return { root, appRoot, bundle, fakeBin };
}

function runController(
  fixture: ReturnType<typeof prepareControllerFixture>,
  operation: 'start' | 'attest' | 'rollback',
  extraEnvironment: Record<string, string> = {},
) {
  return spawnSync(
    'sh',
    [
      'deploy/jetson/run-legacy-otp-hotfix-canary.sh',
      operation,
      activeRelease,
      candidateRelease,
      controlRelease,
      '123',
      '1',
      operation === 'start'
        ? 'START_LEGACY_OTP_HOTFIX_CANARY'
        : operation === 'attest'
          ? 'ATTEST_LEGACY_OTP_HOTFIX_CANARY'
          : 'ROLLBACK_LEGACY_OTP_HOTFIX_CANARY',
      fixture.bundle,
    ],
    {
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: fixture.appRoot,
        ...extraEnvironment,
      },
      encoding: 'utf8',
    },
  );
}

function runTransitionClear(fixture: ReturnType<typeof prepareControllerFixture>) {
  const secretRoot = join(fixture.root, 'secrets');
  mkdirSync(secretRoot, { recursive: true });
  return spawnSync(
    'sh',
    ['deploy/jetson/verify-runtime-secret-transition-clear.sh', secretRoot, fixture.appRoot],
    { encoding: 'utf8' },
  );
}

describe('legacy OTP hotfix canary release contract', () => {
  it('is main-only, serialized, manually confirmed and action-pinned', () => {
    expect(parse(workflow)).toBeDefined();
    expect(workflow).toContain('group: staging');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$CONTROL_SHA"');
    expect(workflow).toContain('START:START_LEGACY_OTP_HOTFIX_CANARY');
    expect(workflow).toContain('RECOVER:RECOVER_LEGACY_OTP_HOTFIX_CANARY');
    const uses = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- uses:'));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/);
  });

  it('rejects multiline and alternate authority values before SSH interpolation', () => {
    expect(runAuthority({}).status).toBe(0);
    for (const [key, value] of [
      ['CANDIDATE_SHA', `${'1'.repeat(40)}\n'; touch /tmp/no`],
      ['EXPECTED_ACTIVE_RELEASE', `e308181da5222645d9a87d03642923c6841be8d1\ninvalid`],
      ['ORIGINAL_CONTROL_SHA', `${'2'.repeat(40)}\ninvalid`],
      ['ORIGINAL_RUN_ID', '123\ninvalid'],
      ['ORIGINAL_RUN_ATTEMPT', '1\ninvalid'],
    ] as const) {
      expect(runAuthority({ [key]: value }).status).not.toBe(0);
    }
  });

  it('verifies the immutable two-file child of e308 and protects release inputs', () => {
    expect(verifier).toContain('supported_active_release=e308181da5222645d9a87d03642923c6841be8d1');
    expect(verifier).toContain(
      'supported_patch_sha256=1ce854648f92b6dddf2d9105ad75197b4c6890da78a949245591767d4945b594',
    );
    expect(verifier).toContain(
      'test "$(printf \'%s\\n\' "$parent_line" | awk \'{ print NF }\')" -eq 2',
    );
    expect(verifier).toContain('packages/viva-adapter/src/identity.test.ts');
    expect(verifier).toContain('packages/viva-adapter/src/identity.ts');
    for (const path of [
      'packages/database/migrations',
      'contracts',
      'package-lock.json',
      'deploy/compose.staging.yaml',
      'apps/*/Dockerfile',
    ]) {
      expect(verifier).toContain(path);
    }
    expect(checkout).toContain('checkout-legacy-runtime-secret-bootstrap-candidate.sh');
  });

  it('builds one coherent five-image release and never invokes the migrator', () => {
    expect(workflow).toContain('matrix:\n        service: [web, api, worker, realtime, migrator]');
    expect(workflow).toContain('npm run check');
    expect(workflow).toContain('npm run db:migrate:check');
    expect(workflow).toContain('provenance: true');
    expect(workflow).toContain('sbom: true');
    expect(workflow).not.toContain('npm run db:migrate\n');
    expect(workflow).not.toContain('compose run migrator');
    expect(workflow).not.toContain('PROFILE_PHOTO_CLIENT_SYNC_ENABLED=true');
    expect(workflow).not.toContain('COMMUNITIES_REALTIME_ENABLED=true');
  });

  it('opens a fixed window only after candidate attestation and always restores e308', () => {
    const start = workflow.indexOf('Open the exact temporary legacy OTP canary window');
    const window = workflow.indexOf(
      'Hold the bounded browser OTP window and require correlation-bound success',
    );
    const rollback = workflow.indexOf('Always restore the exact e308 runtime after START');
    const observation = workflow.indexOf(
      'Observe the restored exact legacy runtime for five minutes',
    );
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(window);
    expect(window).toBeLessThan(rollback);
    expect(rollback).toBeLessThan(observation);
    expect(workflow).toContain('canary_window_seconds=900');
    expect(workflow).toContain('timeout-minutes: 120');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=30s 2400s ssh');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=30s 1800s ssh');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=5s 30s ssh');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=5s 900s sh -eu -c');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=5s 300s sh -eu -c');
    expect(workflow).toContain('test "$observation_status" -eq 0');
    expect(
      workflow.match(/https:\/\/lk\.nano\.padlhub\.su\/realtime\/health\/ready/g),
    ).toHaveLength(2);
    expect(workflow).toContain(
      "if: ${{ always() && inputs.operation == 'START' && steps.start.outcome != 'skipped' }}",
    );
    expect(workflow).toContain("steps.rollback.outcome == 'success'");
    const dispatchInputs = workflow.slice(
      workflow.indexOf('    inputs:'),
      workflow.indexOf('\npermissions:'),
    );
    expect(dispatchInputs).not.toMatch(/phone|otp_code|verification_code|refresh_token/i);
    expect(workflow).toContain('ATTEST_LEGACY_OTP_HOTFIX_CANARY');
  });

  it('publishes a durable marker before stopping runtime and converges recovery backward', () => {
    const marker = controller.indexOf('mv "$marker_next" "$marker"');
    const stop = controller.lastIndexOf('stop_runtime\n');
    const candidateInstall = controller.indexOf(
      'atomic_install "$candidate_release_file" "$release_next" "$app_root/release.env" candidate-release-staged',
    );
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(stop);
    expect(stop).toBeLessThan(candidateInstall);
    expect(controller).toContain('restore_from_marker');
    expect(controller).toContain('status=already-restored');
    expect(controller).toContain('rollback=failed marker=retained');
    expect(controller).toContain("session_audit.action = 'AUTH_SESSION_CREATED'");
    expect(controller).toContain("legal_audit.action = 'PHONE_OTP_LEGAL_ACCEPTANCE_RECORDED'");
    expect(controller).toContain("tenant.tenant_key = 'local-padel'");
    expect(controller).toContain('join integration.external_identity_map external_identity');
    expect(controller).not.toContain('identity.external_identities');
    expect(integrationIdentityMigration).toContain(
      'alter table integration.external_identities rename to external_identity_map',
    );
    expect(controller).toContain('test "$evidence_count" = 1');
    expect(controller).toContain(
      'delegation.refresh_expires_at is null or delegation.refresh_expires_at > now()',
    );
    expect(controller).toContain('CANDIDATE_READY_AT_EPOCH=0');
    expect(controller).toContain('test "$candidate_ready_at_epoch" -gt 0');
    const candidatePublic = controller.lastIndexOf('verify_public_release "$candidate_release"');
    const readyUpdate = controller.indexOf('candidate_ready_at_epoch=$(date -u +%s)');
    expect(candidatePublic).toBeGreaterThan(0);
    expect(candidatePublic).toBeLessThan(readyUpdate);
    expect(controller).not.toContain('source "$marker"');
    expect(controller).not.toContain('eval ');
    expect(controller).toContain(
      'test "$bundle_path" = "$app_root/legacy-otp-hotfix-candidates/$workflow_run_id-$workflow_run_attempt"',
    );
    for (const phase of [
      'marker-staged',
      'marker-published',
      'candidate-runtime-stopped',
      'candidate-release-staged',
      'candidate-release-installed',
      'candidate-realtime-ready',
      'candidate-api-ready',
      'candidate-worker-ready',
      'candidate-web-ready',
      'candidate-public-verified',
      'candidate-ready-marker-staged',
      'restore-runtime-stopped',
      'restore-release-staged',
      'restore-release-installed',
      'restore-realtime-ready',
      'restore-api-ready',
      'restore-worker-ready',
      'restore-web-ready',
    ]) {
      expect(controller).toContain(
        phase.includes('-ready') ? 'maybe_fail "$side-$service-ready"' : phase,
      );
    }
  });

  it('takes readable database and application backups before the marker and never restores DB', () => {
    const appBackup = controller.indexOf('BACKUP_STAGING_RELEASE');
    const databaseBackup = controller.indexOf('pg_dump -U "$POSTGRES_USER"');
    const marker = controller.indexOf('mv "$marker_next" "$marker"');
    expect(appBackup).toBeGreaterThan(0);
    expect(databaseBackup).toBeGreaterThan(appBackup);
    expect(databaseBackup).toBeLessThan(marker);
    expect(controller).toContain('pg_restore --list');
    expect(controller).not.toContain('pg_restore --clean');
    expect(controller).not.toContain('psql <');
  });

  it('starts realtime before API and blocks every other staging workflow while unresolved', () => {
    const startFunction = controller.slice(
      controller.indexOf('start_runtime() {'),
      controller.indexOf('restore_from_marker() {'),
    );
    expect(startFunction.indexOf('realtime api worker web')).toBeGreaterThan(0);
    expect(controller).toContain('assert_flags_disabled');
    for (const artifact of [
      '.legacy-otp-hotfix.transition.env',
      '.legacy-otp-hotfix.transition.env.next',
      '.legacy-otp-hotfix.release.next',
    ]) {
      expect(guard).toContain(artifact);
    }
  });

  it('restores exact e308 after a post-marker failure and retains the marker if rollback fails', () => {
    const restored = prepareControllerFixture();
    try {
      const result = runController(restored, 'start', {
        PHUB_OTP_HOTFIX_FAIL_AFTER: 'candidate-release-staged',
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(restored.appRoot, 'release.env'), 'utf8')).toContain(
        `RELEASE=${activeRelease}`,
      );
      expect(() =>
        readFileSync(join(restored.appRoot, '.legacy-otp-hotfix.transition.env')),
      ).toThrow();
      expect(() =>
        readFileSync(join(restored.appRoot, '.legacy-otp-hotfix.transition.env.next')),
      ).toThrow();
      expect(() =>
        readFileSync(join(restored.appRoot, '.legacy-otp-hotfix.release.next')),
      ).toThrow();
      const rollback = runController(restored, 'rollback');
      expect(rollback.status, rollback.stderr).toBe(0);
      expect(rollback.stdout).toContain('status=already-restored');
    } finally {
      rmSync(restored.root, { recursive: true, force: true });
    }

    const retained = prepareControllerFixture();
    try {
      const opened = runController(retained, 'start');
      expect(opened.status, opened.stderr).toBe(0);
      const attested = runController(retained, 'attest');
      expect(attested.status, attested.stderr).toBe(0);
      expect(attested.stdout).toContain('otp_canary_evidence=correlation-bound status=passed');
      const result = runController(retained, 'rollback', {
        PHUB_OTP_HOTFIX_FAIL_AFTER: 'restore-release-staged',
      });
      expect(result.status).not.toBe(0);
      expect(
        readFileSync(join(retained.appRoot, '.legacy-otp-hotfix.transition.env'), 'utf8'),
      ).toContain(`EXPECTED_ACTIVE_RELEASE=${activeRelease}`);
      expect(
        readFileSync(join(retained.appRoot, '.legacy-otp-hotfix.release.next'), 'utf8'),
      ).toContain(`RELEASE=${activeRelease}`);
      const recovered = runController(retained, 'rollback');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(join(retained.appRoot, 'release.env'), 'utf8')).toContain(
        `RELEASE=${activeRelease}`,
      );
      for (const artifact of [
        '.legacy-otp-hotfix.transition.env',
        '.legacy-otp-hotfix.transition.env.next',
        '.legacy-otp-hotfix.release.next',
      ]) {
        expect(() => readFileSync(join(retained.appRoot, artifact))).toThrow();
      }
      expect(runTransitionClear(retained).status).toBe(0);
    } finally {
      rmSync(retained.root, { recursive: true, force: true });
    }

    const readyMarker = prepareControllerFixture();
    try {
      const result = runController(readyMarker, 'start', {
        PHUB_OTP_HOTFIX_FAIL_AFTER: 'candidate-ready-marker-staged',
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(readyMarker.appRoot, 'release.env'), 'utf8')).toContain(
        `RELEASE=${activeRelease}`,
      );
      for (const artifact of [
        '.legacy-otp-hotfix.transition.env',
        '.legacy-otp-hotfix.transition.env.next',
        '.legacy-otp-hotfix.release.next',
      ]) {
        expect(() => readFileSync(join(readyMarker.appRoot, artifact))).toThrow();
      }
      expect(runTransitionClear(readyMarker).status).toBe(0);
    } finally {
      rmSync(readyMarker.root, { recursive: true, force: true });
    }

    const initialMarker = prepareControllerFixture();
    try {
      const result = runController(initialMarker, 'start', {
        PHUB_OTP_HOTFIX_FAIL_AFTER: 'marker-staged',
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(initialMarker.appRoot, 'release.env'), 'utf8')).toContain(
        `RELEASE=${activeRelease}`,
      );
      expect(runTransitionClear(initialMarker).status).toBe(0);
    } finally {
      rmSync(initialMarker.root, { recursive: true, force: true });
    }

    const unsafeNext = prepareControllerFixture();
    try {
      const opened = runController(unsafeNext, 'start');
      expect(opened.status, opened.stderr).toBe(0);
      symlinkSync(
        join(unsafeNext.appRoot, 'release.env'),
        join(unsafeNext.appRoot, '.legacy-otp-hotfix.release.next'),
      );
      const result = runController(unsafeNext, 'rollback');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('transition next artifact is unsafe');
      expect(
        readFileSync(join(unsafeNext.appRoot, '.legacy-otp-hotfix.transition.env'), 'utf8'),
      ).toContain(`EXPECTED_ACTIVE_RELEASE=${activeRelease}`);
      expect(runTransitionClear(unsafeNext).status).not.toBe(0);
    } finally {
      rmSync(unsafeNext.root, { recursive: true, force: true });
    }

    const preMarker = prepareControllerFixture();
    try {
      const result = runController(preMarker, 'start', { PHUB_FAKE_FAIL_DUMP: '1' });
      expect(result.status).not.toBe(0);
      expect(
        readdirSync(join(preMarker.appRoot, 'backups')).filter((name) =>
          name.startsWith('postgres-pre-legacy-otp-'),
        ),
      ).toEqual([]);
      expect(() =>
        readFileSync(join(preMarker.appRoot, '.legacy-otp-hotfix.transition.env')),
      ).toThrow();
    } finally {
      rmSync(preMarker.root, { recursive: true, force: true });
    }
  }, 90_000);
});
