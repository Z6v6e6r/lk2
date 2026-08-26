import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  baseImageEvidence,
  parseBaseImageLock,
  validateBaseImageLock,
  validateDockerfiles,
  validateRegistryProof,
} from './verify-timeweb-base-images.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repositoryRoot, 'deploy/timeweb/base-images.lock.json');
const productionBytes = readFileSync(lockPath);
const productionLock = validateBaseImageLock(parseBaseImageLock(productionBytes));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('required fixture value is missing');
  return value;
}

function sha(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function fixture() {
  type Descriptor = {
    mediaType: string;
    digest: string;
    size: number;
    platform: { os: string; architecture: string };
    annotations?: Record<string, string>;
    artifactType?: string;
    subject?: unknown;
  };
  const config = { architecture: 'amd64', os: 'linux', config: {} };
  const configBytes = bytes(config);
  const child = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: sha(configBytes),
      size: configBytes.length,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: `sha256:${'1'.repeat(64)}`,
        size: 10,
      },
    ],
  };
  const childBytes = bytes(child);
  const descriptor: Descriptor = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: sha(childBytes),
    size: childBytes.length,
    platform: { os: 'linux', architecture: 'amd64' },
  };
  const index: {
    schemaVersion: number;
    mediaType: string;
    manifests: Descriptor[];
  } = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [descriptor],
  };
  const indexBytes = bytes(index);
  const image = clone(required(productionLock.images[0]));
  image.indexDigest = sha(indexBytes);
  image.platform.manifestDigest = sha(childBytes);
  return { image, index, indexBytes, child, childBytes, config, configBytes, descriptor };
}

function repoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phub-base-lock-'));
  for (const service of ['web', 'api', 'worker', 'realtime', 'migrator']) {
    const source = join(repositoryRoot, 'apps', service, 'Dockerfile');
    const target = join(root, 'apps', service, 'Dockerfile');
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return root;
}

