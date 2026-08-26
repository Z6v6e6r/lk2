import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const producer = fileURLToPath(new URL('./build-timeweb-release-manifest.js', import.meta.url));
const validator = fileURLToPath(new URL('./verify-timeweb-release-manifest.js', import.meta.url));
const legacyManifestFixture = fileURLToPath(
  new URL('./fixtures/timeweb-release-manifest.v1.json', import.meta.url),
);
const legacyChecksumFixture = fileURLToPath(
  new URL('./fixtures/timeweb-release-manifest.v1.sha256', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../deploy/timeweb/release-manifest.schema.json', import.meta.url),
);
const legacySchemaPath = fileURLToPath(
  new URL('../deploy/timeweb/release-manifest.v1.schema.json', import.meta.url),
);
const lockPath = fileURLToPath(new URL('../deploy/timeweb/base-images.lock.json', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const approvedSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const approvedSourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const workflowSha = approvedSourceSha;
const runId = '111111';
const runAttempt = '1';
const components = ['web', 'api', 'worker', 'realtime', 'migrator'] as const;

type JsonRecord = Record<string, unknown>;

function publicationEvidence(): JsonRecord {
  const base = JSON.parse(
    spawnSync(
      'node',
      [
        fileURLToPath(new URL('./verify-timeweb-base-images.js', import.meta.url)),
        'static',
        '--lock',
        lockPath,
        '--repo-root',
        repositoryRoot,
        '--evidence-json',
      ],
      { encoding: 'utf8' },
    ).stdout,
  ) as JsonRecord;
  return {
    schemaVersion: 1,
    kind: 'phub-timeweb-amd64-publication',
    sourceSha: approvedSourceSha,
    sourceTree: approvedSourceTree,
    workflowSha,
    repository: 'Z6v6e6r/lk2',
    platform: 'linux/amd64',
    runId,
    runAttempt,
    authorizesDeploy: false,
    authorizesVpsProvisioning: false,
    authorizesDatabaseMutation: false,
    baseLock: base.baseLock,
    baseImages: base.baseImages,
    images: components.map((service, index) => ({
      service,
      sourceSha: approvedSourceSha,
      sourceTree: approvedSourceTree,
      workflowSha,
      repository: `ghcr.io/z6v6e6r/phub-${service}`,
      indexDigest: `sha256:${String(index + 1).repeat(64)}`,
      runtimeDigest: `sha256:${String((index + 6) % 10).repeat(64)}`,
      publicationTag: `amd64-sha-${approvedSourceSha}-${runId}-${runAttempt}`,
      platform: 'linux/amd64',
      provenance: 'slsa-v1-max',
      provenanceSubject: `sha256:${String((index + 6) % 10).repeat(64)}`,
      sbom: 'spdx',
      sbomSubject: `sha256:${String((index + 6) % 10).repeat(64)}`,
      sourceMaterialSha: approvedSourceSha,
      runId,
      runAttempt,
    })),
  };
}

function produce(evidence: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-producer-'));
  const inputPath = join(directory, 'timeweb-amd64-publication-manifest.json');
  const manifestPath = join(directory, 'release-manifest.json');
  const checksumPath = join(directory, 'release-manifest.sha256');
  writeFileSync(inputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  const result = spawnSync('node', [producer, inputPath, manifestPath, checksumPath, lockPath], {
    encoding: 'utf8',
  });
  const manifest =
    result.status === 0
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonRecord)
      : undefined;
  return { checksumPath, directory, manifest, manifestPath, result };
}

function verify(value: unknown, checksumOverride?: string, options: readonly string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-manifest-'));
  const manifestPath = join(directory, 'release-manifest.json');
  const checksumPath = join(directory, 'release-manifest.sha256');
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(manifestPath, contents);
  writeFileSync(
    checksumPath,
    checksumOverride ??
      `${createHash('sha256').update(contents).digest('hex')}  release-manifest.json\n`,
  );
  return spawnSync(
    'node',
    [validator, manifestPath, '--expected-base-lock', lockPath, ...options],
    {
      encoding: 'utf8',
    },
  );
}

function expectRejected(
  value: unknown,
  checksumOverride?: string,
  options: readonly string[] = [],
) {
  const result = verify(value, checksumOverride, options);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_FAILED');
}

describe('Timeweb canonical release manifest contract', () => {
  it('publishes an explicit V2 commit/tree contract while retaining V1 as legacy only', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonRecord;
    const legacySchema = JSON.parse(readFileSync(legacySchemaPath, 'utf8')) as JsonRecord;
    expect((schema.properties as JsonRecord).schemaVersion).toEqual({
      const: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    });
    expect((schema.properties as JsonRecord).gitCommit).toEqual({
      type: 'string',
      pattern: '^[0-9a-f]{40}$',
    });
    expect((schema.properties as JsonRecord).gitTree).toEqual({
      type: 'string',
      pattern: '^[0-9a-f]{40}$',
    });
    expect(schema.required).toContain('publication');
    expect(schema.required).toContain('baseLock');
    expect(schema.required).toContain('baseImages');
    expect(schema.required).not.toContain('reconciliationRuns');
    expect((legacySchema.properties as JsonRecord).schemaVersion).toEqual({
      const: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V1',
    });
    expect(legacySchema.required).toContain('reconciliationRuns');
  });

  it('produces and validates the same-run canonical pair without reconciliation', () => {
    const produced = produce(publicationEvidence());
    expect(produced.result.status, produced.result.stderr).toBe(0);
    expect(produced.result.stdout).toContain('TIMEWEB_RELEASE_MANIFEST_BUILT');
    expect(produced.manifest).toMatchObject({
      schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
      repository: 'Z6v6e6r/lk2',
      gitCommit: approvedSourceSha,
      gitTree: approvedSourceTree,
      platform: 'linux/amd64',
      publication: {
        workflow: '.github/workflows/publish-timeweb-amd64-images.yaml',
        workflowSha,
        runId,
        runAttempt,
      },
    });
    expect(produced.manifest).not.toHaveProperty('reconciliationRuns');
    expect(produced.manifest?.images).toHaveLength(5);

    const validated = spawnSync(
      'node',
      [
        validator,
        produced.manifestPath,
        '--expected-base-lock',
        lockPath,
        '--expected-publication-workflow-sha',
        workflowSha,
        '--expected-publication-run-id',
        runId,
        '--expected-publication-run-attempt',
        runAttempt,
      ],
      { encoding: 'utf8' },
    );
    expect(validated.status, validated.stderr).toBe(0);
    expect(validated.stdout).toContain('TIMEWEB_RELEASE_MANIFEST_PASSED');
    const sidecar = readFileSync(produced.checksumPath, 'utf8');
    expect(sidecar).toMatch(/^[a-f0-9]{64} {2}release-manifest\.json\n$/u);
  });

  it('keeps historical V1 files readable but does not accept publication expectations for them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-v1-'));
    const manifestPath = join(directory, 'release-manifest.json');
    const checksumPath = join(directory, 'release-manifest.sha256');
    writeFileSync(manifestPath, readFileSync(legacyManifestFixture));
    writeFileSync(checksumPath, readFileSync(legacyChecksumFixture));
    expect(spawnSync('node', [validator, manifestPath], { encoding: 'utf8' }).status).toBe(0);
    expect(
      spawnSync(
        'node',
        [
          validator,
          manifestPath,
          '--expected-publication-workflow-sha',
          workflowSha,
          '--expected-publication-run-id',
          runId,
          '--expected-publication-run-attempt',
          runAttempt,
        ],
        { encoding: 'utf8' },
      ).status,
    ).toBe(1);
  });

  it('resolves the application tree from Git and rejects missing, malformed, or mismatched trees', () => {
    for (const tree of [undefined, 'bad-tree', 'a'.repeat(40)]) {
      const evidence = publicationEvidence();
      if (tree === undefined) delete evidence.sourceTree;
      else evidence.sourceTree = tree;
      expect(produce(evidence).result.status).toBe(1);
    }
    const valid = produce(publicationEvidence()).manifest;
    expect(valid).toBeDefined();
    const withoutTree = structuredClone(valid!);
    delete withoutTree.gitTree;
    expectRejected(withoutTree);
    expectRejected({ ...valid, gitTree: 'a'.repeat(40) });
    expectRejected({ ...valid, gitCommit: 'a'.repeat(40) });
  });

  it('rejects altered JSON, altered sidecars, wrong filenames, and output path substitution', () => {
    const produced = produce(publicationEvidence());
    const manifest = produced.manifest;
    expect(manifest).toBeDefined();
    writeFileSync(
      produced.manifestPath,
      `${JSON.stringify({ ...manifest, platform: 'linux/arm64' }, null, 2)}\n`,
    );
    const byteTamper = spawnSync('node', [validator, produced.manifestPath], {
      encoding: 'utf8',
    });
    expect(byteTamper.status).toBe(1);
    expect(byteTamper.stderr).toContain('reason=checksum_mismatch');
    expectRejected({ ...manifest, platform: 'linux/arm64' });
    expectRejected(manifest, `${'0'.repeat(64)}  release-manifest.json\n`);
    expectRejected(manifest, `${'a'.repeat(64)}  other.json\n`);

    const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-output-path-'));
    const inputPath = join(directory, 'timeweb-amd64-publication-manifest.json');
    writeFileSync(inputPath, JSON.stringify(publicationEvidence()));
    const result = spawnSync(
      'node',
      [
        producer,
        inputPath,
        join(directory, 'other.json'),
        join(directory, 'release-manifest.sha256'),
        lockPath,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const substitutedInput = join(directory, 'substituted-publication.json');
    writeFileSync(substitutedInput, JSON.stringify(publicationEvidence()));
    expect(
      spawnSync(
        'node',
        [
          producer,
          substitutedInput,
          join(directory, 'release-manifest.json'),
          join(directory, 'release-manifest.sha256'),
          lockPath,
        ],
        { encoding: 'utf8' },
      ).status,
    ).toBe(1);
  });

  it('fails closed for missing or duplicate components and missing or mutable-only digests', () => {
    const missing = publicationEvidence();
    (missing.images as JsonRecord[]).pop();
    expect(produce(missing).result.status).toBe(1);

    const duplicate = publicationEvidence();
    const duplicateImages = duplicate.images as JsonRecord[];
    duplicateImages[4] = { ...duplicateImages[0] };
    expect(produce(duplicate).result.status).toBe(1);

    for (const field of ['indexDigest', 'runtimeDigest']) {
      const evidence = publicationEvidence();
      delete (evidence.images as JsonRecord[])[0]![field];
      expect(produce(evidence).result.status).toBe(1);
    }
    const mutable = publicationEvidence();
    (mutable.images as JsonRecord[])[0]!.indexDigest = 'ghcr.io/z6v6e6r/phub-web:latest';
    expect(produce(mutable).result.status).toBe(1);
  });

  it('rejects invalid platform and missing provenance or SBOM evidence', () => {
    const wrongPlatform = publicationEvidence();
    (wrongPlatform.images as JsonRecord[])[0]!.platform = 'linux/arm64';
    expect(produce(wrongPlatform).result.status).toBe(1);
    const missingPlatform = publicationEvidence();
    delete (missingPlatform.images as JsonRecord[])[0]!.platform;
    expect(produce(missingPlatform).result.status).toBe(1);

    for (const field of ['provenance', 'sbom']) {
      const evidence = publicationEvidence();
      delete (evidence.images as JsonRecord[])[0]![field];
      expect(produce(evidence).result.status).toBe(1);
    }
    const falseSbom = publicationEvidence();
    (falseSbom.images as JsonRecord[])[0]!.sbom = 'cyclonedx';
    expect(produce(falseSbom).result.status).toBe(1);
    const manifest = produce(publicationEvidence()).manifest;
    expect(manifest).toBeDefined();
    const images = structuredClone(manifest!.images) as JsonRecord[];
    images[0]!.provenance = false;
    expectRejected({ ...manifest, images });
  });

  it('rejects a canonical manifest bound to a different publication run identity', () => {
    const manifest = produce(publicationEvidence()).manifest;
    expect(manifest).toBeDefined();
    const expectedOptions = [
      '--expected-publication-workflow-sha',
      workflowSha,
      '--expected-publication-run-id',
      '222222',
      '--expected-publication-run-attempt',
      runAttempt,
    ];
    expectRejected(manifest, undefined, expectedOptions);
  });

  it('rejects a canonical manifest whose publication workflow SHA differs from gitCommit', () => {
    const manifest = produce(publicationEvidence()).manifest;
    expect(manifest).toBeDefined();
    expectRejected({
      ...manifest,
      publication: { ...(manifest!.publication as JsonRecord), workflowSha: '8'.repeat(40) },
    });
  });

  it('rejects wrong, missing, duplicate, or unknown base custody evidence', () => {
    const manifest = produce(publicationEvidence()).manifest;
    expect(manifest).toBeDefined();
    const baseImages = structuredClone(manifest!.baseImages) as JsonRecord[];

    expectRejected({
      ...manifest,
      baseLock: { ...(manifest!.baseLock as JsonRecord), sha256: '0'.repeat(64) },
    });
    expectRejected({ ...manifest, baseImages: baseImages.slice(1) });
    expectRejected({ ...manifest, baseImages: [baseImages[0], baseImages[0], baseImages[2]] });
    expectRejected({
      ...manifest,
      baseImages: [{ ...baseImages[0], id: 'unknown-base' }, ...baseImages.slice(1)],
    });
    expectRejected({
      ...manifest,
      baseImages: [{ ...baseImages[0], tag: 'moved-tag' }, ...baseImages.slice(1)],
    });
  });
});
