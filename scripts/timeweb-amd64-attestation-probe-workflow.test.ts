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
    expect(workflow).toContain('reviewed_base("node"; "22-bookworm-slim"; $nodeAmd64Sha)');
    expect(workflow).toContain('reviewed_base("nginx"; "1.27-alpine"; $nginxAmd64Sha)');
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
      /jq -e --arg runtime "\$runtime_digest" '(?<program>[\s\S]*?)' attestation-probe\/evidence\/attestation-manifest\.json/u,
    );
    const program = match?.groups?.program;
    expect(program).toBeDefined();
    if (!program) throw new Error('attestation manifest jq contract was not found');

    const runtime = `sha256:${'1'.repeat(64)}`;
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
      subject: { digest: runtime },
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
      spawnSync('jq', ['-e', '--arg', 'runtime', runtime, program], {
        input: JSON.stringify(candidate),
        encoding: 'utf8',
      });

    expect(evaluate(manifest).status).toBe(0);
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
});
