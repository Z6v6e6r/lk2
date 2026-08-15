import { readFileSync } from 'node:fs';

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
    expect(controller).toContain('--input-type=module -');
    expect(controller).not.toContain('--privileged');
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
