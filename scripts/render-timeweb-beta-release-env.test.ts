import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { provisionTimewebBetaRuntimeSecrets } from './provision-timeweb-beta-runtime-secrets.js';
import {
  assertNoAmbientComposeOverrides,
  assertNoAmbientDockerOverrides,
  buildTimewebInitialBetaComposeInvocation,
  readCanonicalTimewebReleasePair,
  readCanonicalTimewebRunEvidence,
  renderTimewebBetaReleaseEnvironment,
  runTimewebInitialBetaComposeStage,
  verifyCanonicalGitHubRunAuthority,
  writeTimewebBetaReleaseEnvironment,
} from './render-timeweb-beta-release-env.js';
import { assertExactTimewebFrozenSource } from './verify-timeweb-frozen-source.js';
import {
  canonicalManifest,
  canonicalRunEvidence,
  createSecretFixture,
  githubApiFixture,
  host,
  releaseId,
  runId,
  sourceSha,
  sourceTree,
  tenantKey,
  writeCanonicalPair,
  writeCanonicalRunEvidence,
} from './timeweb-beta-activation-inputs.fixture.js';

const roots: string[] = [];
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
let trustedAuthority: Awaited<ReturnType<typeof verifyCanonicalGitHubRunAuthority>>;
let sourceAuthority: ReturnType<typeof assertExactTimewebFrozenSource>;