describe('strict V2 base-image lock parsing and schema', () => {
  it('1. accepts the production V2 lock', () => {
    expect(productionLock.schema).toBe('PHUB_TIMEWEB_BASE_IMAGES_V2');
  });

  it.each([
    ['2. duplicate root key', '{"schema":"x","schema":"y","images":[]}'],
    [
      '3. duplicate image-object key',
      '{"schema":"PHUB_TIMEWEB_BASE_IMAGES_V2","images":[{"id":"x","id":"y"}]}',
    ],
    [
      '4. duplicate nested platform key',
      '{"schema":"PHUB_TIMEWEB_BASE_IMAGES_V2","images":[{"platform":{"os":"linux","os":"amd64"}}]}',
    ],
    [
      'duplicate key inside an array object',
      '{"schema":"PHUB_TIMEWEB_BASE_IMAGES_V2","images":[{"consumers":[{"service":"web","service":"api"}]}]}',
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseBaseImageLock(Buffer.from(raw))).toThrowError(/duplicate_key/u);
  });

  it('5. rejects trailing JSON content', () => {
    expect(() => parseBaseImageLock(Buffer.from('{} true'))).toThrowError(/trailing_content/u);
  });

  it('rejects malformed UTF-8', () => {
    expect(() => parseBaseImageLock(Buffer.from([0x7b, 0xff, 0x7d]))).toThrowError(
      /malformed_utf8/u,
    );
  });

  it.each(['/* comment */{}', '{"value":NaN}', '{"value":Infinity}'])(
    'rejects non-JSON extension %s',
    (raw) => expect(() => parseBaseImageLock(Buffer.from(raw))).toThrow(),
  );

  it('keeps __proto__ as inert own data instead of mutating the parsed object prototype', () => {
    const parsed = parseBaseImageLock(
      Buffer.from('{"__proto__":{"polluted":true}}'),
    ) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect((parsed.__proto__ as Record<string, unknown>).polluted).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('6. rejects an unknown logical image', () => {
    const lock = clone(productionLock);
    required(lock.images[0]).id = 'unknown';
    expect(() => validateBaseImageLock(lock)).toThrowError(/logical_image_set/u);
  });

  it('7. rejects a missing logical image', () => {
    const lock = clone(productionLock);
    lock.images.pop();
    expect(() => validateBaseImageLock(lock)).toThrowError(/logical_image_set/u);
  });

  it('8. rejects a duplicate logical image ID', () => {
    const lock = clone(productionLock);
    required(lock.images[1]).id = required(lock.images[0]).id;
    expect(() => validateBaseImageLock(lock)).toThrowError(/logical_image_set/u);
  });

  it('9. rejects invalid digest syntax', () => {
    const lock = clone(productionLock);
    required(lock.images[0]).indexDigest = 'sha256:not-a-digest';
    expect(() => validateBaseImageLock(lock)).toThrowError(/index_digest/u);
  });

  it('10. rejects wrong platform and non-empty variant', () => {
    const lock = clone(productionLock);
    required(lock.images[0]).platform.variant = 'v8';
    expect(() => validateBaseImageLock(lock)).toThrowError(/platform/u);
  });
});

describe('repository, tag and consumer binding', () => {
  it('11. rejects the Node tag combined with the Nginx repository', () => {
    const lock = clone(productionLock);
    lock.images.find((image) => image.id === 'node-runtime-build-base')!.repository =
      'library/nginx';
    expect(() => validateBaseImageLock(lock)).toThrowError(/repository_binding/u);
  });

  it('12. rejects the scanner tag combined with the Node repository', () => {
    const lock = clone(productionLock);
    lock.images.find((image) => image.id === 'buildkit-syft-scanner')!.repository = 'library/node';
    expect(() => validateBaseImageLock(lock)).toThrowError(/repository_binding/u);
  });

  it('13. rejects an unknown registry', () => {
    const lock = clone(productionLock);
    required(lock.images[0]).registry = 'example.invalid';
    expect(() => validateBaseImageLock(lock)).toThrowError(/repository_binding/u);
  });

  it('14. rejects an independently supplied full tagged reference', () => {
    const lock = clone(productionLock) as typeof productionLock & { annotationTag?: string };
    lock.annotationTag = 'node:22-bookworm-slim';
    expect(() => validateBaseImageLock(lock)).toThrowError(/lock_shape/u);
  });

  it('rejects missing, duplicate and extra consumer entries', () => {
    for (const mutation of ['missing', 'duplicate', 'extra']) {
      const lock = clone(productionLock);
      const consumers = required(lock.images[0]).consumers;
      if (mutation === 'missing') consumers.pop();
      if (mutation === 'duplicate') consumers[1] = clone(required(consumers[0]));
      if (mutation === 'extra') consumers.push({ service: 'web', stage: 'runtime' });
      expect(() => validateBaseImageLock(lock)).toThrowError(/consumers/u);
    }
  });
});

describe('Dockerfile projection', () => {
  it('15. matches all expected production stages', () => {
    expect(() => validateDockerfiles(productionLock, repositoryRoot)).not.toThrow();
  });

  it('16. rejects a mutable-only FROM', () => {
    const root = repoFixture();
    const path = join(root, 'apps/web/Dockerfile');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/@sha256:[a-f0-9]{64}/u, ''));
    expect(() => validateDockerfiles(productionLock, root)).toThrowError(
      /dockerfile_lock_mismatch/u,
    );
  });

  it('17. rejects a wrong index digest', () => {
    const root = repoFixture();
    const path = join(root, 'apps/web/Dockerfile');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/sha256:[a-f0-9]{64}/u, `sha256:${'0'.repeat(64)}`),
    );
    expect(() => validateDockerfiles(productionLock, root)).toThrowError(
      /dockerfile_lock_mismatch/u,
    );
  });

  it('18. rejects a lock-only digest change until Dockerfiles change', () => {
    const lock = clone(productionLock);
    required(lock.images[0]).indexDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => validateDockerfiles(lock, repositoryRoot)).toThrowError(
      /dockerfile_lock_mismatch/u,
    );
  });

  it('19. rejects a Dockerfile-only digest change until the lock changes', () => {
    const root = repoFixture();
    const path = join(root, 'apps/api/Dockerfile');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/sha256:[a-f0-9]{64}/gu, `sha256:${'2'.repeat(64)}`),
    );
    expect(() => validateDockerfiles(productionLock, root)).toThrowError(
      /dockerfile_lock_mismatch/u,
    );
  });

  it('20. rejects a base-image ARG override', () => {
    const root = repoFixture();
    const path = join(root, 'apps/worker/Dockerfile');
    writeFileSync(path, `ARG NODE_BASE\n${readFileSync(path, 'utf8')}`);
    expect(() => validateDockerfiles(productionLock, root)).toThrowError(/base_arg/u);
  });

  it('21. rejects a missing expected stage', () => {
    const root = repoFixture();
    const path = join(root, 'apps/migrator/Dockerfile');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^FROM .* AS production$/mu, ''));
    expect(() => validateDockerfiles(productionLock, root)).toThrowError(/dockerfile_stage_set/u);
  });
});

