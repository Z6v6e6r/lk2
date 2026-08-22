import { readFile } from 'node:fs/promises';

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
    expect(workflow).toContain('authorizesDeploy: false');
    expect(workflow).toContain('authorizesVpsProvisioning: false');
    expect(workflow).toContain('authorizesDatabaseMutation: false');
    expect(workflow).toContain('timeweb-amd64-publication-manifest.json');
    expect(workflow).toContain('phub-timeweb-amd64-immediate-push-receipt');
    expect(workflow).toContain('phub-timeweb-amd64-registry-inventory');
    expect(workflow).toContain('$SERVICE-attestation-layer-digests.txt');
    expect(workflow).toContain('$SERVICE-attestation-layers.tsv');
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
});
