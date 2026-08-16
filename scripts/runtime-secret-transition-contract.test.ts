import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const controller = readFileSync('deploy/jetson/transition-runtime-secret-contours.sh', 'utf8');
const helper = readFileSync('deploy/jetson/provision-runtime-secret-files.mjs', 'utf8');
const guard = readFileSync('deploy/jetson/verify-runtime-secret-transition-clear.sh', 'utf8');
const communitiesInventory = readFileSync(
  'deploy/jetson/inspect-communities-staging-target.sh',
  'utf8',
);
const communitiesBackup = readFileSync(
  'deploy/jetson/create-communities-staging-backup.sh',
  'utf8',
);
const workflowSource = readFileSync(
  '.github/workflows/provision-staging-runtime-secrets.yaml',
  'utf8',
);
const workflow = parse(workflowSource) as Record<string, unknown>;
const controllerPath = resolve('deploy/jetson/transition-runtime-secret-contours.sh');
const release = 'e'.repeat(40);
const imageDigest = `sha256:${'a'.repeat(64)}`;

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runtimeFailureFixture(failure: 'candidate-render' | 'render-helper') {
  const root = mkdtempSync(join(tmpdir(), 'phub-runtime-controller-'));
  const toolDirectory = mkdtempSync('/tmp/phub-runtime-secret.');
  const appRoot = join(root, 'app');
  const secretRoot = join(root, 'secret');
  const bin = join(root, 'bin');
  mkdirSync(appRoot, { mode: 0o700 });
  mkdirSync(secretRoot, { mode: 0o750 });
  mkdirSync(bin, { mode: 0o700 });
  const candidateCompose = join(toolDirectory, 'compose.staging.yaml');
  const helperScript = join(toolDirectory, 'provision-runtime-secret-files.mjs');
  const activeCompose = 'services:\n  realtime:\n    image: synthetic\n';
  writeFileSync(candidateCompose, activeCompose, { mode: 0o400 });
  writeFileSync(helperScript, helper, { mode: 0o400 });
  writeFileSync(join(appRoot, 'compose.yaml'), activeCompose, { mode: 0o600 });
  writeFileSync(join(appRoot, 'compose.infrastructure.yaml'), 'services: {}\n', { mode: 0o600 });
  writeFileSync(join(appRoot, 'infrastructure.env'), '', { mode: 0o600 });
  writeFileSync(
    join(appRoot, 'release.env'),
    [
      `RELEASE=${release}`,
      'REGISTRY=ghcr.io/example',
      `WEB_IMAGE_DIGEST=${imageDigest}`,
      `API_IMAGE_DIGEST=${imageDigest}`,
      `WORKER_IMAGE_DIGEST=${imageDigest}`,
      `REALTIME_IMAGE_DIGEST=${imageDigest}`,
      `MIGRATOR_IMAGE_DIGEST=${imageDigest}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(join(secretRoot, 'staging.env'), 'APP_ENV=staging\n', { mode: 0o600 });
  const log = join(root, 'docker.log');
  const count = join(root, 'render.count');

  writeExecutable(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" "$*" >> "$MOCK_LOG"',
      'last=',
      'for value do last=$value; done',
      'case "$*" in',
      '  *" build-compose "*)',
      '    cp "$MOCK_APP_ROOT/compose.yaml" "$MOCK_TOOL_DIR/compose.staging.yaml.runtime-secret-generated"',
      '    chmod 600 "$MOCK_TOOL_DIR/compose.staging.yaml.runtime-secret-generated"',
      "    printf '%s\\n' 'runtime-secret-transition operation=build-compose result=compose-generated status=passed'",
      '    exit 0',
      '    ;;',
      '  *" verify-compose-render-delta "*)',
      '    if test "$MOCK_FAILURE" = render-helper; then exit 19; fi',
      "    printf '%s\\n' 'runtime-secret-transition operation=verify-compose-render-delta result=compose-render-approved status=passed'",
      '    exit 0',
      '    ;;',
      'esac',
      'if test "${1:-}" = compose && printf "%s" "$*" | grep -q " config --format json"; then',
      '  render_count=0',
      '  if test -f "$MOCK_COUNT"; then render_count=$(wc -l < "$MOCK_COUNT" | tr -d " "); fi',
      '  printf \'x\\n\' >> "$MOCK_COUNT"',
      '  if test "$MOCK_FAILURE" = candidate-render && test "$render_count" -eq 1; then exit 17; fi',
      '  printf \'%s\\n\' \'{"services":{"realtime":{"environment":{"APP_ENV":"staging"}}}}\'',
      '  exit 0',
      'fi',
      'if test "${1:-}" = compose && printf "%s" "$*" | grep -q " ps "; then',
      '  printf "%s-container\\n" "$last"',
      '  exit 0',
      'fi',
      'if test "${1:-}" = image && test "${2:-}" = inspect; then',
      '  printf "%s\\n" "$MOCK_IMAGE"',
      '  exit 0',
      'fi',
      'if test "${1:-}" = inspect; then',
      '  case "$*" in',
      '    *".State.Health.Status"*) printf "%s\\n" healthy ;;',
      '    *".Config.Image"*)',
      '      service=${last%-container}',
      '      printf "ghcr.io/example/phub-%s@%s\\n" "$service" "$MOCK_IMAGE"',
      '      ;;',
      '    *".Config.Env"*)',
      "      printf '%s\\n' PROFILE_PHOTO_CLIENT_SYNC_ENABLED=false COMMUNITY_INVITES_ENABLED=false COMMUNITIES_REALTIME_ENABLED=false COMMUNITY_MEDIA_ENABLED=false COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED=false COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED=false",
      '      ;;',
      '    *".State.StartedAt"*) printf "%s\\n" 2026-08-16T00:00:00Z ;;',
      '    *".Image"*) printf "%s\\n" "$MOCK_IMAGE" ;;',
      '    *) exit 23 ;;',
      '  esac',
      '  exit 0',
      'fi',
      'exit 24',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'stat'),
    [
      '#!/bin/sh',
      'set -eu',
      'case "$2" in',
      "  '%u:%g:%a') printf '%s\\n' '0:1000:750' ;;",
      "  '%h:%u:%g:%a') printf '%s\\n' '1:1000:1000:600' ;;",
      "  '%d:%i:%s:%Y') printf '%s\\n' '1:2:3:4' ;;",
      '  *) exit 31 ;;',
      'esac',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'df'),
    "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted' 'synthetic 1000000 1 999999 1% /'",
  );
  writeExecutable(
    join(bin, 'id'),
    '#!/bin/sh\ncase "$1" in -u|-g) printf \'%s\\n\' 1000 ;; *) exit 1 ;; esac',
  );
  writeExecutable(join(bin, 'flock'), '#!/bin/sh\nexit 0');
  writeExecutable(join(bin, 'sync'), '#!/bin/sh\nexit 0');
  writeExecutable(join(bin, 'sha256sum'), `#!/bin/sh\nprintf '%s  -\\n' '${'c'.repeat(64)}'`);

  return {
    root,
    toolDirectory,
    appRoot,
    secretRoot,
    candidateCompose,
    helperScript,
    log,
    count,
    failure,
    activeCompose,
    bin,
  };
}

describe('runtime-secret transition delivery contract', () => {
  it('is manual, main-only, staging-approved and shares the staging lock', () => {
    expect(workflowSource).toContain('workflow_dispatch:');
    expect(workflowSource).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflowSource).toContain('group: staging');
    expect(workflowSource).toContain('environment: staging');
    expect(workflowSource).toContain('timeout-minutes: 45');
    expect(workflow).toBeTruthy();
  });

  it('pins every privileged workflow action to a full commit SHA', () => {
    const actionReferences = [...workflowSource.matchAll(/uses:\s+([^\s#]+)/g)].map(
      ([, reference]) => reference,
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('runs the helper without network, pulls or broad capabilities', () => {
    expect(controller).toContain('--pull=never');
    expect(controller).toContain('--network none');
    expect(controller).toContain('--read-only');
    expect(controller).toContain('--cap-drop ALL');
    expect(controller).toContain('--cap-add CHOWN');
    expect(controller).toContain('--cap-add DAC_READ_SEARCH');
    expect(controller).toContain('--cap-add FOWNER');
    expect(controller).not.toContain('--cap-add DAC_OVERRIDE');
    expect(controller).toContain('--input-type=module -');
    expect(controller).not.toContain('--privileged');
    expect(helper).toContain(
      'staging: { uid: Number(deployUid), gid: Number(deployGid), mode: 0o600 }',
    );
    expect(controller).toContain('run_helper prepare ');
    expect(controller).not.toContain('prepare-bootstrap');
  });

  it('stops the one-key ticket boundary before starting realtime then API', () => {
    const stop = controller.indexOf('compose stop -t 30 api realtime');
    const realtime = controller.indexOf(
      'compose up -d --no-deps --force-recreate --pull never realtime',
      stop,
    );
    const api = controller.indexOf(
      'compose up -d --no-deps --force-recreate --pull never api',
      realtime,
    );
    const worker = controller.indexOf(
      'compose up -d --no-deps --force-recreate --pull never worker',
      api,
    );
    expect(stop).toBeGreaterThan(0);
    expect(realtime).toBeGreaterThan(stop);
    expect(api).toBeGreaterThan(realtime);
    expect(worker).toBeGreaterThan(api);
  });

  it('proves the active realtime image accepts the isolated contour before stopping services', () => {
    const probe = controller.indexOf('probe_realtime_candidate');
    const configLoad = controller.indexOf('loadRealtimeConfig(process.env)', probe);
    const invocation = controller.lastIndexOf('probe_realtime_candidate');
    const stop = controller.indexOf('compose stop -t 30 api realtime', invocation);
    expect(probe).toBeGreaterThan(0);
    expect(configLoad).toBeGreaterThan(probe);
    expect(invocation).toBeGreaterThan(configLoad);
    expect(stop).toBeGreaterThan(invocation);
    expect(controller).toContain('--env-file "$secret_root/realtime.env" "$old_realtime_image"');
  });

  it('accepts absent legacy gates but requires explicit false on the candidate contour', () => {
    const legacyGuard = controller.indexOf('legacy_running_flag_disabled()');
    const originalGuard = controller.indexOf('assert_original_flags_disabled()');
    const oldRuntime = controller.lastIndexOf(
      'assert_original_flags_disabled "$old_api" "$old_worker" "$old_realtime"',
    );
    const candidateRuntime = controller.lastIndexOf(
      'assert_disabled_flags "$new_api" "$new_worker" "$new_realtime"',
    );
    expect(legacyGuard).toBeGreaterThan(0);
    expect(controller.slice(legacyGuard, originalGuard)).toContain('0)');
    expect(controller.slice(legacyGuard, originalGuard)).toContain(
      'const { loadConfig } = await import("@phub/config")',
    );
    expect(controller.slice(legacyGuard, originalGuard)).toContain(
      'value !== undefined && value !== false',
    );
    expect(oldRuntime).toBeGreaterThan(originalGuard);
    expect(candidateRuntime).toBeGreaterThan(oldRuntime);
    expect(helper).toContain("'PROFILE_PHOTO_CLIENT_SYNC_ENABLED'");
    expect(helper).toContain("'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED'");
    expect(helper).toContain('candidate staging flag ${key} is unsafe');
  });

  it('generates a minimal active-Compose candidate only for a new transition', () => {
    const recover = controller.indexOf('if test "$operation" = recover');
    const finalize = controller.indexOf('if test "$operation" = finalize', recover);
    const build = controller.indexOf('run_compose_helper >/dev/null', finalize);
    const selectGenerated = controller.indexOf(
      'candidate_compose=$generated_candidate_compose',
      build,
    );
    const render = controller.indexOf(
      'active_render="$candidate_tool_directory/.runtime-secret-active-render.json"',
      selectGenerated,
    );
    expect(recover).toBeGreaterThan(0);
    expect(finalize).toBeGreaterThan(recover);
    expect(build).toBeGreaterThan(finalize);
    expect(selectGenerated).toBeGreaterThan(build);
    expect(render).toBeGreaterThan(selectGenerated);
    const buildOnlyHelper = controller.slice(
      controller.indexOf('compose_helper_raw()'),
      controller.indexOf('run_compose_helper()'),
    );
    expect(buildOnlyHelper).toContain('--user "$deploy_uid:$deploy_gid"');
    expect(buildOnlyHelper).toContain('--cap-drop ALL');
    expect(buildOnlyHelper).not.toContain('--cap-add');
    expect(buildOnlyHelper).not.toContain('src="$secret_root"');
    expect(buildOnlyHelper).toContain(
      '--mount type=bind,src="$app_root/compose.yaml",dst=/active-compose.yaml,readonly',
    );
    expect(buildOnlyHelper).toContain(
      '--mount type=bind,src="$candidate_tool_directory",dst=/reviewed',
    );
    expect(buildOnlyHelper).not.toContain('dst=/reviewed,rw');
    expect(controller).not.toContain('dst=/target,rw');
    expect(controller).toContain('stat -c \'%h:%u:%g:%a\' "$generated_candidate_compose"');
    expect(helper).toContain('buildRuntimeSecretComposeCandidate');
    expect(helper).toContain('active Compose realtime service already contains env_file');
    expect(controller).toContain('verify-compose-render-delta');
    expect(controller).toContain('.runtime-secret-active-render.json');
    expect(controller).toContain('.runtime-secret-candidate-render.json');
    expect(controller).not.toContain('cmp -s "$active_render" "$candidate_render"');
    expect(helper).toContain(
      'candidate Compose changes outside the approved realtime environment contour',
    );
    const renderOnlyHelper = controller.slice(
      controller.indexOf('compose_render_helper_raw()'),
      controller.indexOf('run_compose_render_helper()'),
    );
    expect(renderOnlyHelper).toContain('--user "$deploy_uid:$deploy_gid"');
    expect(renderOnlyHelper).toContain('--network none');
    expect(renderOnlyHelper).toContain('--read-only');
    expect(renderOnlyHelper).toContain('--cap-drop ALL');
    expect(renderOnlyHelper).not.toContain('--cap-add');
    expect(renderOnlyHelper).not.toContain('src="$secret_root"');
    expect(renderOnlyHelper).toContain('dst=/reviewed,readonly');
  });

  it.each(['candidate-render', 'render-helper'] as const)(
    'cleans private renders and performs no mutation when %s fails',
    (failure) => {
      const input = runtimeFailureFixture(failure);
      try {
        const result = spawnSync(
          'sh',
          [
            controllerPath,
            'transition',
            release,
            'TRANSITION_STAGING_RUNTIME_SECRETS',
            input.candidateCompose,
            input.helperScript,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${input.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
              PHUB_APP_ROOT: input.appRoot,
              PHUB_SECRET_ROOT: input.secretRoot,
              MOCK_APP_ROOT: input.appRoot,
              MOCK_TOOL_DIR: input.toolDirectory,
              MOCK_LOG: input.log,
              MOCK_COUNT: input.count,
              MOCK_FAILURE: input.failure,
              MOCK_IMAGE: imageDigest,
            },
          },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Runtime secret transition refused:');
        expect(existsSync(join(input.toolDirectory, '.runtime-secret-active-render.json'))).toBe(
          false,
        );
        expect(existsSync(join(input.toolDirectory, '.runtime-secret-candidate-render.json'))).toBe(
          false,
        );
        expect(
          existsSync(join(input.secretRoot, '.runtime-secret-isolation.transition.json')),
        ).toBe(false);
        expect(readFileSync(join(input.appRoot, 'compose.yaml'), 'utf8')).toBe(input.activeCompose);
        const dockerLog = readFileSync(input.log, 'utf8');
        expect(dockerLog).not.toMatch(/(?:^| )prepare(?: |$)/m);
        expect(dockerLog).not.toMatch(/^compose .* (?:stop|up)(?: |$)/m);
      } finally {
        rmSync(input.root, { recursive: true, force: true });
        rmSync(input.toolDirectory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('rolls back a rejected preflight without recreating serving containers', () => {
    const earlyRollback = controller.indexOf('action=files-only');
    const earlyReturn = controller.indexOf('return 0', earlyRollback);
    const servingStop = controller.indexOf('compose stop -t 30 api realtime', earlyReturn);
    expect(earlyRollback).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(earlyRollback);
    expect(servingStop).toBeGreaterThan(earlyReturn);
    expect(controller.slice(earlyRollback, earlyReturn)).not.toContain('compose up');
    expect(controller.slice(earlyRollback, earlyReturn)).not.toContain('compose stop');
    expect(controller).toContain('test "$(runtime_snapshot)" = "$(state_field runtimeSnapshot)"');
    expect(controller).toContain('restore_from_phase=$(state_field restoreFromPhase)');
    expect(controller).toContain('if test "$phase" != files-restored; then');
    expect(helper).toContain("'restoreFromPhase'");
  });

  it('resumes rollback after lost responses from file and runtime restoration', () => {
    expect(controller).toContain('if test "$phase" != files-restored; then');
    expect(controller).toContain('if test "$phase" != runtime-restored; then');
    expect(helper).toContain(
      "state.phase === 'files-restored' || state.phase === 'runtime-restored'",
    );
    expect(helper).toContain('return { status: state.phase }');
  });

  it('binds recovery to release, infrastructure and exact old images', () => {
    for (const field of [
      'activeRelease',
      'releaseEnvSha256',
      'infrastructureIdentity',
      'infrastructureComposeSha256',
      'oldApiImageId',
      'oldWorkerImageId',
      'oldRealtimeImageId',
      'oldWebId',
      'oldNginxId',
    ]) {
      expect(helper).toContain(field);
      expect(controller).toContain(field);
    }
  });

  it('blocks every durable journal and Compose artifact', () => {
    expect(guard).toContain('.runtime-secret-isolation.transition.json.next');
    expect(guard).toContain('.runtime-secret-isolation.compose.backup');
    expect(guard).toContain('.runtime-secret-isolation.compose.next');
    expect(workflowSource).toContain('failure() || cancelled()');
    for (const forcedCommand of [communitiesInventory, communitiesBackup]) {
      expect(forcedCommand).toContain('.runtime-secret-isolation.transition.json.next');
      expect(forcedCommand).toContain('.runtime-secret-isolation.compose.backup');
      expect(forcedCommand).toContain('runtime-secret transition root is not safely inspectable');
    }
  });

  it('runs all fallible runtime and public attestations before finalize', () => {
    const baseline = workflowSource.indexOf('Attest candidate runtime before finalize');
    const publicCheck = workflowSource.indexOf(
      'Attest public ingress before irreversible finalize',
    );
    const finalize = workflowSource.indexOf('Finalize verified transition');
    expect(baseline).toBeGreaterThan(0);
    expect(publicCheck).toBeGreaterThan(baseline);
    expect(finalize).toBeGreaterThan(publicCheck);
  });

  it('re-attests exact candidate runtime before forward finalize and recovery', () => {
    const attestor = controller.indexOf('attest_candidate_runtime()');
    const recoverForward = controller.indexOf('verified | finalizing)', attestor);
    const finalize = controller.indexOf('if test "$operation" = finalize', recoverForward);
    expect(attestor).toBeGreaterThan(0);
    expect(controller.indexOf('attest_candidate_runtime', recoverForward)).toBeGreaterThan(
      recoverForward,
    );
    expect(controller.indexOf('attest_candidate_runtime', finalize)).toBeGreaterThan(finalize);
  });
});
