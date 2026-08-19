import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/bootstrap-staging-runtime-secrets.yaml', 'utf8');
const renewalWorkflow = readFileSync(
  '.github/workflows/renew-staging-realtime-smoke-session.yaml',
  'utf8',
);
const controller = readFileSync(
  'deploy/jetson/bootstrap-legacy-runtime-secret-contours.sh',
  'utf8',
);
const sourceVerifier = readFileSync(
  'deploy/jetson/verify-legacy-runtime-secret-bootstrap-source.sh',
  'utf8',
);
const candidateCheckout = readFileSync(
  'deploy/jetson/checkout-legacy-runtime-secret-bootstrap-candidate.sh',
  'utf8',
);
const runtimeObservation = readFileSync(
  'deploy/jetson/verify-legacy-runtime-secret-bootstrap-runtime.sh',
  'utf8',
);
const helper = readFileSync('deploy/jetson/provision-runtime-secret-files.mjs', 'utf8');
const stagingSmoke = readFileSync('deploy/jetson/staging-realtime-smoke-session.mjs', 'utf8');
const stagingSmokeWrapper = readFileSync(
  'deploy/jetson/verify-staging-realtime-smoke-session.sh',
  'utf8',
);
const stagingSmokeInstaller = readFileSync(
  'deploy/jetson/install-staging-realtime-smoke-session.sh',
  'utf8',
);
const sharedGuard = readFileSync('deploy/jetson/verify-runtime-secret-transition-clear.sh', 'utf8');
const communitiesInspection = readFileSync(
  'deploy/jetson/inspect-communities-staging-target.sh',
  'utf8',
);
const communitiesBackup = readFileSync(
  'deploy/jetson/create-communities-staging-backup.sh',
  'utf8',
);
const runbook = readFileSync('docs/runbooks/jetson-staging.md', 'utf8');

const authorityStepStart = workflow.indexOf('      - id: request\n');
const authorityRunStart = workflow.indexOf('        run: |\n', authorityStepStart);
const authorityStepEnd = workflow.indexOf('\n      - uses:', authorityRunStart);
const authorityScript = workflow
  .slice(authorityRunStart + '        run: |\n'.length, authorityStepEnd)
  .split('\n')
  .map((line) => line.slice(10))
  .join('\n');

const runAuthorityValidation = (overrides: Record<string, string>) =>
  spawnSync('sh', ['-c', authorityScript], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: '/dev/null',
      OPERATION: 'RECOVER',
      EXPECTED_ACTIVE_RELEASE: 'e308181da5222645d9a87d03642923c6841be8d1',
      CANDIDATE_SHA: 'ffb12608fb16eae17096ab3ab3a7337cc5359c8a',
      CONFIRMATION: 'RECOVER_STAGING_RUNTIME_SECRETS',
      ORIGINAL_CONTROL_SHA: '14e1b1ee3a3950bc2cbad9631728e8f0c96162f9',
      ORIGINAL_RUN_ID: '31959225494',
      ORIGINAL_RUN_ATTEMPT: '1',
      REQUEST_REF: 'refs/heads/main',
      CONTROL_SHA: '14e1b1ee3a3950bc2cbad9631728e8f0c96162f9',
      WORKFLOW_SHA: '14e1b1ee3a3950bc2cbad9631728e8f0c96162f9',
      SUPPORTED_ACTIVE_RELEASE: 'e308181da5222645d9a87d03642923c6841be8d1',
      SUPPORTED_CANDIDATE_SHA: 'ffb12608fb16eae17096ab3ab3a7337cc5359c8a',
      ...overrides,
    },
  });