beforeAll(async () => {
  sourceAuthority = assertExactTimewebFrozenSource({
    expectedSourceSha: sourceSha,
    expectedSourceTree: sourceTree,
  });
  const secrets = createSecretFixture();
  roots.push(secrets.root);
  const artifactDir = join(secrets.root, 'trusted-artifact');
  const pair = writeCanonicalPair(artifactDir);
  const api = githubApiFixture(pair);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = api.fetch;
  try {
    trustedAuthority = await verifyCanonicalGitHubRunAuthority({
      manifest: canonicalManifest(),
      manifestBytes: Buffer.from(pair.contents),
      checksumBytes: Buffer.from(pair.checksumContents),
      manifestChecksum: pair.checksum,
      expectedSourceSha: sourceSha,
      expectedSourceTree: sourceTree,
      expectedWorkflowSha: sourceSha,
      expectedRunId: runId,
      expectedRunAttempt: '1',
      githubTokenFile: secrets.githubTokenFile,
      expectedUid: uid,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const secrets = createSecretFixture();
  roots.push(secrets.root);
  provisionTimewebBetaRuntimeSecrets({
    sourceDir: secrets.sourceDir,
    targetDir: secrets.targetDir,
    backupRoot: secrets.backupRoot,
    host,
    tenantKey,
    releaseId,
    expectedSourceSha: sourceSha,
    expectedSourceTree: sourceTree,
    expectedUid: uid,
    expectedGid: gid,
  });
  const artifactDir = join(secrets.root, 'artifact');
  const pair = writeCanonicalPair(artifactDir);
  const runEvidence = writeCanonicalRunEvidence(artifactDir, pair.checksum);
  const releaseRoot = join(secrets.root, 'releases');
  const releaseDir = join(releaseRoot, releaseId);
  mkdirSync(releaseDir, { recursive: true, mode: 0o700 });
  chmodSync(releaseRoot, 0o700);
  chmodSync(releaseDir, 0o700);
  return { secrets, pair, runEvidence, releaseRoot, releaseDir };
}

const expected = (runtimeEnvRoot: string, checksum: string) => {
  return {
    expectedSourceSha: sourceSha,
    expectedSourceTree: sourceTree,
    expectedWorkflowSha: sourceSha,
    expectedRunId: runId,
    expectedRunAttempt: '1',
    canonicalManifestChecksum: checksum,
    runEvidence: trustedAuthority.evidence,
    runEvidenceChecksum: trustedAuthority.checksum,
    runtimeEnvRoot,
    sourceAuthority,
  };
};

async function verifyFixtureAuthority(
  value: ReturnType<typeof fixture>,
  transform?: (url: string, response: Response) => Promise<Response> | Response,
) {
  const api = githubApiFixture(value.pair);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const response = await api.fetch(input);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return transform ? transform(url, response) : response;
  };
  try {
    return await verifyCanonicalGitHubRunAuthority({
      manifest: canonicalManifest(),
      manifestBytes: Buffer.from(value.pair.contents),
      checksumBytes: Buffer.from(value.pair.checksumContents),
      manifestChecksum: value.pair.checksum,
      expectedSourceSha: sourceSha,
      expectedSourceTree: sourceTree,
      expectedWorkflowSha: sourceSha,
      expectedRunId: runId,
      expectedRunAttempt: '1',
      githubTokenFile: value.secrets.githubTokenFile,
      expectedUid: uid,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Timeweb beta release.env renderer', () => {
  it('requires opaque exact-local-source authority before trusting rendered deployment input', () => {
    const value = fixture();
    expect(() =>
      renderTimewebBetaReleaseEnvironment(canonicalManifest(), {
        ...expected(value.secrets.targetDir, value.pair.checksum),
        // @ts-expect-error Caller-authored source authority must fail at runtime.
        sourceAuthority: {
          sourceSha,
          sourceTree,
        },
      }),
    ).toThrow('frozen_source_authority');
  });

  it('accepts only the canonical pair and atomically renders root-only disabled profiles', () => {
    const value = fixture();
    const pair = readCanonicalTimewebReleasePair(value.pair.manifestPath, value.pair.checksum);
    const result = writeTimewebBetaReleaseEnvironment({
      manifest: pair.manifest,
      ...expected(value.secrets.targetDir, pair.checksum),
      releaseRoot: value.releaseRoot,
      releaseDir: value.releaseDir,
      expectedUid: uid,
      expectedGid: gid,
      ambientEnvironment: {},
    });
    expect(result).toEqual({
      releaseId,
      output: join(value.releaseDir, 'release.env'),
      mode: '0600',
    });
    expect(lstatSync(result.output).mode & 0o777).toBe(0o600);
    const contents = readFileSync(result.output, 'utf8');
    expect(contents).toContain(`PHUB_RELEASE_SOURCE_SHA=${sourceSha}\n`);
    expect(contents).toContain(`PHUB_RELEASE_SOURCE_TREE=${sourceTree}\n`);
    expect(contents).toContain(`PHUB_CANONICAL_MANIFEST_SHA256=${pair.checksum}\n`);
    expect(contents).toContain(
      `PHUB_CANONICAL_ARTIFACT_DIGEST=${trustedAuthority.evidence.canonicalArtifact.digest}\n`,
    );
    expect(contents).toContain(`TIMEWEB_RUNTIME_ENV_ROOT=${value.secrets.targetDir}\n`);
    expect(contents).toContain('PHUB_WORKER_ENABLED=false\n');
    expect(contents).toContain('PHUB_MIGRATOR_ENABLED=false\n');
    expect(contents).toContain('PHUB_ROLLBACK_MODE=stop-candidate-no-previous-release\n');
    expect(contents).toContain(`WEB_IMAGE_DIGEST=sha256:${'1'.repeat(64)}\n`);
    expect(contents).not.toMatch(/(?:PASSWORD|TOKEN|CLIENT_SECRET)=/u);
    expect(() =>
      writeTimewebBetaReleaseEnvironment({
        manifest: pair.manifest,
        ...expected(value.secrets.targetDir, pair.checksum),
        releaseRoot: value.releaseRoot,
        releaseDir: value.releaseDir,
        expectedUid: uid,
        expectedGid: gid,
        ambientEnvironment: {},
      }),
    ).toThrow('release_env_exists');
  });

  it.each([
    [
      'missing component',
      (manifest: ReturnType<typeof canonicalManifest>) => manifest.images.pop(),
      'canonical_component_set',
    ],
    [
      'duplicate component',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.images[4] = { ...manifest.images[0]! };
      },
      'canonical_component_set',
    ],
    [
      'wrong repository',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.repository = 'someone/else';
      },
      'canonical_header',
    ],
    [
      'wrong platform',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.platform = 'linux/arm64';
      },
      'canonical_header',
    ],
    [
      'mutable reference',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.images[0]!.digest = `amd64-sha-${sourceSha}`;
      },
      'canonical_digest',
    ],
    [
      'wrong source',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.gitCommit = 'f'.repeat(40);
      },
      'canonical_git_tree_unavailable',
    ],
    [
      'wrong tree',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.gitTree = 'f'.repeat(40);
      },
      'canonical_header',
    ],
    [
      'wrong workflow',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.publication.workflowSha = 'f'.repeat(40);
      },
      'canonical_publication_identity',
    ],
    [
      'attempt 2',
      (manifest: ReturnType<typeof canonicalManifest>) => {
        manifest.publication.runAttempt = '2';
      },
      'canonical_publication_identity',
    ],
  ])('rejects %s', (_name, mutate, reason) => {
    const value = fixture();
    const manifest = canonicalManifest();
    mutate(manifest);
    expect(() =>
      renderTimewebBetaReleaseEnvironment(
        manifest,
        expected(value.secrets.targetDir, 'a'.repeat(64)),
      ),
    ).toThrow(reason);
  });

  it.each([
    ['failed run receipt', { schemaVersion: 'PHUB_TIMEWEB_RUN_RECEIPT_V1', conclusion: 'failure' }],
    ['partial inventory', { schemaVersion: 'PHUB_TIMEWEB_REGISTRY_INVENTORY_V1', complete: false }],
    ['immediate push receipt', { schemaVersion: 'PHUB_TIMEWEB_PUSH_RECEIPT_V1', images: [] }],
    ['reconciliation evidence', { schemaVersion: 'PHUB_TIMEWEB_RELEASE_RECONCILIATION_V1' }],
  ])('rejects non-canonical %s', (_name, manifest) => {
    const value = fixture();
    expect(() =>
      renderTimewebBetaReleaseEnvironment(
        manifest,
        expected(value.secrets.targetDir, 'a'.repeat(64)),
      ),
    ).toThrow('canonical_schema_version');
  });

  it('explicitly rejects failed publication run 33011023879 even if shaped like V2', () => {
    const value = fixture();
    const manifest = canonicalManifest();
    manifest.publication.runId = '33011023879';
    expect(() =>
      renderTimewebBetaReleaseEnvironment(manifest, {
        ...expected(value.secrets.targetDir, 'a'.repeat(64)),
        expectedRunId: '33011023879',
      }),
    ).toThrow('forbidden_publication_run');
  });

  it('rejects self-issued evidence even when its self-issued checksum matches', () => {
    const value = fixture();
    const evidence = canonicalRunEvidence(value.pair.checksum);
    expect(() =>
      renderTimewebBetaReleaseEnvironment(canonicalManifest(), {
        ...expected(value.secrets.targetDir, value.pair.checksum),
        // @ts-expect-error A caller-authored record must fail both the type and runtime boundaries.
        runEvidence: evidence,
      }),
    ).toThrow('untrusted_run_evidence');
  });

  it('freezes trusted evidence and rejects manifest digest mutation after API verification', () => {
    const value = fixture();
    expect(Object.isFrozen(trustedAuthority.evidence)).toBe(true);
    expect(Object.isFrozen(trustedAuthority.evidence.canonicalArtifact)).toBe(true);
    expect(Object.isFrozen(trustedAuthority.evidence.canonicalArtifact.files)).toBe(true);
    const changedManifest = canonicalManifest();
    changedManifest.images[0]!.digest = `sha256:${'f'.repeat(64)}`;
    expect(() =>
      renderTimewebBetaReleaseEnvironment(
        changedManifest,
        expected(value.secrets.targetDir, value.pair.checksum),
      ),
    ).toThrow('run_evidence_manifest_binding');
  });

  it('rejects a failed run reported by the authenticated GitHub API', async () => {
    const value = fixture();
    await expect(
      verifyFixtureAuthority(value, async (url, response) => {
        if (!url.includes('/attempts/1')) return response;
        return Response.json({ ...(await response.json()), conclusion: 'failure' });
      }),
    ).rejects.toThrow('github_run_identity');
  });

  it('uses bounded retry for transient authenticated GitHub API failures', async () => {
    const value = fixture();
    let transientFailures = 0;
    const result = await verifyFixtureAuthority(value, (url, response) => {
      if (url.includes('/attempts/1') && transientFailures < 2) {
        transientFailures += 1;
        return new Response(null, { status: 503 });
      }
      return response;
    });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(transientFailures).toBe(2);
  });

  it('rejects incomplete live GHCR inventory', async () => {
    const value = fixture();
    await expect(
      verifyFixtureAuthority(value, (url, response) =>
        url.includes('/packages/container/phub-worker/') ? Response.json([]) : response,
      ),
    ).rejects.toThrow('registry_inventory_incomplete');
  });

  it('rejects canonical artifact metadata or downloaded digest drift', async () => {
    const metadata = fixture();
    await expect(
      verifyFixtureAuthority(metadata, async (url, response) => {
        if (!url.includes('/artifacts?')) return response;
        const listing = (await response.json()) as { artifacts: Array<Record<string, unknown>> };
        listing.artifacts[0]!.name = 'timeweb-amd64-push-receipt';
        return Response.json(listing);
      }),
    ).rejects.toThrow('canonical_artifact_custody');

    const digest = fixture();
    await expect(
      verifyFixtureAuthority(digest, (url, response) =>
        url.endsWith('/zip')
          ? new Response(Buffer.from('not-the-authenticated-archive'))
          : response,
      ),
    ).rejects.toThrow('canonical_artifact_digest');
  });

  it('rejects checksum drift and malformed canonical sidecars', () => {
    const value = fixture();
    expect(() => readCanonicalTimewebReleasePair(value.pair.manifestPath, 'f'.repeat(64))).toThrow(
      'checksum_mismatch',
    );
    writeFileSync(
      join(value.pair.manifestPath, '..', 'release-manifest.sha256'),
      'not-a-checksum\n',
      {
        mode: 0o600,
      },
    );
    expect(() =>
      readCanonicalTimewebReleasePair(value.pair.manifestPath, value.pair.checksum),
    ).toThrow('checksum_format');
    expect(() =>
      readCanonicalTimewebRunEvidence(value.runEvidence.evidencePath, 'f'.repeat(64)),
    ).toThrow('run_evidence_checksum_mismatch');
  });

  it('rejects ambient Compose overrides', () => {
    expect(() => assertNoAmbientComposeOverrides({ COMPOSE_PROFILES: 'background' })).toThrow(
      'ambient_compose_override',
    );
    expect(() => assertNoAmbientComposeOverrides({ COMPOSE_FILE: 'other.yaml' })).toThrow(
      'ambient_compose_override',
    );
    expect(() => assertNoAmbientComposeOverrides({ PATH: '/usr/bin' })).not.toThrow();
  });

  it('rejects ambient Docker daemon/config authority before any controller execution', () => {
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
      expect(() => assertNoAmbientDockerOverrides({ [key]: 'hostile-value' })).toThrow(
        'ambient_docker_override',
      );
    }
    expect(() => assertNoAmbientDockerOverrides({ HOME: '/caller-controlled' })).not.toThrow();

    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://attacker.invalid:2375';
    try {
      expect(() =>
        runTimewebInitialBetaComposeStage(
          'preflight',
          '/opt/phub/timeweb-beta/releases/example/release.env',
          // @ts-expect-error The hostile environment must fail before this untrusted object matters.
          { releaseId: 'example', contents: '' },
        ),
      ).toThrow('ambient_docker_override');
    } finally {
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
  });

  it('builds only the source-controlled initial-beta service stages without profiles', () => {
    const releaseEnv = '/opt/phub/timeweb-beta/releases/example/release.env';
    const upApi = buildTimewebInitialBetaComposeInvocation('up-api', releaseEnv);
    expect(upApi.command).toBe('/usr/bin/docker');
    expect(upApi.args.slice(-4)).toEqual(['up', '-d', '--no-deps', 'api']);
    expect(buildTimewebInitialBetaComposeInvocation('up-web', releaseEnv).args).not.toContain(
      '--profile',
    );
    expect(buildTimewebInitialBetaComposeInvocation('up-realtime', releaseEnv).args).not.toContain(
      'worker',
    );
    expect(() =>
      // @ts-expect-error Worker is intentionally absent from the supported stage type.
      buildTimewebInitialBetaComposeInvocation('up-worker', releaseEnv),
    ).toThrow('compose_stage');
    expect(() =>
      // @ts-expect-error Migrator is intentionally absent from the supported stage type.
      buildTimewebInitialBetaComposeInvocation('up-migrator', releaseEnv),
    ).toThrow('compose_stage');
    expect(() =>
      runTimewebInitialBetaComposeStage(
        'preflight',
        releaseEnv,
        // @ts-expect-error Hand-authored release data is intentionally outside the trusted type.
        { releaseId: 'example', contents: 'API_IMAGE_DIGEST=sha256:fake\n' },
      ),
    ).toThrow('untrusted_rendered_environment');
  });

  it('rejects symlinked or unsafe runtime secret paths', () => {
    const symlink = fixture();
    const apiPath = join(symlink.secrets.targetDir, 'api.env');
    const realPath = join(symlink.secrets.root, 'api-real.env');
    rmSync(apiPath);
    writeFileSync(realPath, 'SYNTHETIC=value\n', { mode: 0o600 });
    symlinkSync(realPath, apiPath);
    expect(() =>
      writeTimewebBetaReleaseEnvironment({
        manifest: canonicalManifest(),
        ...expected(symlink.secrets.targetDir, symlink.pair.checksum),
        releaseRoot: symlink.releaseRoot,
        releaseDir: symlink.releaseDir,
        expectedUid: uid,
        ambientEnvironment: {},
      }),
    ).toThrow('runtime_secret_file_security');

    const permissions = fixture();
    chmodSync(join(permissions.secrets.targetDir, 'realtime.env'), 0o640);
    expect(() =>
      writeTimewebBetaReleaseEnvironment({
        manifest: canonicalManifest(),
        ...expected(permissions.secrets.targetDir, permissions.pair.checksum),
        releaseRoot: permissions.releaseRoot,
        releaseDir: permissions.releaseDir,
        expectedUid: uid,
        ambientEnvironment: {},
      }),
    ).toThrow('runtime_secret_file_security');
  });

  it('rejects unexpected worker/migrator activation and historical release paths by construction', () => {
    const value = fixture();
    const rendered = renderTimewebBetaReleaseEnvironment(
      canonicalManifest(),
      expected(
        value.secrets.targetDir,
        createHash('sha256').update(value.pair.contents).digest('hex'),
      ),
    );
    expect(rendered.contents).toContain('COMPOSE_PROFILES=\n');
    expect(rendered.contents).toContain('PHUB_WORKER_ENABLED=false');
    expect(rendered.contents).toContain('PHUB_MIGRATOR_ENABLED=false');
    expect(() =>
      writeTimewebBetaReleaseEnvironment({
        manifest: canonicalManifest(),
        ...expected(value.secrets.targetDir, value.pair.checksum),
        releaseRoot: join(value.secrets.root, 'staging'),
        releaseDir: join(value.secrets.root, 'staging', releaseId),
        expectedUid: uid,
        ambientEnvironment: {},
      }),
    ).toThrow('release_root');
  });

  it('removes its exact output when a handled post-rename failure occurs', () => {
    const value = fixture();
    expect(() =>
      writeTimewebBetaReleaseEnvironment({
        manifest: canonicalManifest(),
        ...expected(value.secrets.targetDir, value.pair.checksum),
        releaseRoot: value.releaseRoot,
        releaseDir: value.releaseDir,
        expectedUid: uid,
        expectedGid: gid,
        ambientEnvironment: {},
        failAfter: 'rename',
      }),
    ).toThrow('injected_failure');
    expect(() => lstatSync(join(value.releaseDir, 'release.env'))).toThrow();
  });

  it('feeds generated release.env into default Compose without enabling worker or migrator', () => {
    const value = fixture();
    const result = writeTimewebBetaReleaseEnvironment({
      manifest: canonicalManifest(),
      ...expected(value.secrets.targetDir, value.pair.checksum),
      releaseRoot: value.releaseRoot,
      releaseDir: value.releaseDir,
      expectedUid: uid,
      expectedGid: gid,
      ambientEnvironment: {},
    });
    const composeEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
    );
    const compose = (...args: string[]) =>
      execFileSync(
        'docker',
        ['compose', '--env-file', result.output, '-f', 'deploy/timeweb/compose.beta.yaml', ...args],
        { encoding: 'utf8', env: composeEnvironment },
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort();
    expect(compose('config', '--services')).toEqual(['api', 'realtime', 'web']);
    expect(compose('config', '--images')).toEqual(
      canonicalManifest()
        .images.filter(({ component }) => ['api', 'realtime', 'web'].includes(component))
        .map(({ repository, digest }) => `${repository}@${digest}`)
        .sort(),
    );
  });
});
