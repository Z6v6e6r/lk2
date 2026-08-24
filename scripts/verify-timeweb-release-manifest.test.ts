import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const validator = fileURLToPath(new URL('./verify-timeweb-release-manifest.js', import.meta.url));
const commit = '35c8312b79cccdd136f2bfd892efbea629b8b919';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V1',
    repository: 'Z6v6e6r/lk2',
    gitCommit: commit,
    platform: 'linux/amd64',
    images: ['web', 'api', 'worker', 'realtime', 'migrator'].map((component, index) => ({
      component,
      repository: `ghcr.io/z6v6e6r/phub-${component}`,
      digest: `sha256:${'abcde'[index]!.repeat(64)}`,
      architecture: 'amd64',
      revision: commit,
      provenance: true,
      sbom: true,
      reconciliation: true,
    })),
    ...overrides,
  };
}

function verify(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-timeweb-manifest-'));
  const path = join(directory, 'release-manifest.json');
  writeFileSync(path, JSON.stringify(value));
  return spawnSync('node', [validator, path], { encoding: 'utf8' });
}

describe('Timeweb machine release manifest verifier', () => {
  it('accepts the complete immutable amd64 component set without printing image values', () => {
    const result = verify(manifest());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TIMEWEB_RELEASE_MANIFEST_PASSED');
    expect(`${result.stdout}${result.stderr}`).not.toContain('sha256:');
  });

  it('fails closed for a missing component, mutable input, or stale application commit', () => {
    for (const invalid of [
      manifest({ images: manifest().images.slice(0, 4) }),
      manifest({ gitCommit: 'a'.repeat(40) }),
      manifest({
        images: [{ ...manifest().images[0], digest: 'latest' }, ...manifest().images.slice(1)],
      }),
    ]) {
      const result = verify(invalid);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_FAILED');
    }
  });

  it('rejects duplicate components, wrong repositories, platforms, and attestation assertions', () => {
    const valid = manifest();
    const images = valid.images;
    for (const invalid of [
      manifest({ images: [{ ...images[0] }, ...images.slice(0, 4)] }),
      manifest({
        images: [{ ...images[0], repository: 'ghcr.io/z6v6e6r/phub-api' }, ...images.slice(1)],
      }),
      manifest({ platform: 'linux/arm64' }),
      manifest({ images: [{ ...images[0], provenance: false }, ...images.slice(1)] }),
    ]) {
      const result = verify(invalid);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TIMEWEB_RELEASE_MANIFEST_FAILED');
    }
  });
});
