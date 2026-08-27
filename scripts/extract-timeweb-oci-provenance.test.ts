import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';
import {
  extractTimewebOciProvenance,
  OciProvenanceExtractionError,
} from './extract-timeweb-oci-provenance.js';

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os: string; architecture: string };
  annotations?: Record<string, string>;
}

async function writeBlob(layout: string, value: unknown, mediaType: string): Promise<Descriptor> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const hex = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(layout, 'blobs', 'sha256', hex), bytes);
  return { mediaType, digest: `sha256:${hex}`, size: bytes.length };
}

async function syntheticLayout() {
  const layout = await mkdtemp(join(tmpdir(), 'phub-oci-provenance-'));
  await mkdir(join(layout, 'blobs', 'sha256'), { recursive: true });
  await writeFile(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
  const runtime = await writeBlob(
    layout,
    { schemaVersion: 2, config: {}, layers: [] },
    'application/vnd.oci.image.manifest.v1+json',
  );
  runtime.platform = { os: 'linux', architecture: 'amd64' };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ digest: { sha256: runtime.digest.slice(7) } }],
    predicate: {},
  };
  const layer = await writeBlob(layout, statement, 'application/vnd.in-toto+json');
  layer.annotations = { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' };
  const attestation = await writeBlob(
    layout,
    { schemaVersion: 2, subject: runtime, layers: [layer] },
    'application/vnd.oci.image.manifest.v1+json',
  );
  attestation.platform = { os: 'unknown', architecture: 'unknown' };
  attestation.annotations = {
    'vnd.docker.reference.type': 'attestation-manifest',
    'vnd.docker.reference.digest': runtime.digest,
  };
  const nested = await writeBlob(
    layout,
    { schemaVersion: 2, manifests: [runtime, attestation] },
    'application/vnd.oci.image.index.v1+json',
  );
  await writeFile(
    join(layout, 'index.json'),
    `${JSON.stringify({ schemaVersion: 2, manifests: [nested] })}\n`,
  );
  return { layout, runtime, statement };
}

describe('no-push OCI provenance extraction', () => {
  it('follows a nested OCI index and binds the attestation to the AMD64 runtime', async () => {
    const fixture = await syntheticLayout();
    expect(extractTimewebOciProvenance(fixture.layout)).toEqual({
      runtimeDigest: fixture.runtime.digest,
      statement: fixture.statement,
    });
  });

  it('fails closed when the layout contains more than one AMD64 runtime', async () => {
    const fixture = await syntheticLayout();
    const index = parseStrictJson<{ manifests: Descriptor[] }>(
      await readFile(join(fixture.layout, 'index.json')),
    );
    index.manifests.push({ ...fixture.runtime });
    await writeFile(join(fixture.layout, 'index.json'), `${JSON.stringify(index)}\n`);
    expect(() => extractTimewebOciProvenance(fixture.layout)).toThrow(OciProvenanceExtractionError);
  });
});
