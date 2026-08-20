import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  assertCommunitiesStagingRoleSplitHostBindingEvidence as assertCanonicalBindingEvidence,
  assertCommunitiesStagingRoleSplitHostAuthorization,
  canonicalCommunitiesStagingRoleSplitHostBindingEvidence,
  canonicalCommunitiesStagingRoleSplitHostAuthorization,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  communitiesStagingRoleSplitExecutionSubjectSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitHostBindingEvidence,
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
  evidencePaths: Readonly<Record<CommunitiesStagingRoleSplitHostBindingCode, string>>,
): void {
  try {
    assertCommunitiesStagingRoleSplitHostAuthorization(authorization);
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  const keys = Object.keys(evidence).sort();
  const pathKeys = Object.keys(evidencePaths).sort();
  const expectedKeys = [...COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    pathKeys.length !== expectedKeys.length ||
    pathKeys.some((key, index) => key !== expectedKeys[index]) ||
    Object.values(evidencePaths).some(
      (path) => typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path,
    ) ||
    new Set(Object.values(evidencePaths)).size !== expectedKeys.length
  )
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
    let envelope: CommunitiesStagingRoleSplitHostBindingEvidence;
    try {
      envelope = JSON.parse(
        bytes.toString('utf8'),
      ) as CommunitiesStagingRoleSplitHostBindingEvidence;
      assertCanonicalBindingEvidence(envelope);
    } catch {
      fail('EVIDENCE_INVALID');
    }
    if (
      canonicalCommunitiesStagingRoleSplitHostBindingEvidence(envelope) !==
        bytes.toString('utf8') ||
      envelope.code !== binding.code ||
      envelope.candidateCommitSha !== authorization.candidateCommitSha ||
      envelope.markerRequestSha256 !== authorization.markerRequestSha256 ||
      envelope.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
      envelope.executionSubjectSha256 !==
        communitiesStagingRoleSplitExecutionSubjectSha256(authorization.execution) ||
      envelope.subjectSha256 !== binding.subjectSha256 ||
      envelope.evidencePathSha256 !==
        digest(Buffer.from(`${evidencePaths[binding.code]}\n`, 'utf8'))
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
  assertCommunitiesStagingRoleSplitHostBindingEvidence(
    authorization,
    evidence,
    input.evidencePaths,
  );
  return authorization;
}
