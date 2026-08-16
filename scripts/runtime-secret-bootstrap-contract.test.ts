import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/bootstrap-staging-runtime-secrets.yaml', 'utf8');
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
    expect(stop).toBeGreaterThan(accessReject);
    expect(realtime).toBeGreaterThan(stop);
    expect(api).toBeGreaterThan(realtime);
    expect(worker).toBeGreaterThan(api);
    expect(web).toBeGreaterThan(worker);
  });

  it('keeps finalization behind isolation, public health and an authenticated WebSocket handshake', () => {
    const isolation = workflow.indexOf('Verify the isolated secret files');
    const handshake = workflow.indexOf('Prove an authenticated API ticket reaches realtime');
    const publicManifest = workflow.indexOf('Attest the exact candidate through public ingress');
    const finalize = workflow.indexOf('Finalize only after public and authenticated attestation');
    expect(isolation).toBeGreaterThan(0);
    expect(handshake).toBeGreaterThan(isolation);
    expect(publicManifest).toBeGreaterThan(handshake);
    expect(finalize).toBeGreaterThan(publicManifest);
    expect(workflow).toContain('Install control-owned handshake dependencies');
    expect(workflow).toContain('STAGING_REALTIME_SMOKE_ACCESS_TOKEN');
    expect(workflow).toContain('verify-realtime-ticket-handshake.ts');
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
    expect(controller).toContain(":640\" || fail 'staging.env metadata differs'");
    expect(helper).toContain('staging: { uid: 0, gid: Number(deployGid), mode: 0o640 }');
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
    expect(runbook).toContain('STAGING_REALTIME_SMOKE_ACCESS_TOKEN');
    expect(runbook).toContain('later main/media release and migrations are a separate approval');
  });
});
