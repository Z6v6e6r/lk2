import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  canonicalCommunitiesStagingRoleSplitHostAuthorization,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitHostBindingCode,
} from '@phub/database';

import { readRootOwnedEvidence } from './root-owned-evidence.js';

const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_BINDING_EVIDENCE_BYTES = 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class CommunitiesStagingRoleSplitHostAuthorizationLoaderError extends Error {
  constructor(readonly code: 'AUTHORIZATION_INVALID' | 'EVIDENCE_INVALID') {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_LOADER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitHostAuthorizationLoaderError';
  }
}

function fail(code: CommunitiesStagingRoleSplitHostAuthorizationLoaderError['code']): never {
  throw new CommunitiesStagingRoleSplitHostAuthorizationLoaderError(code);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseCommunitiesStagingRoleSplitHostAuthorization(
  bytes: Buffer,
  expectedAuthorizationSha256: string,
): CommunitiesStagingRoleSplitHostAuthorization {
  if (
    !sha256Pattern.test(expectedAuthorizationSha256) ||
    bytes.length < 1 ||
    bytes.length > MAX_AUTHORIZATION_BYTES ||
    digest(bytes) !== expectedAuthorizationSha256
  )
    fail('AUTHORIZATION_INVALID');

  let authorization: CommunitiesStagingRoleSplitHostAuthorization;
  try {
    authorization = JSON.parse(
      bytes.toString('utf8'),
    ) as CommunitiesStagingRoleSplitHostAuthorization;
    assertCommunitiesStagingRoleSplitHostAuthorization(authorization);
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  if (
    canonicalCommunitiesStagingRoleSplitHostAuthorization(authorization) !==
      bytes.toString('utf8') ||
    communitiesStagingRoleSplitHostAuthorizationSha256(authorization) !==
      expectedAuthorizationSha256
  )
    fail('AUTHORIZATION_INVALID');
  return authorization;
}

export function assertCommunitiesStagingRoleSplitHostBindingEvidence(
  authorization: CommunitiesStagingRoleSplitHostAuthorization,
  evidence: Readonly<Record<CommunitiesStagingRoleSplitHostBindingCode, Buffer>>,
): void {
  try {
    assertCommunitiesStagingRoleSplitHostAuthorization(authorization);
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  const keys = Object.keys(evidence).sort();
  const expectedKeys = [...COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    fail('EVIDENCE_INVALID');
  for (const binding of authorization.bindings) {
    const bytes = evidence[binding.code];
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > MAX_BINDING_EVIDENCE_BYTES ||
      digest(bytes) !== binding.evidenceSha256
    )
      fail('EVIDENCE_INVALID');
  }
}

export async function loadCommunitiesStagingRoleSplitHostAuthorization(input: {
  readonly authorizationPath: string;
  /** Independently pinned SHA-256; never derive it from authorizationPath. */
  readonly expectedAuthorizationSha256: string;
  readonly evidencePaths: Readonly<Record<CommunitiesStagingRoleSplitHostBindingCode, string>>;
}): Promise<CommunitiesStagingRoleSplitHostAuthorization> {
  const paths = [input.authorizationPath, ...Object.values(input.evidencePaths)];
  if (new Set(paths).size !== paths.length) fail('EVIDENCE_INVALID');
  const authorizationBytes = await readRootOwnedEvidence(
    input.authorizationPath,
    MAX_AUTHORIZATION_BYTES,
  ).catch(() => fail('AUTHORIZATION_INVALID'));
  const authorization = parseCommunitiesStagingRoleSplitHostAuthorization(
    authorizationBytes,
    input.expectedAuthorizationSha256,
  );
  const evidence = {} as Record<CommunitiesStagingRoleSplitHostBindingCode, Buffer>;
  for (const code of COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES) {
    const path = input.evidencePaths[code];
    if (typeof path !== 'string') fail('EVIDENCE_INVALID');
    evidence[code] = await readRootOwnedEvidence(path, MAX_BINDING_EVIDENCE_BYTES).catch(() =>
      fail('EVIDENCE_INVALID'),
    );
  }
  assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, evidence);
  return authorization;
}