describe('legacy runtime-secret bootstrap delivery contract', () => {
  it('is a main-only, serialized, manually confirmed and fully pinned workflow', () => {
    const parsedWorkflow: unknown = parse(workflow);
    expect(parsedWorkflow).toBeDefined();
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('group: staging');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$CONTROL_SHA"');
    expect(workflow).toContain('START:BOOTSTRAP_STAGING_RUNTIME_SECRETS');
    expect(workflow).toContain('RECOVER:RECOVER_STAGING_RUNTIME_SECRETS');
    const uses = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- uses:'));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/);
  });

  it('renews the host-only smoke session weekly under the shared staging lock', () => {
    expect(parse(renewalWorkflow)).toBeDefined();
    expect(renewalWorkflow).toContain("cron: '17 4 * * 1'");
    expect(renewalWorkflow).toContain('group: staging');
    expect(renewalWorkflow).toContain('environment: staging');
    expect(renewalWorkflow).toContain('test "$SOURCE_REF" = refs/heads/main');
    expect(renewalWorkflow).toContain('test "$WORKFLOW_SHA" = "$SOURCE_SHA"');
    expect(renewalWorkflow).toContain('/opt/phub/staging-realtime-smoke-runs/$RUN_ID-$RUN_ATTEMPT');
    expect(renewalWorkflow).toContain('staging-realtime-smoke-session.mjs');
    expect(renewalWorkflow).toContain('verify-staging-realtime-smoke-session.sh');
    expect(renewalWorkflow).not.toMatch(/ACCESS_TOKEN|REFRESH_TOKEN|JWT_.*SECRET/u);
    const uses = renewalWorkflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses:') || line.startsWith('- uses:'));
    expect(uses).toHaveLength(2);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}(?:\s+# v\d+)?$/u);
  });

  it('rejects multiline or quoted recovery identifiers before remote command construction', () => {
    expect(runAuthorityValidation({}).status).toBe(0);
    expect(
      runAuthorityValidation({
        CANDIDATE_SHA: "ffb12608fb16eae17096ab3ab3a7337cc5359c8a\n'; touch injected; '",
      }).status,
    ).not.toBe(0);
    expect(
      runAuthorityValidation({ ORIGINAL_RUN_ID: "31959225494\n'; touch injected; '" }).status,
    ).not.toBe(0);
    expect(
      runAuthorityValidation({
        ORIGINAL_CONTROL_SHA:
          '14e1b1ee3a3950bc2cbad9631728e8f0c96162f9\n0000000000000000000000000000000000000000',
      }).status,
    ).not.toBe(0);
    expect(workflow).toContain('test "$CANDIDATE_SHA" = "$SUPPORTED_CANDIDATE_SHA"');
  });

  it('binds a single-parent nine-file source candidate with no migration or contract delta', () => {
    expect(workflow).toContain(
      'SUPPORTED_ACTIVE_RELEASE: e308181da5222645d9a87d03642923c6841be8d1',
    );
    expect(sourceVerifier).toContain(
      'supported_active_release=e308181da5222645d9a87d03642923c6841be8d1',
    );
    expect(sourceVerifier).toContain(
      'supported_patch_sha256=4634e8f42b256d0a7faf29beab0370529c0e6430a1b3b21ab2ce9a3ffa6e26de',
    );
    expect(sourceVerifier).toContain(
      'candidate patch differs from the reviewed immutable B0 source',
    );
    expect(sourceVerifier).toContain("awk '{ print NF }')\" -eq 2");
    expect(sourceVerifier).toContain('candidate parent is not the exact active release');
    for (const path of [
      'apps/api/src/main.ts',
      'apps/api/src/messaging/realtime-ticket-issuer.ts',
      'apps/realtime/src/main.ts',
      'apps/realtime/src/app.ts',
      'deploy/compose.staging.yaml',
      'packages/config/src/index.ts',
    ]) {
      expect(sourceVerifier).toContain(path);
    }
    expect(sourceVerifier).toContain('candidate migration tree differs');
    expect(sourceVerifier).toContain('candidate contract tree differs');
    expect(sourceVerifier).toContain('service_has_empty_env web');
    expect(sourceVerifier).toContain('service_has_empty_env migrator');
    expect(workflow).toContain('sh deploy/jetson/verify-legacy-runtime-secret-bootstrap-source.sh');
    expect(workflow).toContain('Run the complete candidate gate');
    expect(workflow).toContain('npm run contracts:generate');
    expect(workflow).toContain('npm run build:packages');
    expect(workflow).toContain('npm run check');
    expect(workflow).toContain('npm run db:migrate:check');
  });

  it('acquires the immutable legacy candidate without invoking checkout submodule cleanup', () => {
    expect(workflow.match(/Acquire the exact immutable B0 candidate/g)).toHaveLength(3);
    expect(workflow).not.toContain('ref: ${{ inputs.bootstrap_candidate_sha }}');
    expect(candidateCheckout).toContain('repository_url=https://github.com/Z6v6e6r/lk2.git');
    expect(candidateCheckout).toContain('test "$destination" = candidate');
    expect(candidateCheckout).toContain('test ! -e "$destination" && test ! -L "$destination"');
    expect(candidateCheckout).toContain('git -C "$destination" -c protocol.version=2 fetch');
    expect(candidateCheckout).toContain('--depth=2');
    expect(candidateCheckout).toContain('rev-parse FETCH_HEAD');
    expect(candidateCheckout).toContain('checkout --quiet --detach "$candidate_sha"');
    expect(candidateCheckout).toContain('--no-recurse-submodules');
    expect(candidateCheckout).toContain('rev-parse --verify HEAD^');
    expect(candidateCheckout).toContain('remote remove origin');
    expect(candidateCheckout).not.toContain('GITHUB_TOKEN');
    expect(candidateCheckout).not.toContain('submodule foreach');
    expect(workflow).toContain('context: candidate');
    expect(workflow).toContain('file: candidate/apps/${{ matrix.service }}/Dockerfile');
  });

  it('builds and records all five immutable candidate manifests without invoking migrator', () => {
    expect(workflow).toContain('service: [web, api, worker, realtime, migrator]');
    expect(workflow).toContain('platforms: linux/arm64');
    expect(workflow).toContain('push: true');
    expect(workflow).toContain('context: candidate');
    expect(workflow).toContain('file: candidate/apps/${{ matrix.service }}/Dockerfile');
    expect(workflow).toContain('steps.image.outputs.digest');
    expect(workflow).not.toMatch(/npm run db:migrate(?:\s|$)/);
    expect(workflow).not.toMatch(/compose[^\n]*run[^\n]*migrator/);
    expect(controller).toContain('candidate Compose must resolve exactly five images');
    expect(controller).toContain('docker pull "$ref"');
  });

  it('completes backup and local-image proof before publishing the version-2 marker', () => {
    const pull = controller.indexOf('docker pull "$ref"');
    const backup = controller.indexOf('BACKUP_STAGING_RELEASE');
    const validate = controller.indexOf('--validate-only');
    const prepare = controller.indexOf('prepare-bootstrap-json');
    expect(pull).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(pull);
    expect(validate).toBeGreaterThan(backup);
    expect(prepare).toBeGreaterThan(validate);
    expect(controller.slice(prepare)).not.toContain('docker pull');
    expect(helper).toContain('version: BOOTSTRAP_VERSION');
    expect(helper).toContain("operation: 'legacy-runtime-secret-bootstrap'");
    expect(helper).toContain("'files-prepared'");
    expect(helper).toContain("'images-probed'");
    expect(helper).toContain("'release-committed'");
  });

  it('renders the legacy snapshot and rollback through staging.env until realtime.env exists', () => {
    const legacyCompose = controller.slice(
      controller.indexOf('legacy_compose()'),
      controller.indexOf('project_container_id()'),
    );
    expect(legacyCompose).toContain('legacy_compose() (');
    expect(legacyCompose).toContain('export RUNTIME_ENV_FILE="$secret_root/staging.env"');
    expect(legacyCompose).toContain('export REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"');
    expect(legacyCompose).toContain('RUNTIME_ENV_FILE="$secret_root/staging.env"');
    expect(legacyCompose).toContain('REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"');

    const backup = controller.slice(
      controller.indexOf('backup_path="$backup_root/pre-b0-'),
      controller.indexOf('control_tree=$(cat'),
    );
    expect(backup).toContain('RUNTIME_ENV_FILE="$secret_root/staging.env"');
    expect(backup).toContain('REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"');
    expect(backup).toContain('BACKUP_STAGING_RELEASE');
    expect(backup).toContain('--validate-only');

    const lifecycleExport = controller.indexOf(
      'export REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"',
      controller.indexOf('candidate release file has wrong SHA'),
    );
    const prepared = controller.indexOf('run_helper verify-bootstrap-prepared');
    const lifecycleUnset = controller.indexOf('unset RUNTIME_ENV_FILE REALTIME_RUNTIME_ENV_FILE');
    const backupInvocation = controller.indexOf('BACKUP_STAGING_RELEASE', lifecycleExport);
    const candidateProbe = controller.indexOf('candidate_api_ref=$(image_ref_from');
    expect(lifecycleExport).toBeGreaterThan(0);
    expect(lifecycleExport).toBeLessThan(backupInvocation);
    expect(lifecycleUnset).toBeGreaterThan(prepared);
    expect(lifecycleUnset).toBeLessThan(candidateProbe);

    const recovery = controller.slice(
      controller.indexOf(
        '# The old access-key ticket protocol requires old realtime before old API.',
      ),
      controller.indexOf(
        "printf '%s\\n' 'legacy_runtime_secret_bootstrap operation=recover action=rollback status=passed'",
      ),
    );
    for (const service of ['realtime', 'api', 'worker', 'web']) {
      expect(recovery).toContain(
        `legacy_compose up -d --no-deps --force-recreate --pull never ${service}`,
      );
    }

    const candidateStart = controller.slice(
      controller.indexOf('advance-bootstrap-phase images-probed runtime-stopping'),
    );
    expect(candidateStart).toContain(
      'compose up -d --no-deps --force-recreate --pull never realtime',
    );
    expect(candidateStart).not.toContain(
      'legacy_compose up -d --no-deps --force-recreate --pull never realtime',
    );

    const candidateRender = controller.slice(
      controller.indexOf('pre_marker_phase candidate-compose-render'),
      controller.indexOf('backup_path="$backup_root/pre-b0-'),
    );
    const backupCommand = controller.slice(
      controller.indexOf('pre_marker_phase application-backup'),
      controller.indexOf('pre_marker_phase rollback-validation'),
    );
    const rollbackValidationCommand = controller.slice(
      controller.indexOf('pre_marker_phase rollback-validation'),
      controller.indexOf('control_tree=$(cat'),
    );
    const explicitPreMarkerChildEnvironment = [
      candidateRender,
      backupCommand,
      rollbackValidationCommand,
    ];
    for (const context of explicitPreMarkerChildEnvironment) {
      expect(context).toContain('env \\\n');
      expect(context).toContain('RUNTIME_ENV_FILE="$secret_root/staging.env"');
      expect(context).toContain('REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"');
    }
  });

  it('fails closed on the exact legacy Compose and executes a missing-realtime-env render', () => {
    expect(controller).toContain(
      "supported_active_compose_sha='a9227a66be5044d0286592afb27aca073d50aa8d2ff21067504a0ffdb1804c2a'",
    );
    expect(controller).toContain('pre_marker_phase active-compose-render');
    expect(controller).toContain('pre_marker_phase candidate-compose-render');
    expect(controller).toContain('pre_marker_phase application-backup');
    expect(controller).toContain('pre_marker_phase rollback-validation');
    const rollbackValidation = controller.indexOf('pre_marker_phase rollback-validation');
    const markerPublication = controller.indexOf('prepare-bootstrap-json');
    const preMarkerRevalidation = controller.slice(rollbackValidation, markerPublication);
    expect(preMarkerRevalidation).toContain('active Compose changed before marker publication');
    expect(preMarkerRevalidation).toContain(
      'saved active Compose differs from the reviewed legacy release',
    );

    const composeVersion = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    expect(composeVersion.status, composeVersion.stderr).toBe(0);

    const directory = mkdtempSync(join(tmpdir(), 'phub-b0-compose-'));
    try {
      const stagingEnv = join(directory, 'staging.env');
      const missingRealtimeEnv = join(directory, 'realtime.env');
      writeFileSync(stagingEnv, 'B0_RENDER_PROBE=1\n', { mode: 0o600 });
      const composePath = 'deploy/compose.staging.yaml';
      const composeSource = readFileSync(composePath, 'utf8');
      const requiredEnvironment: NodeJS.ProcessEnv = {};
      for (const match of composeSource.matchAll(/\$\{([A-Z0-9_]+):\?/g)) {
        const name = match[1];
        if (name) requiredEnvironment[name] = `b0-${name.toLowerCase()}`;
      }
      const baseEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        REGISTRY: 'example.invalid/phub',
        WEB_IMAGE_DIGEST: `sha256:${'0'.repeat(64)}`,
        API_IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`,
        WORKER_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`,
        REALTIME_IMAGE_DIGEST: `sha256:${'3'.repeat(64)}`,
        MIGRATOR_IMAGE_DIGEST: `sha256:${'4'.repeat(64)}`,
        RUNTIME_ENV_FILE: stagingEnv,
        ...requiredEnvironment,
      };
      const missing = spawnSync('docker', ['compose', '-f', composePath, 'config', '--quiet'], {
        encoding: 'utf8',
        env: { ...baseEnvironment, REALTIME_RUNTIME_ENV_FILE: missingRealtimeEnv },
      });
      expect(missing.status).not.toBe(0);
      expect(`${missing.stdout}${missing.stderr}`).toContain(missingRealtimeEnv);

      const legacy = spawnSync('docker', ['compose', '-f', composePath, 'config', '--quiet'], {
        encoding: 'utf8',
        env: { ...baseEnvironment, REALTIME_RUNTIME_ENV_FILE: stagingEnv },
      });
      expect(legacy.status, `${legacy.stdout}${legacy.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('executes the reviewed Compose functions with bounded legacy environment inheritance', () => {
    const functions = controller.slice(
      controller.indexOf('compose_with()'),
      controller.indexOf('project_container_id()'),
    );
    const result = spawnSync(
      '/bin/dash',
      [
        '-c',
        [
          'set -eu',
          'app_root=/opt/phub',
          'secret_root=/etc/phub',
          'phase=unknown',
          'docker() { printf "%s|%s|%s|%s\\n" "$phase" "${RUNTIME_ENV_FILE-unset}" "${REALTIME_RUNTIME_ENV_FILE-unset}" "$*"; }',
          functions,
          'export RUNTIME_ENV_FILE="$secret_root/staging.env"',
          'export REALTIME_RUNTIME_ENV_FILE="$secret_root/staging.env"',
          'phase=pre-marker',
          'compose_with /candidate-compose.yaml /candidate-release.env config --quiet',
          'phase=snapshot-child',
          'sh -c \'printf "snapshot-child|%s|%s\\n" "$RUNTIME_ENV_FILE" "$REALTIME_RUNTIME_ENV_FILE"\'',
          'unset RUNTIME_ENV_FILE REALTIME_RUNTIME_ENV_FILE',
          'phase=candidate',
          'compose_with /candidate-compose.yaml /candidate-release.env up realtime',
          'phase=rollback',
          'legacy_compose up realtime',
          'printf "parent|%s|%s\\n" "${RUNTIME_ENV_FILE-unset}" "${REALTIME_RUNTIME_ENV_FILE-unset}"',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      'pre-marker|/etc/phub/staging.env|/etc/phub/staging.env|compose --project-name phub-staging --env-file /opt/phub/infrastructure.env --env-file /candidate-release.env -f /candidate-compose.yaml config --quiet',
      'snapshot-child|/etc/phub/staging.env|/etc/phub/staging.env',
      'candidate|unset|unset|compose --project-name phub-staging --env-file /opt/phub/infrastructure.env --env-file /candidate-release.env -f /candidate-compose.yaml up realtime',
      'rollback|/etc/phub/staging.env|/etc/phub/staging.env|compose --project-name phub-staging --env-file /opt/phub/infrastructure.env --env-file /opt/phub/release.env -f /opt/phub/compose.yaml up realtime',
      'parent|unset|unset',
    ]);
  });

  it('limits the bootstrap helper to the capabilities required for deploy-owned 0600 files', () => {
    const helperRaw = controller.slice(
      controller.indexOf('helper_raw()'),
      controller.indexOf('run_helper()'),
    );
    expect(helperRaw).toContain('--user 0:0');
    expect(helperRaw).toContain('--network none');
    expect(helperRaw).toContain('--read-only');
    expect(helperRaw).toContain('--security-opt no-new-privileges');
    expect(helperRaw).toContain('--cap-drop ALL');
    expect(helperRaw).toContain('--cap-add CHOWN');
    expect(helperRaw).toContain('--cap-add DAC_READ_SEARCH');
    expect(helperRaw).toContain('--cap-add FOWNER');
    expect(helperRaw).not.toContain('--cap-add DAC_OVERRIDE');
    expect(helperRaw).toContain('--mount type=bind,src="$secret_root",dst=/target \\');
    expect(helperRaw).toContain('--mount type=bind,src="$bundle_path",dst=/bundle,readonly \\');
    expect(helperRaw).not.toMatch(/dst=\/target,rw(?:\s|\\)/u);
    expect(helperRaw).not.toMatch(/dst=\/bundle,ro(?:\s|\\)/u);
  });

  it('executes the bootstrap helper with Docker-compatible bind syntax', () => {
    const functions = controller.slice(
      controller.indexOf('resolve_helper_image()'),
      controller.indexOf('run_helper()'),
    );
    const result = spawnSync(
      '/bin/dash',
      [
        '-c',
        [
          'set -eu',
          'bundle_path=/bundle',
          'secret_root=/target-source',
          'helper_script=/dev/null',
          "helper_image='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
          'docker() {',
          '  case "$*" in *",rw "*|*",ro "*) return 64 ;; esac',
          '  printf \'%s\\n\' "$*"',
          '}',
          functions,
          'helper_raw verify-bootstrap-prepared /target',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain('--mount type=bind,src=/target-source,dst=/target');
    expect(result.stdout).toContain('--mount type=bind,src=/bundle,dst=/bundle,readonly');
    expect(result.stdout).not.toMatch(/dst=\/target,rw(?:\s|\\)/u);
    expect(result.stdout).not.toMatch(/dst=\/bundle,ro(?:\s|\\)/u);
  });

  it('passes writable and readonly bind mounts through the real Docker parser', () => {
    const dockerInfo = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
    });
    expect(dockerInfo.status, dockerInfo.stderr).toBe(0);

    const probeImage = 'example.invalid/phub-b0-mount-grammar-probe:never';
    const imageLookup = spawnSync('docker', ['image', 'inspect', probeImage], {
      encoding: 'utf8',
    });
    expect(imageLookup.status).not.toBe(0);

    const directory = mkdtempSync(join(tmpdir(), 'phub-b0-mount-'));
    try {
      const mounts = [
        `type=bind,src=${directory},dst=/target`,
        `type=bind,src=${directory},dst=/bundle,readonly`,
      ];
      for (const mount of mounts) {
        const result = spawnSync(
          'docker',
          [
            'create',
            '--pull=never',
            '--network',
            'none',
            '--read-only',
            '--mount',
            mount,
            probeImage,
          ],
          { encoding: 'utf8' },
        );
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status).toBe(1);
        expect(output).toContain(`No such image: ${probeImage}`);
        expect(output).not.toMatch(/invalid argument.*--mount|invalid field '(?:ro|rw)'/u);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('probes the key boundary offline before stopping and starts candidate services in safe order', () => {
    const prepare = controller.indexOf('prepare-bootstrap-json');
    const dedicatedProbe = controller.indexOf('tickets.dedicated');
    const accessReject = controller.indexOf('tickets.access');
    const stop = controller.lastIndexOf('stop_runtime');
    const realtime = controller.lastIndexOf(
      'compose up -d --no-deps --force-recreate --pull never realtime',
    );
    const api = controller.lastIndexOf('compose up -d --no-deps --force-recreate --pull never api');
    const worker = controller.lastIndexOf(
      'compose up -d --no-deps --force-recreate --pull never worker',
    );
    const web = controller.lastIndexOf('compose up -d --no-deps --force-recreate --pull never web');
    expect(prepare).toBeGreaterThan(0);
    expect(dedicatedProbe).toBeGreaterThan(prepare);
    expect(accessReject).toBeGreaterThan(dedicatedProbe);
    expect(controller).toContain('--mount type=bind,src="$probe_dir",dst=/probe \\');
    expect(controller).toContain('--mount type=bind,src="$probe_dir",dst=/probe,readonly \\');
    expect(controller).not.toMatch(/dst=\/probe,rw(?:\s|\\)/u);
    expect(controller).not.toMatch(/dst=\/probe,ro(?:\s|\\)/u);
    expect(stop).toBeGreaterThan(accessReject);
    expect(realtime).toBeGreaterThan(stop);
    expect(api).toBeGreaterThan(realtime);
    expect(worker).toBeGreaterThan(api);
    expect(web).toBeGreaterThan(worker);
  });

  it('keeps finalization behind isolation, public health and an authenticated WebSocket handshake', () => {
    const isolation = workflow.indexOf('Verify the isolated secret files');
    const publicManifest = workflow.indexOf('Attest the exact candidate through public ingress');
    const finalize = workflow.indexOf('Finalize only after public and authenticated attestation');
    expect(isolation).toBeGreaterThan(0);
    expect(publicManifest).toBeGreaterThan(isolation);
    expect(finalize).toBeGreaterThan(publicManifest);
    expect(workflow).not.toContain('Install control-owned handshake dependencies');
    expect(workflow).not.toContain('STAGING_REALTIME_SMOKE_ACCESS_TOKEN');
    expect(workflow).not.toContain('verify-realtime-ticket-handshake.ts');
    expect(workflow).toContain('staging-realtime-smoke-session.mjs');
    expect(workflow).toContain('verify-staging-realtime-smoke-session.sh');
  });

  it('rotates and validates the dedicated smoke session before marker publication and after cutover', () => {
    const activeReleaseAttestation = workflow.indexOf(
      'Attest the exact public legacy release before writes',
    );
    const publish = workflow.indexOf('Publish the durable controller bundle without executing it');
    const cutover = workflow.indexOf('Perform the coordinated API and realtime B0 cutover');
    expect(activeReleaseAttestation).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(activeReleaseAttestation);
    expect(cutover).toBeGreaterThan(publish);
    const calls = [...controller.matchAll(/^verify_authenticated_smoke$/gmu)].map(
      (match) => match.index ?? -1,
    );
    expect(calls).toHaveLength(2);
    const markerPublication = controller.indexOf('prepare-bootstrap-json');
    const publicCandidate = controller.lastIndexOf('verify_public_release "$candidate_release"');
    const clearRollbackTrap = controller.lastIndexOf('trap - EXIT HUP INT TERM');
    expect(calls[0]).toBeGreaterThan(controller.indexOf('assert_flags_disabled'));
    expect(calls[0]).toBeLessThan(markerPublication);
    expect(calls[1]).toBeGreaterThan(publicCandidate);
    expect(calls[1]).toBeLessThan(clearRollbackTrap);
    expect(stagingSmoke).toContain("const BASE_URL = 'https://lk.nano.padlhub.su'");
    expect(stagingSmoke).toContain("const TENANT_KEY = 'local-padel'");
    expect(stagingSmoke).not.toContain('process.env');
    expect(stagingSmokeWrapper).toContain('--add-host lk.nano.padlhub.su:host-gateway');
    expect(stagingSmokeWrapper).toContain('--cap-drop ALL');
    expect(stagingSmokeWrapper).toContain('--security-opt no-new-privileges');
    expect(stagingSmokeWrapper).toContain("! -name 'session.json.next-*'");
    expect(stagingSmokeWrapper).not.toContain('--env-file "$state');
    expect(stagingSmokeInstaller).toContain('INSTALL_STAGING_REALTIME_SMOKE_SESSION');
    expect(stagingSmokeInstaller).toContain('IFS= read -r refresh_token');
    const rootOwnedTarget = stagingSmokeInstaller.indexOf('install -d -o 0 -g 0 -m 700 "$target"');
    const noClobber = stagingSmokeInstaller.indexOf('set -C', rootOwnedTarget);
    const createCredential = stagingSmokeInstaller.indexOf('> "$temporary"', noClobber);
    const publishCredential = stagingSmokeInstaller.indexOf(
      'mv "$temporary" "$target/session.json"',
      createCredential,
    );
    const transferDirectory = stagingSmokeInstaller.indexOf(
      'chown "$deploy_uid:$deploy_gid" "$target"',
      publishCredential,
    );
    expect(rootOwnedTarget).toBeGreaterThan(0);
    expect(noClobber).toBeGreaterThan(rootOwnedTarget);
    expect(createCredential).toBeGreaterThan(noClobber);
    expect(publishCredential).toBeGreaterThan(createCredential);
    expect(transferDirectory).toBeGreaterThan(publishCredential);
    expect(controller).toContain('typeof WebSocket !== "function"');
    expect(controller).toContain('maybe_fail post-authenticated-smoke');
  });

  it('executes post-smoke failure through the rollback trap without restoring the successor', () => {
    const functionSource = (name: string): string => {
      const start = controller.indexOf(`${name}() {`);
      const end = controller.indexOf('\n}\n', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return controller.slice(start, end + 3);
    };
    const directory = mkdtempSync(join(tmpdir(), 'phub-b0-post-smoke-'));
    try {
      const marker = join(directory, 'marker.json');
      const markerNext = join(directory, 'marker.next');
      const state = join(directory, 'session.json');
      writeFileSync(marker, '{"phase":"web-ready"}\n', { mode: 0o600 });
      writeFileSync(state, '{"refreshToken":"successor"}\n', { mode: 0o600 });
      const result = spawnSync(
        '/bin/dash',
        [
          '-c',
          [
            'set -eu',
            'bundle_path=/bundle',
            `marker=${JSON.stringify(marker)}`,
            `marker_next=${JSON.stringify(markerNext)}`,
            `state_path=${JSON.stringify(state)}`,
            'fail() { printf "%s\\n" "$*" >&2; exit 71; }',
            'maybe_fail() { test "${PHUB_B0_FAIL_AFTER:-}" != "$1" || fail "injected failure after $1"; }',
            'sh() { return 0; }',
            'restore_bootstrap() { test "$(cat "$state_path")" = \'{"refreshToken":"successor"}\'; printf "%s\\n" rollback-invoked; }',
            functionSource('verify_authenticated_smoke'),
            functionSource('on_error'),
            'trap on_error EXIT HUP INT TERM',
            'verify_authenticated_smoke',
            'maybe_fail post-authenticated-smoke',
            'trap - EXIT HUP INT TERM',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PHUB_B0_FAIL_AFTER: 'post-authenticated-smoke' },
        },
      );
      expect(result.status).toBe(71);
      expect(result.stdout.trim()).toBe('rollback-invoked');
      expect(result.stderr).toContain('injected failure after post-authenticated-smoke');
      expect(readFileSync(state, 'utf8')).toBe('{"refreshToken":"successor"}\n');
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains a bounded redacted observation window after finalization', () => {
    const finalize = workflow.indexOf('Finalize only after public and authenticated attestation');
    const observe = workflow.indexOf('Observe the finalized candidate for five minutes');
    expect(observe).toBeGreaterThan(finalize);
    expect(workflow).toContain('for sample in $(seq 0 10)');
    expect(workflow).toContain('test "$sample" -eq 10 || sleep 30');
    expect(workflow).toContain('verify-legacy-runtime-secret-bootstrap-runtime.sh');
    expect(runtimeObservation).toContain('docker logs --since 90s');
    expect(runtimeObservation).toContain('unset log_output');
    expect(runtimeObservation).toContain('restarts=0 critical_logs=0 status=passed');
  });

  it('recovers from the durable original bundle without rebuilding or pulling', () => {
    expect(workflow).toContain('original_control_sha');
    expect(workflow).toContain('original_run_id');
    expect(workflow).toContain('original_run_attempt');
    expect(workflow).toContain('Recover automatically after a failed START');
    expect(workflow).toContain('.runtime-secret-bootstrap.finalized.json');
    expect(controller).toContain('restore-bootstrap-files');
    expect(controller).toContain('old realtime before old API');
    const restore = controller.indexOf('restore_definitions()');
    const oldRealtime = controller.indexOf(
      'old_realtime_ref=$(state_field oldImages.realtime.ref)',
    );
    const oldApi = controller.indexOf('old_api_ref=$(state_field oldImages.api.ref)');
    expect(restore).toBeGreaterThan(0);
    expect(oldRealtime).toBeGreaterThan(restore);
    expect(oldApi).toBeGreaterThan(oldRealtime);
    expect(controller).not.toContain('--confirm=ROLLBACK_STAGING_RELEASE');
    expect(controller).toContain('action=already-finalized');
    expect(controller).toContain('attest_finalized_bootstrap');
    expect(controller).toContain('verified | finalizing | finalized)');
    const filesOnly = controller.indexOf('action=files-only-rollback');
    const stopRuntime = controller.indexOf(
      'stop_runtime',
      controller.indexOf('restore_bootstrap()'),
    );
    expect(filesOnly).toBeGreaterThan(0);
    expect(filesOnly).toBeLessThan(stopRuntime);
    expect(controller).toContain('initial | files-prepared | images-probed)');
    expect(controller).toContain('pre-runtime recovery found a changed serving runtime');
    expect(controller).toContain('scope: "realtime.connect"');
    expect(controller).toContain('payload.scope !== "realtime.connect"');
    expect(controller).toContain(
      ":$deploy_uid:$deploy_gid:600\" || fail 'staging.env metadata differs'",
    );
    expect(helper).toContain(
      'staging: { uid: Number(deployUid), gid: Number(deployGid), mode: 0o600 }',
    );
    for (const phase of [
      'files-prepared',
      'images-probed',
      'runtime-stopping',
      'runtime-stopped',
      'compose-committed',
      'release-committed',
      'realtime-ready',
      'api-ready',
      'worker-ready',
      'web-ready',
    ]) {
      expect(controller).toContain(`maybe_fail ${phase}`);
    }
    const stoppingIntent = controller.indexOf(
      'advance-bootstrap-phase images-probed runtime-stopping',
    );
    const stopRuntimeCall = controller.indexOf('stop_runtime', stoppingIntent);
    const stoppedAttestation = controller.indexOf(
      'advance-bootstrap-phase runtime-stopping runtime-stopped',
      stopRuntimeCall,
    );
    expect(stoppingIntent).toBeGreaterThan(0);
    expect(stopRuntimeCall).toBeGreaterThan(stoppingIntent);
    expect(stoppedAttestation).toBeGreaterThan(stopRuntimeCall);
  });

  it('blocks every shared operation on both B0 definition next files', () => {
    for (const source of [sharedGuard, communitiesInspection, communitiesBackup]) {
      expect(source).toContain('.runtime-secret-bootstrap.compose.next');
      expect(source).toContain('.runtime-secret-bootstrap.release.next');
    }
  });

  it('documents the legacy capability boundary and separate later media release', () => {
    expect(runbook).toContain('e308181da5222645d9a87d03642923c6841be8d1');
    expect(runbook).toContain('Bootstrap staging runtime-secret boundary (B0)');
    expect(runbook).toContain('/etc/phub/staging-realtime-smoke/session.json');
    expect(runbook).toContain('tenant `local-padel`; `nano` is not the tenant key');
    expect(runbook).toContain("git rev-parse 'HEAD^{tree}'");
    expect(runbook).toContain('git status --porcelain=v1 --untracked-files=all');
    expect(runbook).toContain(
      "git rev-parse 'HEAD:deploy/jetson/install-staging-realtime-smoke-session.sh'",
    );
    expect(runbook).toContain(
      'git hash-object deploy/jetson/install-staging-realtime-smoke-session.sh',
    );
    expect(runbook).toContain('later main/media release and migrations are a separate approval');
  });
});
