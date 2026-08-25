import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const producer = fileURLToPath(new URL('./build-timeweb-release-manifest.js', import.meta.url));
const validator = fileURLToPath(new URL('./verify-timeweb-release-manifest.js', import.meta.url));
const reconciliationFixture = fileURLToPath(
  new URL('./fixtures/timeweb-release-reconciliation.v1.json', import.meta.url),
);
const manifestFixture = fileURLToPath(
  new URL('./fixtures/timeweb-release-manifest.v1.json', import.meta.url),
);
const checksumFixture = fileURLToPath(
  new URL('./fixtures/timeweb-release-manifest.v1.sha256', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../deploy/timeweb/release-manifest.schema.json', import.meta.url),
);
const approvedSourceSha = '595e954bb8f53367baf034d7f39b255af0fda5fd';
const approvedSourceTree = '3f4c1e63dd30eb60251533b95f1970fd96754a08';
const supersededSourceSha = '35c8312b79cccdd136f2bfd892efbea629b8b919';

function canonicalManifest() {
  return JSON.parse(readFileSync(manifestFixture, 'utf8')) as Record<string, unknown>;
}

function verify(value: unknown, checksumOverride?: string) {
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
  return spawnSync('node', [validator, manifestPath], { encoding: 'utf8' });
}

function expectRejected(value: unknown, checksumOverride?: string) {
  const result = verify(value, checksumOverride);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_FAILED');
}

describe('Timeweb canonical release manifest contract', () => {
  it('binds the JSON schema to the approved source tree and exact component repositories', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      readonly 'x-sourceTree': string;
      readonly properties: {
        readonly gitCommit: { readonly const: string };
        readonly images: {
          readonly allOf: readonly {
            readonly contains: {
              readonly properties: {
                readonly component: { readonly const: string };
                readonly repository: { readonly const: string };
              };
            };
            readonly maxContains: number;
            readonly minContains: number;
          }[];
        };
      };
    };
    expect(schema.properties.gitCommit.const).toBe(approvedSourceSha);
    expect(schema['x-sourceTree']).toBe(approvedSourceTree);
    expect(
      schema.properties.images.allOf.map(({ contains, maxContains, minContains }) => ({
        component: contains.properties.component.const,
        maxContains,
        minContains,
        repository: contains.properties.repository.const,
      })),
    ).toEqual(
      ['web', 'api', 'worker', 'realtime', 'migrator'].map((component) => ({
        component,
        maxContains: 1,
        minContains: 1,
        repository: `ghcr.io/z6v6e6r/phub-${component}`,
      })),
    );
  });

  it('runs the production producer into the canonical fixture and validator end to end', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-producer-'));
    const manifestPath = join(directory, 'release-manifest.json');
    const checksumPath = join(directory, 'release-manifest.sha256');
    const produced = spawnSync(
      'node',
      [producer, reconciliationFixture, '111111', '222222', manifestPath, checksumPath],
      { encoding: 'utf8' },
    );
    expect(produced.status).toBe(0);
    expect(produced.stdout).toContain('TIMEWEB_RELEASE_MANIFEST_BUILT');
    expect(readFileSync(manifestPath, 'utf8')).toBe(readFileSync(manifestFixture, 'utf8'));
    expect(readFileSync(checksumPath, 'utf8')).toBe(readFileSync(checksumFixture, 'utf8'));

    const validated = spawnSync('node', [validator, manifestPath], {
      encoding: 'utf8',
    });
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('TIMEWEB_RELEASE_MANIFEST_PASSED');
    expect(`${validated.stdout}${validated.stderr}`).not.toContain('sha256:');

    const imageLines = spawnSync('node', [validator, manifestPath, '--image-lines'], {
      encoding: 'utf8',
    });
    expect(imageLines.status).toBe(0);
    expect(imageLines.stdout.trim().split('\n')).toHaveLength(5);
  });

  it('rejects the legacy top-level verification and object-form images', () => {
    const manifest = canonicalManifest();
    const legacyImages = Object.fromEntries(
      (manifest.images as Array<Record<string, unknown>>).map((image) => [
        image.component,
        { image: image.repository, digest: image.digest },
      ]),
    ) as Record<string, unknown>;
    expectRejected({
      ...manifest,
      verification: { provenance: true, sbom: true, reconciliation: true },
    });
    expectRejected({
      ...manifest,
      images: legacyImages,
    });
  });

  it('rejects a wrong schema identifier and a missing or wrong release commit', () => {
    const manifest = canonicalManifest();
    expectRejected({ ...manifest, schemaVersion: 1 });
    expectRejected({ ...manifest, gitCommit: supersededSourceSha });
    const withoutCommit = structuredClone(manifest);
    delete withoutCommit.gitCommit;
    expectRejected(withoutCommit);
  });

  it('rejects missing per-image verification and missing digests', () => {
    for (const field of ['provenance', 'sbom', 'reconciliation', 'digest']) {
      const manifest = canonicalManifest();
      const images = manifest.images as Array<Record<string, unknown>>;
      delete images[0]![field];
      expectRejected(manifest);
    }
    const manifest = canonicalManifest();
    const images = manifest.images as Array<Record<string, unknown>>;
    images[0]!.provenance = false;
    expectRejected(manifest);
  });

  it('rejects missing, malformed, and mismatched checksum sidecars', () => {
    const manifest = canonicalManifest();
    expectRejected(manifest, `${'0'.repeat(64)}  release-manifest.json\n`);
    expectRejected(manifest, `${'a'.repeat(64)}  other.json\n`);

    const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-no-checksum-'));
    const manifestPath = join(directory, 'release-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = spawnSync('node', [validator, manifestPath], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_FAILED');
  });

  it('rejects duplicate or missing components, wrong repositories, platforms, revisions, and runs', () => {
    const valid = canonicalManifest();
    const validImages = valid.images as Array<Record<string, unknown>>;
    const cases: Array<Record<string, unknown>> = [
      { ...valid, images: validImages.slice(0, 4) },
      { ...valid, images: [{ ...validImages[0] }, ...validImages.slice(0, 4)] },
      {
        ...valid,
        images: [
          { ...validImages[0], repository: 'ghcr.io/z6v6e6r/phub-api' },
          ...validImages.slice(1),
        ],
      },
      { ...valid, platform: 'linux/arm64' },
      {
        ...valid,
        images: [{ ...validImages[0], architecture: 'arm64' }, ...validImages.slice(1)],
      },
      {
        ...valid,
        images: [{ ...validImages[0], revision: 'a'.repeat(40) }, ...validImages.slice(1)],
      },
      { ...valid, reconciliationRuns: ['111111', '111111'] },
    ];
    for (const invalid of cases) expectRejected(invalid);
  });

  it('fails the producer closed for superseded source, wrong tree, omitted verification, or a digest', () => {
    for (const mutation of [
      (image: Record<string, unknown>) => {
        image.sourceSha = supersededSourceSha;
      },
      (image: Record<string, unknown>) => {
        image.sourceTree = 'a'.repeat(40);
      },
      (image: Record<string, unknown>) => {
        delete image.provenanceVerified;
      },
      (image: Record<string, unknown>) => {
        delete image.indexDigest;
      },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-producer-invalid-'));
      const reconciliation = JSON.parse(readFileSync(reconciliationFixture, 'utf8')) as {
        images: Array<Record<string, unknown>>;
      };
      mutation(reconciliation.images[0]!);
      const inputPath = join(directory, 'reconciliation.json');
      writeFileSync(inputPath, `${JSON.stringify(reconciliation, null, 2)}\n`);
      const result = spawnSync(
        'node',
        [
          producer,
          inputPath,
          '111111',
          '222222',
          join(directory, 'release-manifest.json'),
          join(directory, 'release-manifest.sha256'),
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_BUILD_FAILED');
    }
  });
});
