import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const approvedSourceSha = '595e954bb8f53367baf034d7f39b255af0fda5fd';
const approvedSourceTree = '3f4c1e63dd30eb60251533b95f1970fd96754a08';
const supersededSourceSha = '35c8312b79cccdd136f2bfd892efbea629b8b919';
const releaseManifestProducer = fileURLToPath(
  new URL('./build-timeweb-release-manifest.js', import.meta.url),
);
const releaseManifestValidator = fileURLToPath(
  new URL('./verify-timeweb-release-manifest.js', import.meta.url),
);
const publicationEvidenceValidator = fileURLToPath(
  new URL('./verify-timeweb-publication-evidence-checksums.js', import.meta.url),
);

interface BlobFetchRequestObservation {
  readonly authorization: string | null;
  readonly cookie: string | null;
  readonly hasExpiryQuery: boolean;
  readonly hasSignatureQuery: boolean;
  readonly path: string;
  readonly server: 'blob' | 'registry';
}

interface BlobFetchScenarioResult {
  readonly bytesMatch: boolean;
  readonly destinationExists: boolean;
  readonly leakedSignature: boolean;
  readonly leakedToken: boolean;
  readonly markers: readonly string[];
  readonly requests: readonly BlobFetchRequestObservation[];
  readonly status: number | null;
}

interface ProducedReleaseManifest {
  readonly gitCommit: string;
  readonly gitTree: string;
  readonly images: readonly { readonly digest: string }[];
  readonly publication: {
    readonly runAttempt: string;
    readonly runId: string;
    readonly workflowSha: string;
  };
}

