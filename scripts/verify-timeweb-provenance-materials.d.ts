import type { BaseImageLock } from './verify-timeweb-base-images.js';

export class ProvenanceMaterialsError extends Error {
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CanonicalBuildkitPurl {
  readonly type: 'docker';
  readonly packageName: string;
  readonly version: string;
  readonly digest: string;
  readonly platform: 'linux/amd64';
}

export interface ProvenanceMaterialEvidence {
  readonly service: string;
  readonly sourceSha: string;
  readonly builderId: string;
  readonly dockerfilePath: string;
  readonly repository: string;
  readonly runtimeDigest: string;
  readonly materials: readonly {
    readonly logicalId: string;
    readonly repository: string;
    readonly tag: string;
    readonly digest: string;
  }[];
}

export function parseCanonicalBuildkitPurl(uri: unknown): CanonicalBuildkitPurl;
export function validateProvenanceMaterials(input: {
  readonly statement: unknown;
  readonly service: string;
  readonly sourceSha: string;
  readonly builderId: string;
  readonly runtimeDigest: string;
  readonly dockerfilePath: string;
  readonly repository: string;
  readonly baseLock: BaseImageLock;
}): ProvenanceMaterialEvidence;
