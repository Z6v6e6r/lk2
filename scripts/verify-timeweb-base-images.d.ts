export class BaseImageContractError extends Error {
  readonly reason: string;
}

export interface BaseImageConsumer {
  service: string;
  stage: string;
}

export interface BaseImageLockEntry {
  id: string;
  registry: string;
  repository: string;
  tag: string;
  indexDigest: string;
  platform: {
    os: string;
    architecture: string;
    variant: string;
    manifestDigest: string;
  };
  consumers: BaseImageConsumer[];
}

export interface BaseImageLock {
  schema: string;
  images: BaseImageLockEntry[];
}

export interface BaseImageEvidence {
  baseLock: { schema: string; sha256: string };
  baseImages: Array<{
    id: string;
    registry: string;
    repository: string;
    tag: string;
    indexDigest: string;
    manifestDigest: string;
  }>;
}

export function parseBaseImageLock(bytes: Buffer | string): BaseImageLock;
export function validateBaseImageLock(lock: BaseImageLock): BaseImageLock;
export function validateDockerfiles(lock: BaseImageLock, repoRoot: string): void;
export function validateRegistryProof(
  image: BaseImageLockEntry,
  proof: { indexBytes: Buffer; childBytes: Buffer; configBytes: Buffer },
): void;
export function baseImageEvidence(lock: BaseImageLock, rawBytes: Buffer): BaseImageEvidence;