describe('registry index, child and config proof', () => {
  it('22. accepts an exact normal index, child and config proof', () => {
    const proof = fixture();
    expect(() => validateRegistryProof(proof.image, proof)).not.toThrow();
  });

  it('23. rejects a missing AMD64 child', () => {
    const proof = fixture();
    proof.index.manifests[0]!.platform.architecture = 'arm64';
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/amd64_child_count/u);
  });

  it('24. rejects two runnable AMD64 children', () => {
    const proof = fixture();
    proof.index.manifests.push(clone(proof.descriptor));
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/amd64_child_count/u);
  });

  it('25. rejects an arm64-only index', () => {
    const proof = fixture();
    proof.index.manifests[0]!.platform = { os: 'linux', architecture: 'arm64' };
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/amd64_child_count/u);
  });

  it('26. rejects the wrong locked child digest', () => {
    const proof = fixture();
    proof.image.platform.manifestDigest = `sha256:${'3'.repeat(64)}`;
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/child_descriptor/u);
  });

  it('27. rejects wrong config OS or architecture', () => {
    const proof = fixture();
    proof.config.os = 'windows';
    proof.configBytes = bytes(proof.config);
    proof.child.config.digest = sha(proof.configBytes);
    proof.child.config.size = proof.configBytes.length;
    proof.childBytes = bytes(proof.child);
    proof.descriptor.digest = sha(proof.childBytes);
    proof.descriptor.size = proof.childBytes.length;
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    proof.image.platform.manifestDigest = sha(proof.childBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/config_platform/u);
  });

  it('28. ignores unknown/unknown attestation descriptors as runtime children', () => {
    const proof = fixture();
    proof.index.manifests.push({
      ...clone(proof.descriptor),
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
    });
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    expect(() => validateRegistryProof(proof.image, proof)).not.toThrow();
  });

  it('29. rejects an artifact descriptor mislabeled linux/amd64', () => {
    const proof = fixture();
    Object.assign(proof.index.manifests[0]!, {
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
    });
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/child_descriptor/u);
  });

  it.each([
    ['30. child artifactType', { artifactType: 'application/example' }],
    ['31. child subject', { subject: { digest: `sha256:${'4'.repeat(64)}` } }],
  ])('rejects %s', (_name, extra) => {
    const proof = fixture();
    Object.assign(proof.child, extra);
    proof.childBytes = bytes(proof.child);
    proof.descriptor.digest = sha(proof.childBytes);
    proof.descriptor.size = proof.childBytes.length;
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    proof.image.platform.manifestDigest = sha(proof.childBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/runtime_manifest/u);
  });

  it('32. rejects the OCI empty attestation config as runtime config', () => {
    const proof = fixture();
    proof.child.config.mediaType = 'application/vnd.oci.empty.v1+json';
    proof.childBytes = bytes(proof.child);
    proof.descriptor.digest = sha(proof.childBytes);
    proof.descriptor.size = proof.childBytes.length;
    proof.indexBytes = bytes(proof.index);
    proof.image.indexDigest = sha(proof.indexBytes);
    proof.image.platform.manifestDigest = sha(proof.childBytes);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/runtime_manifest/u);
  });

  it('33. rejects a raw manifest hash mismatch', () => {
    const proof = fixture();
    proof.indexBytes = Buffer.concat([proof.indexBytes, Buffer.from(' ')]);
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/index_hash/u);
  });
});

describe('mutable tag is diagnostic-only', () => {
  it('34. keeps the locked digest valid when the annotation tag moves', () => {
    const proof = fixture();
    proof.image.tag = 'moved-diagnostic-tag';
    expect(() => validateRegistryProof(proof.image, proof)).not.toThrow();
  });

  it('35. never replaces the lock identity with a current tag digest', () => {
    const evidence = baseImageEvidence(productionLock, productionBytes);
    const first = required(evidence.baseImages[0]);
    expect(first.indexDigest).toBe(
      productionLock.images.find((image) => image.id === first.id)!.indexDigest,
    );
  });

  it('36. cannot turn a tag inspection failure into a fallback identity', () => {
    const proof = fixture();
    proof.image.tag = 'unavailable';
    proof.indexBytes = Buffer.from('{}');
    expect(() => validateRegistryProof(proof.image, proof)).toThrowError(/index_hash/u);
  });
});
