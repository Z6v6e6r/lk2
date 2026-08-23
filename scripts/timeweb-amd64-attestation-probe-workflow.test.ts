import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Timeweb amd64 attestation probe workflow', () => {
  it('is manual, exact-source, read-only and non-publishing', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/probe-timeweb-amd64-attestations.yaml', import.meta.url),
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
            readonly permissions?: Readonly<Record<string, string>>;
            readonly strategy?: { readonly matrix?: { readonly service?: readonly string[] } };
            readonly steps?: readonly { readonly uses?: string }[];
          }
        >
      >;
    };

    expect(Object.keys(document.on)).toEqual(['workflow_dispatch']);
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(document.jobs)).toEqual(['validate-request', 'probe-attestations']);
    expect(document.jobs['validate-request']?.environment).toBeUndefined();
    expect(document.jobs['probe-attestations']?.environment).toBeUndefined();
    expect(document.jobs['probe-attestations']?.permissions).toEqual({ contents: 'read' });
    expect(document.jobs['probe-attestations']?.strategy?.matrix?.service).toEqual(['api', 'web']);

    expect(workflow).toContain('PROBE_TIMEWEB_AMD64_ATTESTATIONS_ONLY');
    expect(workflow).toContain('35c8312b79cccdd136f2bfd892efbea629b8b919');
    expect(workflow).toContain('a1b920b8ae4507080789c650b8c16c669e55b477');
    expect(workflow).toContain('test "$REQUEST_SHA" = "$EXPECTED_PROBE_SHA"');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$EXPECTED_PROBE_SHA"');
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('ref: ${{ inputs.expected_source_sha }}');
    expect(workflow).toContain('context: https://github.com/Z6v6e6r/lk2.git#');
    expect(workflow).toContain('file: apps/${{ matrix.service }}/Dockerfile');
    expect(workflow).toContain('platforms: linux/amd64');
    expect(workflow).toContain('push: false');
    expect(workflow).toContain(
      'type=oci,dest=${{ runner.temp }}/timeweb-${{ matrix.service }}-probe.oci.tar',
    );
    expect(workflow).toContain('provenance: mode=max,version=v1');
    expect(workflow).toContain(
      'sbom: generator=docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
    );
    expect(workflow).toContain('Statement/v1');
    expect(workflow).toContain(
      'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
    );
    expect(workflow).toContain('reviewed_base("node"; "22-bookworm-slim"; $nodeIndexSha)');
    expect(workflow).toContain('reviewed_base("nginx"; "1.27-alpine"; $nginxIndexSha)');
    expect(workflow).toContain('reviewed_scanner($scannerIndexSha)');
    expect(workflow).toContain('.subject == []');
    expect(workflow).toContain('($materials | length) == 4');
    expect(workflow).toContain('($materials | length) == 3');
    expect(workflow).toContain('reviewed_source');
    expect(workflow).toContain('authorizesPublication: false');
    expect(workflow).toContain('authorizesDeploy: false');
    expect(workflow).toContain(
      'docker buildx version > attestation-probe/evidence/buildx-version.txt',
    );
    expect(workflow).toContain('docker buildx inspect --bootstrap');
    expect(workflow).toContain(
      'BUILDX_SHA256: 48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778',
    );
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).not.toContain('docker/setup-buildx-action@');
    expect(workflow).toContain('DOCKER_BUILD_RECORD_UPLOAD: false');
    expect(workflow).toContain(
      'BUILDKIT_IMAGE: moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8',
    );
    expect(workflow).toContain('scripts/extract-verified-oci-layout.sh');
    expect(workflow).toContain('scripts/resolve-verified-oci-nested-index.sh');
    expect(workflow).toContain('attestation-probe/evidence/selected-root-descriptor.json');
    expect(workflow).toContain('attestation-probe/evidence/runtime-descriptor.json');
    expect(workflow).toContain('attestation-probe/evidence/attestation-descriptor.json');
    expect(workflow).toContain('attestation-probe/evidence/runtime-manifest.json');
    expect(workflow).toContain('rootIndexDigest: $rootIndexDigest');
    expect(workflow).toContain('nestedIndexDigest: $nestedIndexDigest');
    expect(workflow).toContain('= "$runtime_digest"');
    expect(workflow).toContain('= "$attestation_digest"');
    expect(workflow).toContain("if: ${{ always() && steps.build.outcome == 'success' }}");
    expect(workflow).toContain('Registry login: `false`');
    expect(workflow).toContain('Registry push: `false`');

    const uses = Object.values(document.jobs).flatMap(
      (job) => job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(workflow).not.toMatch(/packages:\s*write/iu);
    expect(workflow).not.toMatch(/secrets\.|ghcr\.io/iu);
    expect(workflow).not.toMatch(/docker\/login-action|docker login/iu);
    expect(workflow).not.toMatch(/push:\s*true|docker push/iu);
    expect(workflow).not.toContain('cache-to:');
    expect(workflow).not.toMatch(/\[\$provenance \| \.\. \| strings\]/u);
    expect(workflow).not.toMatch(/\b(?:ssh|scp|tailscale)\b/iu);
    expect(workflow).not.toMatch(/docker compose|npm run db:migrate(?:\s|$)/u);
    expect(workflow).not.toMatch(/deploy-staging|deploy-production/u);
  });

  it('accepts only the OCI empty config descriptor for an artifact attestation manifest', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/probe-timeweb-amd64-attestations.yaml', import.meta.url),
      'utf8',
    );
    const match = workflow.match(
      /jq -e --arg runtime "\$runtime_digest" --argjson runtimeSize "\$runtime_size" '(?<program>[\s\S]*?)' attestation-probe\/evidence\/attestation-manifest\.json/u,
    );
    const program = match?.groups?.program;
    expect(program).toBeDefined();
    if (!program) throw new Error('attestation manifest jq contract was not found');

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
      layers: [
        {
          mediaType: 'application/vnd.in-toto+json',
          digest: `sha256:${'2'.repeat(64)}`,
          size: 10,
          annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' },
        },
        {
          mediaType: 'application/vnd.in-toto+json',
          digest: `sha256:${'3'.repeat(64)}`,
          size: 20,
          annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
        },
      ],
    };
    const evaluate = (candidate: unknown) =>
      spawnSync(
        'jq',
        [
          '-e',
          '--arg',
          'runtime',
          runtime,
          '--argjson',
          'runtimeSize',
          String(runtimeSize),
          program,
        ],
        {
          input: JSON.stringify(candidate),
          encoding: 'utf8',
        },
      );

    expect(evaluate(manifest).status).toBe(0);
    expect(
      evaluate({
        ...manifest,
        subject: { ...manifest.subject, size: runtimeSize + 1 },
      }).status,
    ).not.toBe(0);
    expect(
      evaluate({
        ...manifest,
        subject: { ...manifest.subject, mediaType: 'application/vnd.oci.image.index.v1+json' },
      }).status,
    ).not.toBe(0);
    expect(
      evaluate({
        ...manifest,
        config: { ...manifest.config, mediaType: 'application/vnd.oci.image.config.v1+json' },
      }).status,
    ).not.toBe(0);
    expect(
      evaluate({
        ...manifest,
        layers: manifest.layers.map(({ annotations, digest, mediaType }) => ({
          annotations,
          digest,
          mediaType,
        })),
      }).status,
    ).not.toBe(0);
    expect(
      evaluate({
        ...manifest,
        layers: manifest.layers.map((layer) => ({ ...layer, size: 1.5 })),
      }).status,
    ).not.toBe(0);
  });

  it('rejects a statement blob whose size differs from its attestation descriptor', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/probe-timeweb-amd64-attestations.yaml', import.meta.url),
      'utf8',
    );
    const match = workflow.match(
      /jq -r '\.layers\[\][\s\S]*?\| while IFS=\$'\\t' read -r digest predicate statement_size; do[\s\S]*?\n\s+done/u,
    );
    expect(match?.[0]).toBeDefined();
    if (!match?.[0]) throw new Error('statement extraction loop was not found');

    const temporary = await mkdtemp(join(tmpdir(), 'phub-attestation-statement-test-'));
    const evidence = join(temporary, 'attestation-probe', 'evidence');
    const blobs = join(temporary, 'attestation-probe', 'layout', 'blobs', 'sha256');
    const provenance = Buffer.from('{"predicateType":"https://slsa.dev/provenance/v1"}');
    const sbom = Buffer.from('{"predicateType":"https://spdx.dev/Document"}');
    const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    const manifest = (sizeDelta: number) => ({
      layers: [
        {
          mediaType: 'application/vnd.in-toto+json',
          digest: `sha256:${sha256(provenance)}`,
          size: provenance.length + sizeDelta,
          annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' },
        },
        {
          mediaType: 'application/vnd.in-toto+json',
          digest: `sha256:${sha256(sbom)}`,
          size: sbom.length,
          annotations: { 'in-toto.io/predicate-type': 'https://spdx.dev/Document' },
        },
      ],
    });
    const run = async (sizeDelta: number) => {
      await writeFile(
        join(evidence, 'attestation-manifest.json'),
        JSON.stringify(manifest(sizeDelta)),
      );
      return spawnSync('bash', ['-euo', 'pipefail', '-c', match[0]], {
        cwd: temporary,
        encoding: 'utf8',
      });
    };

    try {
      await mkdir(evidence, { recursive: true });
      await mkdir(blobs, { recursive: true });
      await writeFile(join(blobs, sha256(provenance)), provenance);
      await writeFile(join(blobs, sha256(sbom)), sbom);
      const valid = await run(0);
      expect(valid.status, `${valid.stderr}\n${valid.stdout}`).toBe(0);
      expect((await run(1)).status).not.toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  it('accepts only storage-bound empty subjects and the exact index-digest material set', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/probe-timeweb-amd64-attestations.yaml', import.meta.url),
      'utf8',
    );
    const command = workflow.indexOf('      - name: Validate the real BuildKit output');
    const programStart = workflow.indexOf('            def reviewed_base', command);
    const programEnd = workflow.indexOf(
      "\n          ' attestation-probe/evidence/*-statement.json",
      programStart,
    );
    expect(command).toBeGreaterThan(-1);
    expect(programStart).toBeGreaterThan(command);
    expect(programEnd).toBeGreaterThan(programStart);
    const program = workflow.slice(programStart, programEnd);

    const sourceSha = '35c8312b79cccdd136f2bfd892efbea629b8b919';
    const runtimeSha = '1'.repeat(64);
    const nodeIndexSha = 'd649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
    const nginxIndexSha = '65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10';
    const scannerIndexSha = 'ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9';
    const builder = 'https://github.com/Z6v6e6r/lk2/actions/runs/123/attempts/1';
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
    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-probe-materials-'));
    try {
      const run = async (
        service: 'api' | 'web',
        materials: readonly { readonly uri: string; readonly sha256: string }[],
        options: {
          readonly subject?: readonly unknown[];
          readonly sourceMaterial?: boolean;
          readonly resolvedDependencies?: unknown;
        } = {},
      ) => {
        const subject = options.subject ?? [];
        const provenancePath = join(directory, `${service}-provenance.json`);
        const sbomPath = join(directory, `${service}-sbom.json`);
        await writeFile(
          provenancePath,
          JSON.stringify({
            _type: 'https://in-toto.io/Statement/v1',
            predicateType: 'https://slsa.dev/provenance/v1',
            subject,
            predicate: {
              buildDefinition: {
                buildType:
                  'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
                externalParameters: {
                  configSource: {
                    uri: `https://github.com/Z6v6e6r/lk2.git#${sourceSha}`,
                    digest: { sha1: sourceSha },
                    path: `apps/${service}/Dockerfile`,
                  },
                },
                resolvedDependencies: options.resolvedDependencies ?? [
                  ...(options.sourceMaterial === false
                    ? []
                    : [
                        {
                          uri: `https://github.com/Z6v6e6r/lk2.git#${sourceSha}`,
                          digest: { sha1: sourceSha },
                        },
                      ]),
                  ...materials.map(({ uri, sha256 }) => ({ uri, digest: { sha256 } })),
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
            _type: 'https://in-toto.io/Statement/v1',
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

      const validApi = await run('api', [node, scanner]);
      const validWeb = await run('web', [node, nginx, scanner]);
      expect(validApi.status, `${validApi.stderr}\n${validApi.stdout}`).toBe(0);
      expect(validWeb.status, `${validWeb.stderr}\n${validWeb.stdout}`).toBe(0);
      expect(
        (
          await run('api', [node, scanner], {
            subject: [{ digest: { sha256: runtimeSha } }],
          })
        ).status,
      ).not.toBe(0);
      expect((await run('api', [node])).status).not.toBe(0);
      expect((await run('api', [node, scanner, scanner])).status).not.toBe(0);
      expect((await run('api', [node, scanner], { sourceMaterial: false })).status).not.toBe(0);
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
          await run('api', [
            { ...node, sha256: 'a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066' },
            scanner,
          ])
        ).status,
      ).not.toBe(0);
      expect((await run('web', [node, scanner])).status).not.toBe(0);
      expect(
        (
          await run('web', [
            node,
            nginx,
            scanner,
            { uri: 'pkg:docker/extra', sha256: '4'.repeat(64) },
          ])
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
