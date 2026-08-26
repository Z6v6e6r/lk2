import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { renderReleaseEnvironment } from './render-timeweb-beta-release-env.js';

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const runId = '12345678901';
const components = ['web', 'api', 'worker', 'realtime', 'migrator'];
const digestCharacters = ['1', '2', '3', '4', '5'];
const runtimeDigestCharacters = ['6', '7', '8', '9', 'a'];

function manifest() {
  return {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    repository: 'Z6v6e6r/lk2',
    gitCommit: commit,
    gitTree: tree,
    platform: 'linux/amd64',
    publication: {
      workflow: '.github/workflows/publish-timeweb-amd64-images.yaml',
      workflowSha: commit,
      runId,
      runAttempt: '1',
    },
    images: components.map((component, index) => ({
      component,
      repository: `ghcr.io/z6v6e6r/phub-${component}`,
      digest: `sha256:${digestCharacters[index]!.repeat(64)}`,
      runtimeDigest: `sha256:${runtimeDigestCharacters[index]!.repeat(64)}`,
      architecture: 'amd64',
      revision: commit,
      provenance: true,
      sbom: true,
      publication: true,
    })),
  };
}

describe('Timeweb beta release environment renderer', () => {
  it('renders only immutable non-secret release identity', () => {
    const output = renderReleaseEnvironment(manifest(), {
      workflowSha: commit,
      runId,
      runAttempt: '1',
    });
    expect(output).toContain(`PHUB_RELEASE=${commit}\n`);
    expect(output).toContain(`WEB_IMAGE_DIGEST=sha256:${'1'.repeat(64)}\n`);
    expect(output).toContain(`MIGRATOR_RUNTIME_DIGEST=sha256:${'a'.repeat(64)}\n`);
    expect(output).not.toMatch(/SECRET|TOKEN|PASSWORD/u);
  });

  it('rejects publication identity drift', () => {
    expect(() =>
      renderReleaseEnvironment(manifest(), {
        workflowSha: 'f'.repeat(40),
        runId,
        runAttempt: '1',
      }),
    ).toThrow('publication_identity_mismatch');
  });
});