describe('Timeweb amd64 publication workflow', () => {
  let blobFetchResults: Record<
    string,
    BlobFetchScenarioResult | readonly BlobFetchScenarioResult[]
  >;

  beforeAll(() => {
    const fixture = fileURLToPath(
      new URL('./timeweb-amd64-blob-fetch.fixture.ts', import.meta.url),
    );
    const helper = fileURLToPath(
      new URL('./timeweb-amd64-registry-custody-retry.sh', import.meta.url),
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, helper], {
      encoding: 'utf8',
      killSignal: 'SIGTERM',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    blobFetchResults = JSON.parse(result.stdout) as typeof blobFetchResults;
  }, 35_000);

  const scenario = (name: string): BlobFetchScenarioResult => {
    const result = blobFetchResults[name];
    if (!result || Array.isArray(result)) throw new Error(`missing blob fetch scenario: ${name}`);
    return result as BlobFetchScenarioResult;
  };

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
            readonly if?: string;
            readonly needs?: string | readonly string[];
            readonly permissions?: Readonly<Record<string, string>>;
            readonly strategy?: { readonly matrix?: { readonly service?: readonly string[] } };
            readonly steps?: readonly {
              readonly 'continue-on-error'?: boolean;
              readonly id?: string;
              readonly if?: string;
              readonly name?: string;
              readonly uses?: string;
              readonly with?: Readonly<Record<string, unknown>>;
            }[];
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
    expect(document.jobs['publication-manifest']?.if).toBe(
      "${{ inputs.operation == 'publish' && needs.build-and-publish.result == 'success' && needs.publication-inventory.result == 'success' }}",
    );
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

    const publicationSteps = document.jobs['publication-manifest']?.steps ?? [];
    const evidenceDownload = publicationSteps.find(
      ({ uses }) => uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    );
    expect(evidenceDownload?.with).toEqual({
      pattern: 'timeweb-amd64-image-*-${{ github.run_id }}-${{ github.run_attempt }}',
      path: 'publication-evidence/images',
      'merge-multiple': true,
    });
    expect(evidenceDownload?.with).not.toHaveProperty('run-id');
    expect(evidenceDownload?.with).not.toHaveProperty('github-token');

    const generationIndex = publicationSteps.findIndex(
      ({ name }) => name === 'Create and validate internal and canonical publication manifests',
    );
    const canonicalIndex = publicationSteps.findIndex(({ id }) => id === 'canonical');
    const canonicalStep = publicationSteps[canonicalIndex];
    expect(generationIndex).toBeGreaterThan(-1);
    expect(canonicalIndex).toBeGreaterThan(generationIndex);
    expect(canonicalStep?.uses).toBe(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(canonicalStep?.with).toEqual({
      name: 'timeweb-amd64-canonical-release-${{ inputs.expected_source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
      path: 'release-manifest.json\nrelease-manifest.sha256\n',
      'if-no-files-found': 'error',
      'retention-days': 90,
    });
    expect(canonicalStep?.if).toBeUndefined();
    expect(canonicalStep?.['continue-on-error']).toBeUndefined();

    expect(workflow).toContain('default: source_check_only');
    expect(workflow).toContain("inputs.operation == 'publish'");
    expect(workflow).toContain('PUBLISH_TIMEWEB_AMD64_595E954');
    expect(workflow).toContain(approvedSourceSha);
    expect(workflow).toContain(approvedSourceTree);
    expect(workflow).not.toContain(supersededSourceSha);
    expect(workflow).toContain('test "$REQUEST_REF" = refs/heads/main');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$REQUEST_SHA"');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$EXPECTED_WORKFLOW_SHA"');
    expect(workflow).toContain(`APPROVED_SOURCE_SHA: ${approvedSourceSha}`);
    expect(workflow).toContain('test "$EXPECTED_SOURCE_SHA" = "$APPROVED_SOURCE_SHA"');
    expect(workflow).toContain('test "$RUN_ATTEMPT" = 1');
    expect(workflow).toContain('test "$REPOSITORY" = Z6v6e6r/lk2');
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
    expect(workflow.match(/sha256sum --check --strict/gu)).toHaveLength(5);
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
    expect(workflow).toContain('node scripts/build-timeweb-release-manifest.js');
    expect(workflow).toContain('node scripts/verify-timeweb-release-manifest.js');
    expect(workflow).toContain(
      'node scripts/verify-timeweb-publication-evidence-checksums.js publication-evidence/images',
    );
    expect(workflow).toContain(
      'name: timeweb-amd64-canonical-release-${{ inputs.expected_source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(workflow).toContain('release-manifest.json\n            release-manifest.sha256');
    expect(workflow).not.toContain('prior_reconciliation_run_id');
    expect(workflow.indexOf('node scripts/build-timeweb-release-manifest.js')).toBeLessThan(
      workflow.indexOf('node scripts/verify-timeweb-release-manifest.js'),
    );
    expect(
      workflow.indexOf('node scripts/verify-timeweb-publication-evidence-checksums.js'),
    ).toBeLessThan(workflow.indexOf('node scripts/build-timeweb-release-manifest.js'));
    expect(workflow.indexOf('node scripts/verify-timeweb-release-manifest.js')).toBeLessThan(
      workflow.indexOf('name: Preserve same-run canonical publication evidence'),
    );
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

  it('binds request, publication, reconciliation and release manifests to one approved source', async () => {
    const publicationWorkflow = await readFile(
      new URL('../.github/workflows/publish-timeweb-amd64-images.yaml', import.meta.url),
      'utf8',
    );
    const reconciliationWorkflow = await readFile(
      new URL('../.github/workflows/reconcile-timeweb-amd64-publication.yaml', import.meta.url),
      'utf8',
    );
    const publicationDocument = parse(publicationWorkflow) as {
      readonly jobs: Readonly<
        Record<
          string,
          {
            readonly steps?: readonly {
              readonly env?: Readonly<Record<string, string>>;
              readonly name?: string;
              readonly run?: string;
            }[];
          }
        >
      >;
    };
    const validationStep = publicationDocument.jobs['validate-request']?.steps?.find(
      ({ name }) => name === 'Validate exact first-attempt main request',
    );
    expect(validationStep?.env?.APPROVED_SOURCE_SHA).toBe(approvedSourceSha);
    const validationScript = validationStep?.run;
    expect(validationScript).toBeDefined();
    if (!validationScript) throw new Error('publication request validator was not found');
    const requestEnvironment = {
      ACTOR: 'release-actor',
      APPROVED_SOURCE_SHA: approvedSourceSha,
      CONFIRMATION: '',
      EXPECTED_SOURCE_SHA: approvedSourceSha,
      EXPECTED_WORKFLOW_SHA: 'f'.repeat(40),
      OPERATION: 'source_check_only',
      REPOSITORY: 'Z6v6e6r/lk2',
      REQUEST_REF: 'refs/heads/main',
      REQUEST_SHA: 'f'.repeat(40),
      RUN_ATTEMPT: '1',
      TRIGGERING_ACTOR: 'release-actor',
      WORKFLOW_SHA: 'f'.repeat(40),
    };
    const validateRequest = (expectedSourceSha: string) =>
      spawnSync('bash', ['-c', validationScript], {
        encoding: 'utf8',
        env: { ...process.env, ...requestEnvironment, EXPECTED_SOURCE_SHA: expectedSourceSha },
      });
    expect(validateRequest(approvedSourceSha).status).toBe(0);
    expect(validateRequest(supersededSourceSha).status).not.toBe(0);

    const extractProgram = (workflow: string, prefix: string, suffix: string): string => {
      const start = workflow.indexOf(prefix);
      const end = workflow.indexOf(suffix, start + prefix.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return workflow.slice(start + prefix.length, end);
    };
    const runJq = (program: string, input: unknown, args: readonly string[]) =>
      spawnSync('jq', ['-e', ...args, program], {
        encoding: 'utf8',
        input: JSON.stringify(input),
      });
    const services = ['api', 'migrator', 'realtime', 'web', 'worker'] as const;
    const digest = `sha256:${'a'.repeat(64)}`;
    const publicationImages = services.map((service) => ({
      indexDigest: digest,
      platform: 'linux/amd64',
      provenance: 'slsa-v1-max',
      publicationTag: `amd64-sha-${approvedSourceSha}-101-1`,
      repository: `ghcr.io/z6v6e6r/phub-${service}`,
      runAttempt: '1',
      runId: '101',
      runtimeDigest: digest,
      sbom: 'spdx',
      service,
      sourceSha: approvedSourceSha,
      sourceTree: approvedSourceTree,
      workflowSha: 'f'.repeat(40),
    }));
    const publicationManifest = {
      authorizesDatabaseMutation: false,
      authorizesDeploy: false,
      authorizesVpsProvisioning: false,
      images: publicationImages,
      kind: 'phub-timeweb-amd64-publication',
      platform: 'linux/amd64',
      repository: 'Z6v6e6r/lk2',
      runAttempt: '1',
      runId: '101',
      schemaVersion: 1,
      sourceSha: approvedSourceSha,
      sourceTree: approvedSourceTree,
      workflowSha: 'f'.repeat(40),
    };
    const publicationProgram = extractProgram(
      publicationWorkflow,
      'jq -e --arg sourceSha "$SOURCE_SHA" --arg sourceTree "$source_tree" --arg workflowSha "$WORKFLOW_SHA" --arg runId "$GITHUB_RUN_ID" --arg runAttempt "$GITHUB_RUN_ATTEMPT" \'\n',
      "\n          ' timeweb-amd64-publication-manifest.json >/dev/null",
    );
    const publicationArguments = [
      '--arg',
      'sourceSha',
      approvedSourceSha,
      '--arg',
      'sourceTree',
      approvedSourceTree,
      '--arg',
      'workflowSha',
      'f'.repeat(40),
      '--arg',
      'runId',
      '101',
      '--arg',
      'runAttempt',
      '1',
    ];
    expect(runJq(publicationProgram, publicationManifest, publicationArguments).status).toBe(0);
    expect(
      runJq(
        publicationProgram,
        { ...publicationManifest, sourceSha: supersededSourceSha },
        publicationArguments,
      ).status,
    ).not.toBe(0);
    expect(
      runJq(
        publicationProgram,
        {
          ...publicationManifest,
          images: publicationImages.map((image, index) =>
            index === 0 ? { ...image, sourceSha: supersededSourceSha } : image,
          ),
        },
        publicationArguments,
      ).status,
    ).not.toBe(0);
    expect(
      runJq(
        publicationProgram,
        {
          ...publicationManifest,
          images: publicationImages.map((image, index) =>
            index === 0 ? { ...image, indexDigest: '' } : image,
          ),
        },
        publicationArguments,
      ).status,
    ).not.toBe(0);

    const reconciliationImages = publicationImages.map((image) => ({
      architecture: 'amd64',
      indexDigest: image.indexDigest,
      provenanceVerified: true,
      reconciliationVerified: true,
      repository: image.repository,
      runtimeDigest: image.runtimeDigest,
      sbomVerified: true,
      service: image.service,
      sourceSha: image.sourceSha,
      sourceTree: image.sourceTree,
      verified: true,
    }));

    const reconciliationProgram = extractProgram(
      reconciliationWorkflow,
      'jq -e --arg sourceSha "$EXPECTED_SOURCE_SHA" \'\n',
      "\n          ' timeweb-amd64-publication-reconciliation-manifest.json >/dev/null",
    );
    const reconciliationManifest = {
      authorizesDatabaseMutation: false,
      authorizesDeploy: false,
      authorizesVpsProvisioning: false,
      images: reconciliationImages,
    };
    expect(
      runJq(reconciliationProgram, reconciliationManifest, [
        '--arg',
        'sourceSha',
        approvedSourceSha,
      ]).status,
    ).toBe(0);
    expect(
      runJq(
        reconciliationProgram,
        {
          ...reconciliationManifest,
          images: reconciliationImages.map((image, index) =>
            index === 0 ? { ...image, sourceSha: supersededSourceSha } : image,
          ),
        },
        ['--arg', 'sourceSha', approvedSourceSha],
      ).status,
    ).not.toBe(0);
    expect(
      runJq(
        reconciliationProgram,
        {
          ...reconciliationManifest,
          images: reconciliationImages.map((image, index) =>
            index === 0 ? { ...image, provenanceVerified: false } : image,
          ),
        },
        ['--arg', 'sourceSha', approvedSourceSha],
      ).status,
    ).not.toBe(0);

    const producerInput = publicationManifest;
    const produce = async (input: unknown) => {
      const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-source-binding-'));
      const inputPath = join(directory, 'timeweb-amd64-publication-manifest.json');
      const manifestPath = join(directory, 'release-manifest.json');
      const checksumPath = join(directory, 'release-manifest.sha256');
      try {
        await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
        const result = spawnSync(
          process.execPath,
          [releaseManifestProducer, inputPath, manifestPath, checksumPath],
          { encoding: 'utf8' },
        );
        const validation =
          result.status === 0
            ? spawnSync(
                process.execPath,
                [
                  releaseManifestValidator,
                  manifestPath,
                  '--expected-publication-workflow-sha',
                  'f'.repeat(40),
                  '--expected-publication-run-id',
                  '101',
                  '--expected-publication-run-attempt',
                  '1',
                ],
                {
                  encoding: 'utf8',
                },
              )
            : undefined;
        const manifest =
          result.status === 0
            ? (JSON.parse(await readFile(manifestPath, 'utf8')) as ProducedReleaseManifest)
            : undefined;
        return { manifest, result, validation };
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    };
    const produced = await produce(producerInput);
    expect(produced.result.status, produced.result.stderr).toBe(0);
    expect(produced.validation?.status, produced.validation?.stderr).toBe(0);
    expect(produced.manifest).toBeDefined();
    if (!produced.manifest) throw new Error('canonical release manifest was not produced');
    expect(produced.manifest.gitCommit).toBe(approvedSourceSha);
    expect(produced.manifest.gitTree).toBe(approvedSourceTree);
    expect(produced.manifest.publication).toEqual({
      runAttempt: '1',
      runId: '101',
      workflow: '.github/workflows/publish-timeweb-amd64-images.yaml',
      workflowSha: 'f'.repeat(40),
    });
    expect(produced.manifest.images).toHaveLength(5);
    expect(produced.manifest.images.every((image) => image.digest === digest)).toBe(true);

    for (const sourceIdentity of [
      { sourceSha: supersededSourceSha, sourceTree: approvedSourceTree },
      { sourceSha: approvedSourceSha, sourceTree: 'b'.repeat(40) },
    ]) {
      const rejected = await produce({
        ...producerInput,
        images: publicationImages.map((image, index) =>
          index === 0 ? { ...image, ...sourceIdentity } : image,
        ),
      });
      expect(rejected.result.status).not.toBe(0);
    }
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
    const sourceSha = approvedSourceSha;
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
          readonly sbomPackages?: unknown;
          readonly sbomStatementType?: string;
          readonly buildType?: string;
          readonly sourceMaterial?: { readonly uri: string; readonly sha1: string } | null;
          readonly resolvedDependencies?: unknown;
          readonly subjectSha?: string;
        } = {},
      ) => {
        const provenancePath = join(directory, `${service}-provenance-${materials.length}.json`);
        const sbomPath = join(directory, `${service}-sbom-${materials.length}.json`);
        const subject = [{ name: service, digest: { sha256: overrides.subjectSha ?? runtimeSha } }];
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
            predicate: {
              SPDXID: 'SPDXRef-DOCUMENT',
              packages: overrides.sbomPackages ?? [{ name: service }],
            },
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
      expect((await run('api', [node, scanner], { sbomPackages: [] })).status).not.toBe(0);
      expect((await run('api', [node, scanner], { subjectSha: 'b'.repeat(64) })).status).not.toBe(
        0,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('retries only bounded transient custody reads and exposes exhaustion markers', async () => {
    const helper = fileURLToPath(
      new URL('./timeweb-amd64-registry-custody-retry.sh', import.meta.url),
    );
    const succeedAfterTwoFailures = spawnSync(
      'bash',
      [
        '-c',
        `source "${helper}"; count=0; transient() { count=$((count + 1)); test "$count" -ge 3; }; PHUB_GHCR_CUSTODY_MAX_ATTEMPTS=5 PHUB_GHCR_CUSTODY_INITIAL_DELAY_SECONDS=0 phub_ghcr_custody_retry exact-index transient`,
      ],
      { encoding: 'utf8' },
    );
    expect(succeedAfterTwoFailures.status, succeedAfterTwoFailures.stderr).toBe(0);
    expect(succeedAfterTwoFailures.stderr).toContain(
      'PHUB_GHCR_CUSTODY_RETRY|stage=exact-index|attempt=1',
    );
    expect(succeedAfterTwoFailures.stderr).toContain(
      'PHUB_GHCR_CUSTODY_PASSED|stage=exact-index|attempt=3',
    );

    const exhausted = spawnSync(
      'bash',
      [
        '-c',
        `source "${helper}"; always_fail() { return 1; }; PHUB_GHCR_CUSTODY_MAX_ATTEMPTS=3 PHUB_GHCR_CUSTODY_INITIAL_DELAY_SECONDS=0 phub_ghcr_custody_retry exact-attestation always_fail`,
      ],
      { encoding: 'utf8' },
    );
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toContain(
      '::error::PHUB_GHCR_CUSTODY_EXHAUSTED|stage=exact-attestation|attempt=3|maxAttempts=3',
    );

    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-exact-digest-'));
    const accepted = join(directory, 'accepted.json');
    const rejected = join(directory, 'rejected.json');
    try {
      const matching = spawnSync(
        'bash',
        [
          '-c',
          `source "${helper}"; docker() { printf '{}'; }; phub_ghcr_custody_read_exact_json ghcr.io/example@sha256:test sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a "${accepted}"`,
        ],
        { encoding: 'utf8' },
      );
      expect(matching.status, matching.stderr).toBe(0);
      expect(await readFile(accepted, 'utf8')).toBe('{}');

      const mismatching = spawnSync(
        'bash',
        [
          '-c',
          `source "${helper}"; docker() { printf '{}'; }; phub_ghcr_custody_read_exact_json ghcr.io/example@sha256:test sha256:${'0'.repeat(64)} "${rejected}"`,
        ],
        { encoding: 'utf8' },
      );
      expect(mismatching.status).not.toBe(0);
      expect(mismatching.stderr).toContain('PHUB_GHCR_CUSTODY_WRONG_DIGEST');
      await expect(readFile(rejected, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects tampered, path-substituted, or unreferenced downloaded publication evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-publication-evidence-'));
    const imagesDirectory = join(directory, 'images');
    await mkdir(imagesDirectory);
    const components = ['web', 'api', 'worker', 'realtime', 'migrator'];
    const originals = new Map<string, string>();
    try {
      for (const component of components) {
        const lines: string[] = [];
        for (const suffix of ['image.json', 'provenance.json', 'sbom.spdx.json']) {
          const name = `${component}-${suffix}`;
          const contents = `${component}:${suffix}\n`;
          originals.set(name, contents);
          await writeFile(join(imagesDirectory, name), contents);
          const digest = createHash('sha256').update(contents).digest('hex');
          lines.push(`${digest}  publication-evidence/${name}`);
        }
        await writeFile(
          join(imagesDirectory, `${component}-evidence-checksums.txt`),
          `${lines.join('\n')}\n`,
        );
      }

      const verify = () =>
        spawnSync(process.execPath, [publicationEvidenceValidator, imagesDirectory], {
          encoding: 'utf8',
        });
      expect(verify().status).toBe(0);

      await writeFile(join(imagesDirectory, 'api-image.json'), 'tampered\n');
      expect(verify().status).not.toBe(0);
      await writeFile(join(imagesDirectory, 'api-image.json'), originals.get('api-image.json')!);

      const apiSidecar = join(imagesDirectory, 'api-evidence-checksums.txt');
      const validSidecar = await readFile(apiSidecar, 'utf8');
      await writeFile(
        apiSidecar,
        validSidecar.replace(
          'publication-evidence/api-image.json',
          'publication-evidence/api-shadow/../api-image.json',
        ),
      );
      expect(verify().status).not.toBe(0);
      await writeFile(apiSidecar, validSidecar);

      await writeFile(join(imagesDirectory, 'web-unreferenced.json'), '{}\n');
      expect(verify().status).not.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('keeps reconciliation manual, read-only, hard-pinned and non-authorizing', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/reconcile-timeweb-amd64-publication.yaml', import.meta.url),
      'utf8',
    );
    const document = parse(workflow) as {
      readonly on: Readonly<Record<string, unknown>>;
      readonly permissions: Readonly<Record<string, string>>;
      readonly jobs: Readonly<
        Record<
          string,
          {
            readonly if?: string;
            readonly needs?: string | readonly string[];
            readonly permissions?: Readonly<Record<string, string>>;
            readonly strategy?: {
              readonly matrix?: {
                readonly include?: readonly { readonly service?: string }[];
              };
            };
            readonly steps?: readonly { readonly uses?: string }[];
          }
        >
      >;
    };

    expect(Object.keys(document.on)).toEqual(['workflow_dispatch']);
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(document.jobs['validate-request']?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(document.jobs['reconcile-custody']?.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
    expect(
      document.jobs['reconcile-custody']?.strategy?.matrix?.include?.map(({ service }) => service),
    ).toEqual(['api', 'worker', 'realtime', 'migrator', 'web']);
    expect(document.jobs['reconciliation-manifest']?.needs).toEqual([
      'validate-request',
      'reconcile-custody',
    ]);
    expect(document.jobs['reconciliation-manifest']?.if).toBe(
      "${{ needs.reconcile-custody.result == 'success' }}",
    );
    expect(workflow).toContain('RECONCILE_TIMEWEB_AMD64_PUBLICATION');
    expect(workflow).toContain('test "$RUN_ATTEMPT" = 1');
    expect(workflow).toContain('test "$ACTOR" = "$TRIGGERING_ACTOR"');
    expect(workflow).toContain('test "$WORKFLOW_SHA" = "$EXPECTED_WORKFLOW_SHA"');
    expect(workflow).toContain('expected_source_sha:');
    expect(workflow).toContain(`APPROVED_SOURCE_SHA: ${approvedSourceSha}`);
    expect(workflow).toContain('test "$EXPECTED_SOURCE_SHA" = "$APPROVED_SOURCE_SHA"');
    expect(workflow).toContain('source_sha="$EXPECTED_SOURCE_SHA"');
    expect(workflow).toContain(`source_tree=${approvedSourceTree}`);
    expect(workflow).not.toContain(supersededSourceSha);
    expect(workflow).toContain("printf '%s' \"$PUBLICATION_RUN_ID\" | grep -Eq '^[1-9][0-9]*$'");
    expect(workflow).toContain('publication_workflow_sha:');
    expect(workflow).not.toContain('prior_reconciliation_run_id:');
    expect(workflow).toContain('.path == ".github/workflows/publish-timeweb-amd64-images.yaml"');
    expect(workflow).toContain('.head_sha == $workflowSha');
    expect(workflow).toContain('.conclusion == "success"');
    expect(workflow).toContain('amd64-sha-$source_sha-$PUBLICATION_RUN_ID-1');
    expect(workflow).toContain(
      'https://github.com/Z6v6e6r/lk2/actions/runs/$PUBLICATION_RUN_ID/attempts/1',
    );
    for (const service of ['web', 'api', 'worker', 'realtime', 'migrator']) {
      expect(workflow).toContain(`${service}_index_digest:`);
      expect(workflow).toContain(
        `index_digest: \${{ needs.validate-request.outputs.${service}_index_digest }}`,
      );
      expect(workflow).not.toContain(`inputs.${service}_index_digest`);
    }
    expect(workflow).toContain(
      'name: timeweb-amd64-publication-${{ inputs.publication_run_id }}-1',
    );
    expect(workflow).toContain(
      'sha256sum --check --strict timeweb-amd64-publication-checksums.txt',
    );
    expect(workflow).toContain('Bind reconciliation inputs to the immutable publication artifact');
    expect(workflow).toContain('phub_ghcr_custody_read_exact_json');
    expect(workflow.match(/sha256sum --check --strict/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain(
      'github.com/docker/buildx v0.36.1 1d8dde89b8aba914e05e45366770736fea1fd690',
    );
    expect(workflow).toContain('test "$attestation_count" -ge 1');
    expect(workflow).toContain('tr -d \' \')" -eq "$attestation_count"');
    expect(workflow).toContain(
      'artifactType == "application/vnd.docker.attestation.manifest.v1+json"',
    );
    expect(workflow).toContain('($p.buildDefinition.resolvedDependencies | type == "array")');
    expect(workflow).toContain('docker image inspect "$runtime_reference" --format \'{{.Id}}\'');
    expect(workflow).toContain('http://127.0.0.1:$port/healthz');
    expect(workflow).toContain('--slurpfile provenance reconciliation-evidence/provenance.json');
    expect(workflow).toContain('--slurpfile sbom reconciliation-evidence/sbom.spdx.json');
    expect(workflow).not.toContain('merge-multiple: true');
    expect(workflow).toContain('find reconciliation-evidence/images -name image.json | wc -l');
    expect(workflow).toContain('reconciliation-evidence/images/*/image.json');
    expect(workflow).toContain(
      '([.images[].service] | sort) == ["api","migrator","realtime","web","worker"]',
    );
    expect(workflow).toContain('([.images[].provenanceVerified] | all)');
    expect(workflow).toContain('([.images[].sbomVerified] | all)');
    expect(workflow).toContain('([.images[].reconciliationVerified] | all)');
    expect(workflow).toContain('([.images[].architecture] | unique) == ["amd64"]');
    expect(workflow).toContain('authorizesDeploy:false');
    expect(workflow).toContain('authorizesVpsProvisioning:false');
    expect(workflow).toContain('authorizesDatabaseMutation:false');
    expect(workflow).toContain('reconciliationWorkflowSha:$reconciliationWorkflowSha');
    expect(workflow).not.toContain('PRIOR_RECONCILIATION_RUN_ID');
    expect(workflow).not.toContain('prior-reconciliation');
    expect(workflow).toContain('ref: ${{ inputs.expected_workflow_sha }}');
    expect(workflow).not.toContain('node scripts/build-timeweb-release-manifest.js');
    expect(workflow).not.toContain('node scripts/verify-timeweb-release-manifest.js');
    expect(workflow).not.toContain('release-manifest.sha256');
    expect(workflow).not.toContain('verified:true');
    expect(workflow).not.toContain('images: (.images | map({key: .service');
    expect(workflow).not.toContain(
      'verification: {provenance: true, sbom: true, reconciliation: true}',
    );
    expect(workflow).not.toMatch(
      /packages:\s*write|push:\s*true|docker\s+push|docker buildx build|docker\/build-push-action@|docker compose|npm run db:migrate|deploy-(?:staging|production)|\b(?:ssh|scp|tailscale)\b/iu,
    );
    const uses = Object.values(document.jobs).flatMap(
      (job) => job.steps?.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
  });

  it('uses the same shared bounded HTTPS-only fetch contract for attestation blobs', async () => {
    const workflows = await Promise.all(
      [
        '../.github/workflows/publish-timeweb-amd64-images.yaml',
        '../.github/workflows/reconcile-timeweb-amd64-publication.yaml',
      ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
    );

    for (const workflow of workflows) {
      expect(workflow).toContain('phub_ghcr_custody_fetch_exact_statement_blob');
      expect(workflow).toContain('statement_size statement_media_type');
      expect(workflow).not.toContain('download_attestation_statement()');
      expect(workflow).not.toContain('download_statement()');
    }
    const helper = await readFile(
      new URL('./timeweb-amd64-registry-custody-retry.sh', import.meta.url),
      'utf8',
    );
    expect(helper).toContain("--proto '=https' --proto-redir '=https' --tlsv1.2");
    expect(helper).toContain('curl --disable --fail');
    expect(helper).toContain('--max-redirs "$maximum_redirects"');
    expect(helper).toContain('--connect-timeout "$connect_timeout_seconds"');
    expect(helper).toContain('--max-time "$maximum_time_seconds"');
    expect(helper).toContain('--speed-time "$low_speed_time_seconds"');
    expect(helper).toContain('--speed-limit "$low_speed_limit_bytes"');
    expect(helper).toContain('--max-filesize "$expected_size"');
    expect(helper).toContain('--remove-on-error');
    expect(helper).not.toContain('--location-trusted');
  });

  it('accepts a direct response, one relative redirect and three redirects at the limit', () => {
    for (const name of ['direct', 'one-relative-redirect', 'three-redirects']) {
      expect(scenario(name)).toMatchObject({
        bytesMatch: true,
        destinationExists: true,
        leakedSignature: false,
        leakedToken: false,
        status: 0,
      });
    }
    expect(scenario('one-relative-redirect').requests.at(-1)).toMatchObject({
      hasExpiryQuery: true,
      hasSignatureQuery: true,
    });
  });

  it('rejects a redirect loop, a fourth redirect, and missing or invalid Location', () => {
    for (const name of [
      'redirect-loop',
      'too-many-redirects',
      'missing-location',
      'invalid-location',
    ]) {
      expect(scenario(name).status).not.toBe(0);
      expect(scenario(name).destinationExists).toBe(false);
    }
  });

  it('rejects HTTPS downgrade and strips credentials on a cross-origin signed redirect', () => {
    expect(scenario('https-downgrade').status).not.toBe(0);
    const crossOrigin = scenario('cross-origin-signed');
    expect(crossOrigin.status).toBe(0);
    expect(crossOrigin.requests).toHaveLength(2);
    expect(crossOrigin.requests[0]).toMatchObject({
      authorization: 'Bearer fixture-registry-token',
      server: 'registry',
    });
    expect(crossOrigin.requests[1]).toMatchObject({
      authorization: null,
      cookie: null,
      hasExpiryQuery: true,
      hasSignatureQuery: true,
      server: 'blob',
    });
  });

  it('fails closed for 401, 403, 404, 429 and 5xx responses', () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const result = scenario(`status-${status}`);
      expect(result.status).not.toBe(0);
      expect(result.destinationExists).toBe(false);
      expect(result.markers).toContain('PHUB_GHCR_CUSTODY_BLOB_FETCH_FAILED');
    }
  });

  it('fails closed on connection reset and timeout', () => {
    for (const name of ['reset', 'timeout', 'slow-body', 'oversized']) {
      expect(scenario(name).status).not.toBe(0);
      expect(scenario(name).destinationExists).toBe(false);
      expect(scenario(name).markers).toContain('PHUB_GHCR_CUSTODY_BLOB_FETCH_FAILED');
    }
  });

  it('rejects empty, HTML, invalid JSON and digest-mismatched bodies', () => {
    expect(scenario('empty').markers).toContain('PHUB_GHCR_CUSTODY_EMPTY_BLOB');
    expect(scenario('html').markers).toContain('PHUB_GHCR_CUSTODY_UNEXPECTED_BLOB_MEDIA_TYPE');
    expect(scenario('invalid-json').markers).toContain('PHUB_GHCR_CUSTODY_INVALID_BLOB_JSON');
    expect(scenario('digest-mismatch').markers).toContain('PHUB_GHCR_CUSTODY_WRONG_BLOB_DIGEST');
    for (const name of ['empty', 'html', 'invalid-json', 'digest-mismatch']) {
      expect(scenario(name).status).not.toBe(0);
      expect(scenario(name).destinationExists).toBe(false);
    }
  });

  it('is repeatable and never logs the registry token or signed query value', () => {
    const repeated = blobFetchResults.repeated;
    expect(Array.isArray(repeated)).toBe(true);
    if (!Array.isArray(repeated)) throw new Error('repeated result is missing');
    const repeatedResults = repeated as readonly BlobFetchScenarioResult[];
    expect(repeatedResults).toHaveLength(2);
    expect(repeatedResults.every((result) => result.status === 0 && result.bytesMatch)).toBe(true);
    const allResults: BlobFetchScenarioResult[] = [];
    for (const value of Object.values(blobFetchResults)) {
      if (Array.isArray(value)) {
        allResults.push(...(value as readonly BlobFetchScenarioResult[]));
      } else {
        allResults.push(value as BlobFetchScenarioResult);
      }
    }
    for (const result of allResults) {
      expect(result.leakedToken).toBe(false);
      expect(result.leakedSignature).toBe(false);
    }
  });

  it('accepts only correctly typed statements bound to the reconciled runtime digest', () => {
    const runtime = 'a'.repeat(64);
    const validateStatements = (statements: readonly unknown[]) =>
      spawnSync(
        'jq',
        [
          '-e',
          '--arg',
          'runtime',
          runtime,
          'length == 2 and ([.[].predicateType] | sort) == ["https://slsa.dev/provenance/v1", "https://spdx.dev/Document"] and all(.[]; ._type == "https://in-toto.io/Statement/v1" and (.subject | length) == 1 and .subject[0].digest == {"sha256": $runtime})',
        ],
        { encoding: 'utf8', input: JSON.stringify(statements) },
      );
    const statement = (predicateType: string) => ({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType,
      subject: [{ digest: { sha256: runtime }, name: 'pkg:docker/phub' }],
    });
    const valid = [
      statement('https://slsa.dev/provenance/v1'),
      statement('https://spdx.dev/Document'),
    ];

    expect(validateStatements(valid).status).toBe(0);
    expect(validateStatements([]).status).not.toBe(0);
    expect(validateStatements([valid[0]]).status).not.toBe(0);
    expect(validateStatements([valid[0], valid[0]]).status).not.toBe(0);
    expect(
      validateStatements([{ ...valid[0], _type: 'https://example.invalid/Statement' }, valid[1]])
        .status,
    ).not.toBe(0);
    expect(
      validateStatements([
        { ...valid[0], subject: [{ digest: { sha256: 'b'.repeat(64) } }] },
        valid[1],
      ]).status,
    ).not.toBe(0);
  });

  it('bounds the full PR coverage gate and emits signal-driven hanging handle evidence', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/pull-request.yaml', import.meta.url),
      'utf8',
    );
    const diagnosticsRunner = await readFile(
      new URL('./run-ci-tests-with-diagnostics.sh', import.meta.url),
      'utf8',
    );
    const document = parse(workflow) as {
      readonly concurrency?: { readonly group?: string };
      readonly on?: Readonly<Record<string, unknown>>;
      readonly jobs?: {
        readonly quality?: {
          readonly steps?: readonly {
            readonly env?: Readonly<Record<string, string>>;
            readonly if?: string;
            readonly name?: string;
            readonly run?: string;
            readonly ['timeout-minutes']?: number;
            readonly uses?: string;
            readonly with?: {
              readonly ['if-no-files-found']?: string;
              readonly path?: string;
            };
          }[];
        };
        readonly ['secret-scan']?: {
          readonly permissions?: Readonly<Record<string, string>>;
          readonly steps?: readonly {
            readonly env?: Readonly<Record<string, string>>;
            readonly if?: string;
            readonly name?: string;
            readonly run?: string;
            readonly uses?: string;
            readonly with?: {
              readonly ['if-no-files-found']?: string;
              readonly path?: string;
              readonly ['retention-days']?: number;
            };
          }[];
        };
      };
    };
    const testStep = document.jobs?.quality?.steps?.find(
      ({ name }) => name === 'Unit and integration tests',
    );
    const artifactStep = document.jobs?.quality?.steps?.find(
      ({ name }) => name === 'Upload test and coverage diagnostics',
    );
    const secretScanJob = document.jobs?.['secret-scan'];
    const secretRange = secretScanJob?.steps?.find(
      ({ name }) => name === 'Resolve the exact secret-scan range',
    );
    const secretScan = secretScanJob?.steps?.find(
      ({ name }) => name === 'Scan exact range for secrets',
    );
    const secretArtifact = secretScanJob?.steps?.find(
      ({ name }) => name === 'Upload secret-scan diagnostics',
    );

    expect(testStep).toEqual({
      name: 'Unit and integration tests',
      run: 'scripts/run-ci-tests-with-diagnostics.sh',
      'timeout-minutes': 10,
    });
    expect(artifactStep).toMatchObject({
      if: '${{ always() }}',
      name: 'Upload test and coverage diagnostics',
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        'if-no-files-found': 'error',
        path: '.ci-artifacts/test-and-coverage\ncoverage\n',
      },
    });
    expect(secretScanJob?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(document.on).toEqual({
      pull_request: null,
      push: { branches: ['main'] },
      workflow_dispatch: null,
    });
    expect(document.concurrency?.group).toBe(
      "pr-${{ github.event.pull_request.number || (github.event_name == 'push' && github.run_id) || github.ref }}",
    );
    expect(document.concurrency?.group).not.toContain('github.sha');
    expect(secretScanJob?.steps?.[0]?.uses).toBe(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    );
    expect(secretRange?.env).toMatchObject({
      EVENT_AFTER_SHA: '${{ github.event.after }}',
      EVENT_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      EVENT_BEFORE_SHA: '${{ github.event.before }}',
      EVENT_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    });
    expect(secretRange?.run).toContain('case "$GITHUB_EVENT_NAME" in');
    expect(secretRange?.run).toContain('base_sha="$(git merge-base "$base_tip_sha" "$head_sha")"');
    expect(secretRange?.run).toContain('base_sha="$base_tip_sha"');
    expect(secretRange?.run).toContain('git rev-list --count "$base_sha..$head_sha"');
    expect(secretRange?.run).toContain('git cat-file -e "$head_sha^{commit}"');
    expect(secretScan?.if).toBeUndefined();
    expect(secretScan?.run).toContain('docker pull "$GITLEAKS_IMAGE"');
    expect(secretScan?.run).toContain(
      'octopus_merges="$(git rev-list --min-parents=3 "$BASE_SHA..$HEAD_SHA")"',
    );
    expect(secretScan?.run).toContain('if [[ -n "$octopus_merges" ]]');
    expect(secretScan?.run).toContain('git clone --bare --no-local "$PWD" "$scan_repository"');
    expect(secretScan?.run).toContain('--volume "$RUNNER_TEMP/gitleaks:/workspace"');
    expect(secretScan?.run).toContain('--source=/workspace/repository.git');
    expect(secretScan?.run).not.toContain('--volume "$PWD:/repo:ro"');
    expect(secretScan?.run).toContain('--log-opts="--diff-merges=remerge $BASE_SHA..$HEAD_SHA"');
    expect(secretScan?.run).not.toContain('--first-parent');
    expect(secretScan?.run).not.toContain('--no-merges');
    expect(secretArtifact).toMatchObject({
      if: '${{ always() }}',
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: {
        'if-no-files-found': 'error',
        path: '${{ runner.temp }}/gitleaks/results.sarif',
        'retention-days': 90,
      },
    });
    expect(workflow).toContain('test "$head_sha" = "$GITHUB_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$base_sha" "$head_sha"');
    expect(workflow).not.toContain('gitleaks/gitleaks-action@');
    expect(workflow).toContain(
      'ghcr.io/gitleaks/gitleaks@sha256:e1b35e12a8c6fa8901f060459cfb6b2fc4c484d3afbe3b029733a3bbfab07055',
    );
    expect(diagnosticsRunner).toContain('set -uo pipefail');
    expect(diagnosticsRunner).toContain('reason=watchdog_deadline signal=USR1');
    expect(diagnosticsRunner).toContain('reason=watchdog_grace_expired signal=KILL');
    expect(diagnosticsRunner).toContain('finalize "$status" "external_signal_$signal_name" true');
    expect(diagnosticsRunner).toContain('stop_helper "$watchdog_pid"');
    expect(diagnosticsRunner).toContain('stop_helper "$monitor_pid"');
    expect(diagnosticsRunner).toContain('/proc/$helper_pid/task/$helper_pid/children');
    expect(diagnosticsRunner).toContain('kill -KILL "$helper_child_pid"');
    expect(diagnosticsRunner).toContain('kill -0 -- "-$test_pgid"');
    expect(diagnosticsRunner).toContain('reason=residual_process_group_after_leader_exit');
    expect(diagnosticsRunner).toContain('residual_process_group_after_success');
    expect(diagnosticsRunner).toContain('registration_in_progress');
    expect(diagnosticsRunner).toContain('handle_pending_external_signal');
    expect(diagnosticsRunner).toContain('memory.current');
    expect(diagnosticsRunner).toContain('etime,comm --forest');
    expect(diagnosticsRunner).not.toContain('etime,args --forest');
    expect(diagnosticsRunner).toContain('--reporter=junit');
    expect(diagnosticsRunner).toContain('--reporter=./scripts/vitest-ci-diagnostics-reporter.ts');
    expect(diagnosticsRunner).toContain('exit "$test_status"');
    expect(diagnosticsRunner).not.toContain('continue-on-error');
  });

  it('resolves PR merge-base and exact push ranges while failing closed for malformed pushes', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/pull-request.yaml', import.meta.url),
      'utf8',
    );
    const document = parse(workflow) as {
      readonly jobs?: {
        readonly ['secret-scan']?: {
          readonly steps?: readonly { readonly id?: string; readonly run?: string }[];
        };
      };
    };
    const resolver = document.jobs?.['secret-scan']?.steps?.find(
      ({ id }) => id === 'secret-range',
    )?.run;
    expect(resolver).toBeTruthy();

    const directory = await mkdtemp(join(tmpdir(), 'phub-secret-range-resolver-'));
    const git = (args: readonly string[]): string => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };

    let execution = 0;
    const runResolver = async (
      overrides: Readonly<Record<string, string>>,
    ): Promise<{
      readonly outputs: Readonly<Record<string, string>>;
      readonly status: number | null;
      readonly stderr: string;
    }> => {
      const outputPath = join(directory, `github-output-${execution++}.txt`);
      const result = spawnSync('bash', ['-c', resolver ?? 'exit 99'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT_AFTER_SHA: '',
          EVENT_BASE_SHA: '',
          EVENT_BEFORE_SHA: '',
          EVENT_HEAD_SHA: '',
          GH_TOKEN: 'not-used',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_OUTPUT: outputPath,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REF_NAME: 'main',
          GITHUB_REPOSITORY: 'Z6v6e6r/lk2',
          GITHUB_REPOSITORY_OWNER: 'Z6v6e6r',
          GITHUB_SHA: '',
          ...overrides,
        },
      });
      const outputs: Record<string, string> = {};
      const output = await readFile(outputPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (output.length > 0) {
        for (const line of output.trim().split('\n')) {
          const separator = line.indexOf('=');
          outputs[line.slice(0, separator)] = line.slice(separator + 1);
        }
      }
      return { outputs, status: result.status, stderr: result.stderr };
    };

    try {
      git(['init', '--initial-branch=main']);
      git(['config', 'user.email', 'ci-range@example.invalid']);
      git(['config', 'user.name', 'CI Range Test']);
      await writeFile(join(directory, 'root.txt'), 'root\n');
      git(['add', 'root.txt']);
      git(['commit', '-m', 'root']);
      const rootSha = git(['rev-parse', 'HEAD']);

      git(['checkout', '-b', 'candidate']);
      await writeFile(join(directory, 'candidate.txt'), 'candidate\n');
      git(['add', 'candidate.txt']);
      git(['commit', '-m', 'candidate']);
      const candidateSha = git(['rev-parse', 'HEAD']);

      git(['checkout', 'main']);
      await writeFile(join(directory, 'before.txt'), 'before\n');
      git(['add', 'before.txt']);
      git(['commit', '-m', 'before']);
      const beforeSha = git(['rev-parse', 'HEAD']);
      await writeFile(join(directory, 'after.txt'), 'after\n');
      git(['add', 'after.txt']);
      git(['commit', '-m', 'after']);
      const afterSha = git(['rev-parse', 'HEAD']);

      const pullRequest = await runResolver({
        EVENT_BASE_SHA: afterSha,
        EVENT_HEAD_SHA: candidateSha,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/123/merge',
        GITHUB_REF_NAME: '123/merge',
        GITHUB_SHA: candidateSha,
      });
      expect(pullRequest.status, pullRequest.stderr).toBe(0);
      expect(pullRequest.outputs).toEqual({ base_sha: rootSha, head_sha: candidateSha });

      const fakeBin = join(directory, 'fake-bin');
      const ghMarker = join(directory, 'gh-was-called');
      await mkdir(fakeBin);
      const fakeGh = join(fakeBin, 'gh');
      await writeFile(fakeGh, '#!/bin/sh\nprintf invoked >"$GH_CALLED_FILE"\nexit 97\n');
      await chmod(fakeGh, 0o755);
      const push = await runResolver({
        EVENT_AFTER_SHA: afterSha,
        EVENT_BEFORE_SHA: beforeSha,
        GH_CALLED_FILE: ghMarker,
        GITHUB_SHA: afterSha,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      });
      expect(push.status, push.stderr).toBe(0);
      expect(push.outputs).toEqual({ base_sha: beforeSha, head_sha: afterSha });
      await expect(access(ghMarker)).rejects.toMatchObject({ code: 'ENOENT' });

      const zeroSha = '0'.repeat(40);
      const malformedPushes: readonly Readonly<Record<string, string>>[] = [
        { EVENT_BEFORE_SHA: '', GITHUB_SHA: afterSha },
        { EVENT_BEFORE_SHA: 'not-a-sha', GITHUB_SHA: afterSha },
        { EVENT_BEFORE_SHA: zeroSha, GITHUB_SHA: afterSha },
        { EVENT_AFTER_SHA: '', EVENT_BEFORE_SHA: beforeSha, GITHUB_SHA: afterSha },
        { EVENT_AFTER_SHA: 'not-a-sha', EVENT_BEFORE_SHA: beforeSha, GITHUB_SHA: afterSha },
        { EVENT_AFTER_SHA: zeroSha, EVENT_BEFORE_SHA: beforeSha, GITHUB_SHA: zeroSha },
        { EVENT_AFTER_SHA: beforeSha, EVENT_BEFORE_SHA: beforeSha, GITHUB_SHA: beforeSha },
        { EVENT_AFTER_SHA: afterSha, EVENT_BEFORE_SHA: candidateSha, GITHUB_SHA: afterSha },
        { EVENT_AFTER_SHA: afterSha, EVENT_BEFORE_SHA: beforeSha, GITHUB_SHA: beforeSha },
        {
          EVENT_AFTER_SHA: afterSha,
          EVENT_BEFORE_SHA: beforeSha,
          GITHUB_REF: 'refs/heads/not-main',
          GITHUB_SHA: afterSha,
        },
      ];
      for (const malformedPush of malformedPushes) {
        const result = await runResolver({
          EVENT_AFTER_SHA: afterSha,
          EVENT_BEFORE_SHA: beforeSha,
          GITHUB_SHA: afterSha,
          ...malformedPush,
        });
        expect(result.status).not.toBe(0);
        expect(result.outputs).toEqual({});
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('scans candidate commits and merge resolutions without replaying an updated base', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-secret-scan-graph-'));
    const git = (args: readonly string[]): string => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };

    try {
      git(['init', '--initial-branch=main']);
      git(['config', 'user.email', 'ci-graph@example.invalid']);
      git(['config', 'user.name', 'CI Graph Test']);
      await writeFile(join(directory, 'base.txt'), 'base\n');
      await writeFile(join(directory, 'conflict.txt'), 'base conflict value\n');
      git(['add', 'base.txt', 'conflict.txt']);
      git(['commit', '-m', 'base']);
      const baseSha = git(['rev-parse', 'HEAD']);

      git(['checkout', '-b', 'candidate']);
      await writeFile(join(directory, 'candidate.txt'), 'candidate commit marker\n');
      await writeFile(join(directory, 'conflict.txt'), 'candidate conflict value\n');
      git(['add', 'candidate.txt', 'conflict.txt']);
      git(['commit', '-m', 'candidate']);
      const candidateSha = git(['rev-parse', 'HEAD']);

      git(['checkout', '-b', 'candidate-side', baseSha]);
      await writeFile(join(directory, 'side.txt'), 'candidate side-branch marker\n');
      git(['add', 'side.txt']);
      git(['commit', '-m', 'candidate side branch']);
      const sideSha = git(['rev-parse', 'HEAD']);

      git(['checkout', 'candidate']);
      git(['merge', '--no-ff', 'candidate-side', '-m', 'merge candidate side branch']);

      git(['checkout', 'main']);
      await writeFile(join(directory, 'updated-base.txt'), 'updated-base-only marker\n');
      await writeFile(join(directory, 'conflict.txt'), 'updated base conflict value\n');
      git(['add', 'updated-base.txt', 'conflict.txt']);
      git(['commit', '-m', 'update base']);
      const updatedBaseSha = git(['rev-parse', 'HEAD']);

      git(['checkout', 'candidate']);
      const conflictedMerge = spawnSync('git', ['merge', '--no-ff', 'main'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(conflictedMerge.status).toBe(1);
      await writeFile(join(directory, 'conflict.txt'), 'merge-resolution-only-marker\n');
      git(['add', 'conflict.txt']);
      git(['commit', '-m', 'merge updated base with resolution']);
      const headSha = git(['rev-parse', 'HEAD']);

      const completeRange = git(['rev-list', `${updatedBaseSha}..${headSha}`]).split('\n');
      expect(completeRange).toContain(candidateSha);
      expect(completeRange).toContain(sideSha);
      expect(completeRange).not.toContain(updatedBaseSha);
      const plainPatch = git(['log', '-p', '--format=', `${updatedBaseSha}..${headSha}`]);
      const unsafeFirstParentPatch = git([
        'log',
        '-p',
        '--format=',
        '--diff-merges=first-parent',
        `${updatedBaseSha}..${headSha}`,
      ]);
      const mergeAwarePatch = git([
        'log',
        '-p',
        '--format=',
        '--diff-merges=remerge',
        `${updatedBaseSha}..${headSha}`,
      ]);
      expect(plainPatch).not.toContain('merge-resolution-only-marker');
      expect(unsafeFirstParentPatch).toContain('updated-base-only marker');
      expect(mergeAwarePatch).toContain('candidate commit marker');
      expect(mergeAwarePatch).toContain('candidate side-branch marker');
      expect(mergeAwarePatch).toContain('merge-resolution-only-marker');
      expect(mergeAwarePatch).not.toContain('updated-base-only marker');

      await writeFile(join(directory, 'octopus.txt'), 'octopus-tree-only marker\n');
      git(['add', 'octopus.txt']);
      const octopusTreeSha = git(['write-tree']);
      const octopusSha = git([
        'commit-tree',
        octopusTreeSha,
        '-p',
        candidateSha,
        '-p',
        sideSha,
        '-p',
        updatedBaseSha,
        '-m',
        'synthetic octopus merge',
      ]);
      const octopusMerges = git(['rev-list', '--min-parents=3', `${baseSha}..${octopusSha}`]).split(
        '\n',
      );
      const skippedOctopusPatch = git([
        'log',
        '-p',
        '--format=',
        '--diff-merges=remerge',
        `${baseSha}..${octopusSha}`,
      ]);
      expect(octopusMerges).toContain(octopusSha);
      expect(skippedOctopusPatch).not.toContain('octopus-tree-only marker');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
