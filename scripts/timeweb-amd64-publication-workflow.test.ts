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
    expect(workflow).toContain('sbom: true');
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
    expect(workflow).toContain('reviewed_base("node"; "22-bookworm-slim"; $nodeAmd64Sha)');
    expect(workflow).toContain('reviewed_base("nginx"; "1.27-alpine"; $nginxAmd64Sha)');
    expect(workflow).toContain('($materials | length) == 2');
    expect(workflow).toContain('($materials | length) == 1');
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
    const nodeAmd64Sha = 'a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066';
    const nginxAmd64Sha = '62223d644fa234c3a1cc785ee14242ec47a77364226f1c811d2f669f96dc2ac8';
    const node = {
      uri: 'pkg:docker/node@22-bookworm-slim?platform=linux%2Famd64',
      sha256: nodeAmd64Sha,
    };
    const nginx = {
      uri: 'pkg:docker/nginx@1.27-alpine?platform=linux%2Famd64',
      sha256: nginxAmd64Sha,
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
                externalParameters: { sourceSha },
                resolvedDependencies: materials.map(({ uri, sha256 }) => ({
                  uri,
                  digest: { sha256 },
                })),
              },
              runDetails: { builder: { id: builder } },
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
            'nodeAmd64Sha',
            nodeAmd64Sha,
            '--arg',
            'nginxAmd64Sha',
            nginxAmd64Sha,
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
      const api = await run('api', [node]);
      const web = await run('web', [node, nginx]);
      expect(api.status, `${api.stderr}\n${api.stdout}`).toBe(0);
      expect(web.status, `${web.stderr}\n${web.stdout}`).toBe(0);
      expect((await run('api', [unexpectedNode])).status).not.toBe(0);
      expect((await run('api', [node, unexpectedNode])).status).not.toBe(0);
      expect((await run('api', [node, node])).status).not.toBe(0);
      expect((await run('api', [wrongIdentity])).status).not.toBe(0);
      expect((await run('web', [node])).status).not.toBe(0);
      expect((await run('web', [node, nginx, unexpectedNginx])).status).not.toBe(0);
      expect((await run('web', [node, unexpectedNginx])).status).not.toBe(0);
      expect(
        (
          await run('api', [node], {
            provenanceStatementType: 'https://in-toto.io/Statement/v0.1',
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node], {
            sbomStatementType: 'https://in-toto.io/Statement/v0.1',
          })
        ).status,
      ).not.toBe(0);
      expect(
        (
          await run('api', [node], {
            buildType: 'https://mobyproject.org/buildkit@v1',
          })
        ).status,
      ).not.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
