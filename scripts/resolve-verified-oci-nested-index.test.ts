import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Descriptor = {
  readonly annotations?: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly mediaType: string;
  readonly platform?: { readonly architecture: string; readonly os: string };
  readonly size: number;
};

const mediaTypes = {
  index: 'application/vnd.oci.image.index.v1+json',
  manifest: 'application/vnd.oci.image.manifest.v1+json',
} as const;

const digest = (body: Buffer | string) =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const runtime: Descriptor = {
  mediaType: mediaTypes.manifest,
  digest: `sha256:${'1'.repeat(64)}`,
  size: 100,
  platform: { os: 'linux', architecture: 'amd64' },
};

const attestation = (runtimeDigest = runtime.digest): Descriptor => ({
  mediaType: mediaTypes.manifest,
  digest: `sha256:${'2'.repeat(64)}`,
  size: 200,
  platform: { os: 'unknown', architecture: 'unknown' },
  annotations: {
    'vnd.docker.reference.type': 'attestation-manifest',
    'vnd.docker.reference.digest': runtimeDigest,
  },
});

const nestedIndex = (manifests: readonly Descriptor[] = [runtime, attestation()]) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: mediaTypes.index,
      manifests,
    }),
  );

describe('bounded OCI nested-index resolver', () => {
  it('accepts exactly one content-bound nested index and rejects unsafe topologies', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'phub-oci-nested-index-test-'));
    const script = fileURLToPath(
      new URL('./resolve-verified-oci-nested-index.sh', import.meta.url),
    );
    let sequence = 0;

    const run = async ({
      nested = nestedIndex(),
      rootDigest = digest(nested),
      rootManifests,
      rootMediaType = mediaTypes.index,
      rootSize = nested.length,
      writeNested = true,
    }: {
      readonly nested?: Buffer;
      readonly rootDigest?: string;
      readonly rootManifests?: readonly Descriptor[];
      readonly rootMediaType?: string;
      readonly rootSize?: number;
      readonly writeNested?: boolean;
    } = {}) => {
      sequence += 1;
      const layout = join(temporary, `layout-${sequence}`);
      const blobs = join(layout, 'blobs', 'sha256');
      const evidence = join(temporary, `evidence-${sequence}`);
      await mkdir(blobs, { recursive: true });
      const defaultRootDescriptor: Descriptor = {
        mediaType: mediaTypes.index,
        digest: rootDigest,
        size: rootSize,
      };
      await writeFile(
        join(layout, 'index.json'),
        JSON.stringify({
          schemaVersion: 2,
          mediaType: rootMediaType,
          manifests: rootManifests ?? [defaultRootDescriptor],
        }),
      );
      if (writeNested) {
        await writeFile(join(blobs, rootDigest.replace(/^sha256:/u, '')), nested);
      }
      const result = spawnSync('bash', [script, layout, evidence], { encoding: 'utf8' });
      return { evidence, result };
    };

    try {
      const valid = await run();
      expect(valid.result.status, `${valid.result.stderr}\n${valid.result.stdout}`).toBe(0);
      expect(
        JSON.parse(await readFile(join(valid.evidence, 'oci-nested-index.json'), 'utf8')),
      ).toMatchObject({ manifests: [runtime, attestation()] });
      expect(
        JSON.parse(await readFile(join(valid.evidence, 'runtime-descriptor.json'), 'utf8')),
      ).toMatchObject(runtime);
      expect(
        JSON.parse(await readFile(join(valid.evidence, 'attestation-descriptor.json'), 'utf8')),
      ).toMatchObject(attestation());

      expect((await run({ rootManifests: [] })).result.status).not.toBe(0);
      expect((await run({ rootManifests: [runtime, runtime] })).result.status).not.toBe(0);
      expect((await run({ rootMediaType: mediaTypes.manifest })).result.status).not.toBe(0);
      expect((await run({ rootSize: nestedIndex().length + 1 })).result.status).not.toBe(0);
      expect((await run({ writeNested: false })).result.status).not.toBe(0);

      const wrongDigest = `sha256:${'f'.repeat(64)}`;
      expect((await run({ rootDigest: wrongDigest })).result.status).not.toBe(0);
      expect(
        (
          await run({
            nested: nestedIndex([{ ...runtime, mediaType: mediaTypes.index }, attestation()]),
          })
        ).result.status,
      ).not.toBe(0);
      expect(
        (await run({ nested: nestedIndex([runtime, attestation(), runtime]) })).result.status,
      ).not.toBe(0);
      expect(
        (
          await run({
            nested: nestedIndex([runtime, { ...runtime, digest: attestation().digest }]),
          })
        ).result.status,
      ).not.toBe(0);
      expect(
        (await run({ nested: nestedIndex([attestation(), attestation()]) })).result.status,
      ).not.toBe(0);
      expect(
        (await run({ nested: nestedIndex([runtime, attestation(`sha256:${'3'.repeat(64)}`)]) }))
          .result.status,
      ).not.toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
