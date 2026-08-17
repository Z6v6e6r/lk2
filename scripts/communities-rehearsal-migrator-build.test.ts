import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  createCandidateReleaseBytes,
  requireDigest,
  selectDockerArchiveConfigPath,
  validateAttestationManifests,
  validateAttestationStatements,
  validateImageConfig,
  validateOciIndex,
  validateRuntimeManifest,
} from './prepare-communities-rehearsal-migrator-evidence.js';

const candidateSha = 'a'.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe('Communities rehearsal migrator build', () => {
  it('publishes only an exact-main arm64 migrator and produces non-authorizing evidence', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/build-communities-rehearsal-migrator.yaml', import.meta.url),
      'utf8',
    );
    const helper = await readFile(
      new URL('./prepare-communities-rehearsal-migrator-evidence.ts', import.meta.url),
      'utf8',
    );
    const document = parse(workflow) as {
      readonly on: Readonly<Record<string, unknown>>;
      readonly permissions: Readonly<Record<string, string>>;
      readonly jobs: Readonly<
        Record<
          string,
          {
            readonly environment?: unknown;
            readonly needs?: string | readonly string[];
            readonly permissions?: Readonly<Record<string, string>>;
            readonly steps?: readonly { readonly uses?: string }[];
          }
        >
      >;
    };

    expect(Object.keys(document.on)).toEqual(['workflow_dispatch']);
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(document.jobs)).toEqual([
      'validate-request',
      'verify-source',
      'build-migrator',
    ]);
    expect(document.jobs['verify-source']?.needs).toBe('validate-request');
    expect(document.jobs['build-migrator']?.needs).toEqual(['validate-request', 'verify-source']);
    expect(document.jobs['build-migrator']?.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
    expect(Object.values(document.jobs).every((job) => job.environment === undefined)).toBe(true);

    expect(workflow).toContain('BUILD_COMMUNITIES_REHEARSAL_MIGRATOR');
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$EVENT_SHA"');
    expect(workflow).toContain('test "$REPOSITORY" = Z6v6e6r/lk2');
    expect(workflow).toContain('test "$RUN_ATTEMPT" = 1');
    expect(workflow).toContain('test "$ACTOR" = "$TRIGGERING_ACTOR"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(workflow).toContain('file: apps/migrator/Dockerfile');
    expect(workflow).toContain('platforms: linux/arm64');
    expect(workflow).toContain('provenance: mode=max');
    expect(workflow).toContain('sbom: true');
    expect(workflow).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(workflow).toContain('release.communities-rehearsal-${{ github.sha }}.env');
    expect(workflow).toContain("grep -Eq '^[0-9a-f]{64}$'");
    expect(workflow).toContain('Artifact digest: sha256:$ARTIFACT_DIGEST');
    expect(helper).toContain('META|authorizesRehearsal|false');
    expect(helper).toContain('META|authorizesDeploy|false');
    expect(helper).toContain('META|authorizesSharedMigration|false');
    const uses = Object.values(document.jobs).flatMap(
      (job) => job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(workflow).not.toMatch(/\b(?:ssh|scp|tailscale)\b/iu);
    expect(workflow).not.toMatch(/docker compose|npm run db:migrate(?:\s|$)/u);
    expect(workflow).not.toMatch(/deploy-staging|run-communities-staged-migration-rehearsal/u);
  });

  it('requires a single arm64 runtime manifest and recognized attestations', () => {
    const runtimeDigest = digest('b');
    const index = {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          digest: runtimeDigest,
          platform: { os: 'linux', architecture: 'arm64' },
        },
        {
          digest: digest('c'),
          platform: { os: 'unknown', architecture: 'unknown' },
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': runtimeDigest,
          },
        },
      ],
    };

    expect(validateOciIndex(index)).toEqual({
      runtimeDigest,
      attestationDigests: [digest('c')],
    });
    expect(() =>
      validateOciIndex({
        ...index,
        manifests: [
          ...index.manifests,
          { digest: digest('d'), platform: { os: 'linux', architecture: 'amd64' } },
        ],
      }),
    ).toThrow('COMMUNITIES_REHEARSAL_MIGRATOR_PLATFORM_MISMATCH');
    expect(() =>
      validateOciIndex({
        ...index,
        manifests: [index.manifests[0]!, { digest: digest('e'), platform: {} }],
      }),
    ).toThrow();
  });

  it('requires provenance and SBOM statements bound to the runtime digest', () => {
    const runtimeDigest = digest('b');
    const layers = validateAttestationManifests([
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
        config: { digest: digest('e') },
        layers: [
          {
            digest: digest('c'),
            mediaType: 'application/vnd.in-toto+json',
            annotations: {
              'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v0.2',
            },
          },
          {
            digest: digest('d'),
            mediaType: 'application/vnd.in-toto+json',
            annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
          },
        ],
      },
    ]);
    const subject = [{ digest: { sha256: runtimeDigest.slice('sha256:'.length) } }];
    const statements = [
      {
        _type: 'https://in-toto.io/Statement/v0.1',
        subject,
        predicateType: 'https://slsa.dev/provenance/v0.2',
        predicate: { buildType: 'https://mobyproject.org/buildkit@v1' },
      },
      {
        _type: 'https://in-toto.io/Statement/v0.1',
        subject,
        predicateType: 'https://spdx.dev/Document',
        predicate: { SPDXID: 'SPDXRef-DOCUMENT' },
      },
    ];

    expect(validateAttestationStatements(layers, statements, runtimeDigest)).toEqual([
      'https://slsa.dev/provenance/v0.2',
      'https://spdx.dev/Document',
    ]);
    expect(() =>
      validateAttestationStatements(
        layers,
        [{ ...statements[0], subject: [{ digest: { sha256: '0'.repeat(64) } }] }, statements[1]!],
        runtimeDigest,
      ),
    ).toThrow('COMMUNITIES_REHEARSAL_ATTESTATION_STATEMENT_INVALID');
  });

  it('binds the runtime config and canonical two-line candidate bytes', () => {
    const configBytes = Buffer.from(
      JSON.stringify({
        architecture: 'arm64',
        os: 'linux',
        config: {
          Labels: {
            'org.opencontainers.image.revision': candidateSha,
            'org.opencontainers.image.source': 'https://github.com/Z6v6e6r/lk2',
          },
        },
      }),
    );
    const configDigest = `sha256:${createHash('sha256').update(configBytes).digest('hex')}`;
    expect(
      validateRuntimeManifest({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { digest: configDigest },
        layers: [{ digest: digest('f') }],
      }),
    ).toBe(configDigest);
    expect(() =>
      validateImageConfig(
        {
          architecture: 'amd64',
          os: 'linux',
          config: {
            Labels: {
              'org.opencontainers.image.revision': candidateSha,
              'org.opencontainers.image.source': 'https://github.com/Z6v6e6r/lk2',
            },
          },
        },
        candidateSha,
      ),
    ).toThrow('COMMUNITIES_REHEARSAL_MIGRATOR_CONFIG_PLATFORM_MISMATCH');
    expect(createCandidateReleaseBytes(candidateSha, digest('9')).toString('utf8')).toBe(
      `RELEASE=${candidateSha}\nMIGRATOR_IMAGE_DIGEST=${digest('9')}\n`,
    );
  });

  it('rejects a byte mismatch at every OCI custody link', () => {
    const bytes = Buffer.from('reviewed-bytes', 'utf8');
    const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(() => requireDigest(bytes, expected, 'MISMATCH')).not.toThrow();
    for (const code of [
      'COMMUNITIES_REHEARSAL_OCI_INDEX_DIGEST_MISMATCH',
      'COMMUNITIES_REHEARSAL_RUNTIME_MANIFEST_DIGEST_MISMATCH',
      'COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_DIGEST_MISMATCH',
      'COMMUNITIES_REHEARSAL_ATTESTATION_MANIFEST_DIGEST_MISMATCH',
      'COMMUNITIES_REHEARSAL_ATTESTATION_STATEMENT_DIGEST_MISMATCH',
    ]) {
      expect(() => requireDigest(Buffer.from('substituted', 'utf8'), expected, code)).toThrow(code);
    }
  });

  it('selects exactly one supported Docker archive config layout', () => {
    const configDigest = digest('7');
    const configSha = configDigest.slice('sha256:'.length);
    expect(selectDockerArchiveConfigPath([`${configSha}.json`], configDigest)).toBe(
      `${configSha}.json`,
    );
    expect(selectDockerArchiveConfigPath([`blobs/sha256/${configSha}`], configDigest)).toBe(
      `blobs/sha256/${configSha}`,
    );
    expect(() => selectDockerArchiveConfigPath(['manifest.json'], configDigest)).toThrow(
      'COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_ARCHIVE_PATH_INVALID',
    );
    expect(() =>
      selectDockerArchiveConfigPath(
        [`${configSha}.json`, `blobs/sha256/${configSha}`],
        configDigest,
      ),
    ).toThrow('COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_ARCHIVE_PATH_INVALID');
    expect(() =>
      selectDockerArchiveConfigPath([`../blobs/sha256/${configSha}`], configDigest),
    ).toThrow('COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_ARCHIVE_PATH_INVALID');
  });

  it('documents build, root installation and rehearsal as separate authority gates', async () => {
    const runbook = await readFile(
      new URL('../docs/runbooks/communities-chain-integration.md', import.meta.url),
      'utf8',
    );

    expect(runbook).toContain('BUILD_COMMUNITIES_REHEARSAL_MIGRATOR');
    expect(runbook).toMatch(/does not authorize\s+installing the candidate file/u);
    expect(runbook).toContain('root:phub-deploy` mode `0440`');
    expect(runbook).toContain('does not authorize the staged rehearsal');
  });
});
