import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Timeweb amd64 publication workflow', () => {
  it('is manual, exact-source, immutable and non-deploying', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/publish-timeweb-amd64-images.yaml', import.meta.url),
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
            readonly strategy?: { readonly matrix?: { readonly service?: readonly string[] } };
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
      'build-and-publish',
      'publication-inventory',
      'publication-manifest',
    ]);
    expect(document.jobs['verify-source']?.needs).toBe('validate-request');
    expect(document.jobs['build-and-publish']?.needs).toEqual([
      'validate-request',
      'verify-source',
    ]);
    expect(document.jobs['publication-manifest']?.needs).toEqual([
      'validate-request',
      'verify-source',
      'build-and-publish',
      'publication-inventory',
    ]);
    expect(document.jobs['build-and-publish']?.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
    expect(document.jobs['publication-inventory']?.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
    expect(document.jobs['publication-manifest']?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(document.jobs['build-and-publish']?.strategy?.matrix?.service).toEqual([
      'web',
      'api',
      'worker',
      'realtime',
      'migrator',
    ]);
    expect(document.jobs['validate-request']?.environment).toBeUndefined();
    expect(document.jobs['verify-source']?.environment).toBeUndefined();
    expect(document.jobs['build-and-publish']?.environment).toBe('timeweb-amd64-publication');
    expect(document.jobs['publication-manifest']?.environment).toBeUndefined();

    expect(workflow).toContain('default: source_check_only');
    expect(workflow).toContain("inputs.operation == 'publish'");
    expect(workflow).toContain('PUBLISH_TIMEWEB_AMD64_35C8312');
    expect(workflow).toContain('35c8312b79cccdd136f2bfd892efbea629b8b919');
    expect(workflow).toContain('a1b920b8ae4507080789c650b8c16c669e55b477');
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$REQUEST_SHA"');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$EXPECTED_WORKFLOW_SHA"');
    expect(workflow).toContain('test "$RUN_ATTEMPT" = 1');
    expect(workflow).toContain('test "$ACTOR" = "$TRIGGERING_ACTOR"');
    expect(workflow).toContain('platforms: linux/amd64');
    expect(workflow).toContain('push: true');
    expect(workflow).toContain('provenance: mode=max,version=v1');
    expect(workflow).toContain(
      'sbom: generator=docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
    );
    expect(workflow).toContain('context: https://github.com/Z6v6e6r/lk2.git#');
    expect(
      workflow.match(
        /BUILDX_SHA256: 48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778/gu,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      'BUILDKIT_IMAGE: moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8',
    );
    expect(workflow.match(/sha256sum --check --strict/gu)).toHaveLength(4);
    expect(workflow).not.toContain('docker/setup-buildx-action@');
    expect(workflow).toContain('DOCKER_BUILD_RECORD_UPLOAD: false');
    expect(workflow).toContain('PHUB_RELEASE=${{ inputs.expected_source_sha }}');
    expect(workflow).toContain('docker pull --platform linux/amd64');
    expect(workflow).toContain('Verify reviewed base-image digests before registry login');
    expect(workflow).toContain(
      'EXPECTED_NODE_INDEX_DIGEST: sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436',
    );
    expect(workflow).toContain(
      'EXPECTED_NODE_AMD64_DIGEST: sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066',
    );
    expect(workflow).toContain(
      'EXPECTED_NGINX_INDEX_DIGEST: sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10',
    );
    expect(workflow).toContain(
      'EXPECTED_NGINX_AMD64_DIGEST: sha256:62223d644fa234c3a1cc785ee14242ec47a77364226f1c811d2f669f96dc2ac8',
    );
    expect(workflow).toContain('test "$observed_index_digest" = "$expected_index_digest"');
    expect(workflow).toContain('test "$observed_amd64_digest" = "$expected_amd64_digest"');
    expect(workflow).toContain('reviewed_base("node"; "22-bookworm-slim"; $nodeIndexSha)');
    expect(workflow).toContain('reviewed_base("nginx"; "1.27-alpine"; $nginxIndexSha)');
    expect(workflow).toContain('reviewed_scanner($scannerIndexSha)');
    expect(workflow).toContain('($materials | length) == 4');
    expect(workflow).toContain('($materials | length) == 3');
    expect(workflow).toContain('pkg:docker/docker.io/library/\\($name)');
    expect(
      workflow.indexOf('Verify reviewed base-image digests before registry login'),
    ).toBeLessThan(workflow.indexOf('docker/login-action@'));
    expect(workflow.indexOf('docker/login-action@')).toBeLessThan(workflow.indexOf('push: true'));
    expect(workflow).toContain('authorizesDeploy: false');
    expect(workflow).toContain('authorizesVpsProvisioning: false');
    expect(workflow).toContain('authorizesDatabaseMutation: false');
    expect(workflow).toContain('timeweb-amd64-publication-manifest.json');
    expect(workflow).toContain('phub-timeweb-amd64-immediate-push-receipt');
    expect(workflow).toContain('phub-timeweb-amd64-registry-inventory');
    expect(workflow).toContain('$SERVICE-attestation-layer-digests.txt');
    expect(workflow).toContain('$SERVICE-attestation-layers.tsv');
    expect(
      workflow.match(
        /"https:\/\/slsa\.dev\/provenance\/v1",\n\s+"https:\/\/spdx\.dev\/Document"/gu,
      ),
    ).toHaveLength(2);
    expect(workflow).not.toContain('prepare-communities-rehearsal-migrator-evidence.ts');
    expect(workflow).toContain('scope=repository%3Az6v6e6r%2Fphub-$SERVICE%3Apull');
    expect(workflow).toContain('.subject[0].digest.sha256 == $runtimeSha');
    expect(workflow).toContain('$sbom.packages | type == "array" and length > 0');
    expect(workflow).toContain(
      "find publication-evidence -type f ! -name '*-evidence-checksums.txt'",
    );
    expect(workflow).toContain(
      "always() && inputs.operation == 'publish' && needs.validate-request.result == 'success'",
    );
    expect(workflow).not.toMatch(/^\s*tags:\s*[^\n]*:latest\s*$/imu);

    const uses = Object.values(document.jobs).flatMap(
      (job) => job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(workflow).not.toMatch(/\b(?:ssh|scp|tailscale)\b/iu);
    expect(workflow).not.toMatch(/docker compose|npm run db:migrate(?:\s|$)/u);
    expect(workflow).not.toMatch(/deploy-staging|deploy-production/u);
  });

  it('binds every registry attestation manifest to the exact runtime descriptor', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/publish-timeweb-amd64-images.yaml', import.meta.url),
      'utf8',
    );
    const match = workflow.match(
      /jq -s -e --arg runtime "\$runtime_digest" --argjson runtimeSize "\$runtime_size" '(?<program>[\s\S]*?)' publication-evidence\/"\$SERVICE"-attestation-manifests\/\*\.json/u,
    );
    const program = match?.groups?.program;
    expect(program).toBeDefined();
    if (!program) throw new Error('registry attestation manifest jq contract was not found');

    const runtime = `sha256:${'1'.repeat(64)}`;
    const runtimeSize = 1234;
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
      subject: {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: runtime,
        size: runtimeSize,
      },
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        size: 2,
        data: 'e30=',
      },
      layers: [],
    };
    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-registry-attestation-'));
    const candidatePath = join(directory, 'manifest.json');
    const evaluate = async (candidate: unknown) => {
      await writeFile(candidatePath, JSON.stringify(candidate));
      return spawnSync(
        'jq',
        [
          '-s',
          '-e',
          '--arg',
          'runtime',
          runtime,
          '--argjson',
          'runtimeSize',
          String(runtimeSize),
          program,
          candidatePath,
        ],
        { encoding: 'utf8' },
      );
    };

    try {
      expect((await evaluate(manifest)).status).toBe(0);
      expect(
        (
          await evaluate({
            ...manifest,
            subject: { ...manifest.subject, digest: `sha256:${'2'.repeat(64)}` },
          })
        ).status,
      ).not.toBe(0);
      expect(
        (await evaluate({ ...manifest, subject: { ...manifest.subject, size: runtimeSize + 1 } }))
          .status,
      ).not.toBe(0);
      expect(
        (
          await evaluate({
            ...manifest,
            subject: {
              ...manifest.subject,
              mediaType: 'application/vnd.oci.image.index.v1+json',
            },
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await evaluate({
            ...manifest,
            config: { ...manifest.config, data: 'e31=' },
          })
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects provenance with an unexpected or incomplete base-image digest set', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/publish-timeweb-amd64-images.yaml', import.meta.url),
      'utf8',
    );
    const command = workflow.indexOf('jq -s -e --arg runtimeSha');
    const programStart = workflow.indexOf('            def reviewed_base', command);
    const programEnd = workflow.indexOf(
      '\n          \' publication-evidence/"$SERVICE"-attestation-statements',
      programStart,
    );
    expect(command).toBeGreaterThan(-1);
    expect(programStart).toBeGreaterThan(command);
    expect(programEnd).toBeGreaterThan(programStart);
    const program = workflow.slice(programStart, programEnd);

    const runtimeSha = '1'.repeat(64);
    const sourceSha = '35c8312b79cccdd136f2bfd892efbea629b8b919';
    const builder = 'https://github.com/Z6v6e6r/lk2/actions/runs/123/attempts/1';
    const nodeIndexSha = 'd649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
    const nginxIndexSha = '65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10';
    const scannerIndexSha = 'ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9';
    const node = {
      uri: 'pkg:docker/node@22-bookworm-slim?platform=linux%2Famd64',
      sha256: nodeIndexSha,
    };
    const nginx = {
      uri: 'pkg:docker/nginx@1.27-alpine?platform=linux%2Famd64',
      sha256: nginxIndexSha,
    };
    const scanner = {
      uri: `pkg:docker/docker/buildkit-syft-scanner?digest=sha256:${scannerIndexSha}&platform=linux%2Famd64`,
      sha256: scannerIndexSha,
    };
    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-provenance-'));
    try {
      const run = async (
        service: string,
        materials: readonly { readonly uri: string; readonly sha256: string }[],
        overrides: {
          readonly provenanceStatementType?: string;
          readonly sbomStatementType?: string;
          readonly buildType?: string;
          readonly sourceMaterial?: { readonly uri: string; readonly sha1: string } | null;
          readonly resolvedDependencies?: unknown;
        } = {},
      ) => {
        const provenancePath = join(directory, `${service}-provenance-${materials.length}.json`);
        const sbomPath = join(directory, `${service}-sbom-${materials.length}.json`);
        const subject = [{ name: service, digest: { sha256: runtimeSha } }];
        await writeFile(
          provenancePath,
          JSON.stringify({
            _type: overrides.provenanceStatementType ?? 'https://in-toto.io/Statement/v1',
            predicateType: 'https://slsa.dev/provenance/v1',
            subject,
            predicate: {
              buildDefinition: {
                buildType:
                  overrides.buildType ??
                  'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
                externalParameters: {
                  configSource: {
                    uri: `https://github.com/Z6v6e6r/lk2.git#${sourceSha}`,
                    digest: { sha1: sourceSha },
                    path: `apps/${service}/Dockerfile`,
                  },
                  sourceSha,
                },
                resolvedDependencies: overrides.resolvedDependencies ?? [
                  ...(overrides.sourceMaterial === null
                    ? []
                    : [
                        {
                          uri:
                            overrides.sourceMaterial?.uri ??
                            `https://github.com/Z6v6e6r/lk2.git#${sourceSha}`,
                          digest: { sha1: overrides.sourceMaterial?.sha1 ?? sourceSha },
                        },
                      ]),
                  ...materials.map(({ uri, sha256 }) => ({
                    uri,
                    digest: { sha256 },
                  })),
                ],
              },
              runDetails: {
                builder: { id: builder },
                metadata: { buildkit_completeness: { resolvedDependencies: true } },
              },
            },
          }),
        );
        await writeFile(
          sbomPath,
          JSON.stringify({
            _type: overrides.sbomStatementType ?? 'https://in-toto.io/Statement/v1',
            predicateType: 'https://spdx.dev/Document',
            subject,
            predicate: { SPDXID: 'SPDXRef-DOCUMENT', packages: [{ name: service }] },
          }),
        );
        return spawnSync(
          'jq',
          [
            '-s',
            '-e',
            '--arg',
            'runtimeSha',
            runtimeSha,
            '--arg',
            'sourceSha',
            sourceSha,
            '--arg',
            'service',
            service,
            '--arg',
            'nodeIndexSha',
            nodeIndexSha,
            '--arg',
            'nginxIndexSha',
            nginxIndexSha,
            '--arg',
            'scannerIndexSha',
            scannerIndexSha,
            '--arg',
            'builder',
            builder,
            program,
            provenancePath,
            sbomPath,
          ],
          { encoding: 'utf8' },
        );
      };

      const unexpectedNode = { ...node, sha256: '0'.repeat(64) };
      const unexpectedNginx = { ...nginx, sha256: '2'.repeat(64) };
      const wrongIdentity = { ...node, uri: 'pkg:docker/other@22?platform=linux%2Famd64' };
      const api = await run('api', [node, scanner]);
      const web = await run('web', [node, nginx, scanner]);
      expect(api.status, `${api.stderr}\n${api.stdout}`).toBe(0);
      expect(web.status, `${web.stderr}\n${web.stdout}`).toBe(0);
      expect((await run('api', [unexpectedNode, scanner])).status).not.toBe(0);
      expect((await run('api', [node, unexpectedNode, scanner])).status).not.toBe(0);
      expect((await run('api', [node, node, scanner])).status).not.toBe(0);
      expect((await run('api', [wrongIdentity, scanner])).status).not.toBe(0);
      expect((await run('api', [node])).status).not.toBe(0);
      expect((await run('api', [node, scanner, scanner])).status).not.toBe(0);
      expect((await run('web', [node, scanner])).status).not.toBe(0);
      expect((await run('web', [node, nginx, unexpectedNginx, scanner])).status).not.toBe(0);
      expect((await run('web', [node, unexpectedNginx, scanner])).status).not.toBe(0);
      expect((await run('api', [node, scanner], { sourceMaterial: null })).status).not.toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            resolvedDependencies: {
              source: {
                uri: `https://github.com/Z6v6e6r/lk2.git#${sourceSha}`,
                digest: { sha1: sourceSha },
              },
              node: { uri: node.uri, digest: { sha256: node.sha256 } },
              scanner: { uri: scanner.uri, digest: { sha256: scanner.sha256 } },
            },
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            sourceMaterial: {
              uri: 'https://github.com/Z6v6e6r/lk2.git#wrong',
              sha1: sourceSha,
            },
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            provenanceStatementType: 'https://in-toto.io/Statement/v0.1',
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            sbomStatementType: 'https://in-toto.io/Statement/v0.1',
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            buildType: 'https://mobyproject.org/buildkit@v1',
          })
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
