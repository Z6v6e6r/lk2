import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSetSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConsumptionReceiptSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  type CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';
import {
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText,
  verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from './communities-staging-role-split-trusted-inventory-authorization-request.js';
import type { CommunitiesStagingRoleSplitTrustedInventoryGateVerification } from './communities-staging-role-split-trusted-inventory-gate.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const UNIX_SECONDS = /^(0|[1-9][0-9]{0,15})$/u;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_APPROVAL_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

type EvidenceCode = CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode;
type GateInput = Parameters<
  typeof verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest
>[0]['gateInput'];

export interface CommunitiesStagingRoleSplitTrustedInventoryClock {
  readonly subjectSha256: string;
  readonly nowUnixSeconds: () => Promise<string>;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger {
  readonly subjectSha256: string;
  readonly consumeOnce: (input: {
    readonly authorizationSha256: string;
    readonly requestIdSha256: string;
    readonly expiresAtUnixSeconds: string;
    readonly maximumAttempts: 1;
  }) => Promise<CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt>;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryConsumedAuthorization {
  readonly status: 'CONSUMED_SINGLE_USE_AUTHORIZATION';
  readonly authorizationSha256: string;
  readonly consumptionReceiptSha256: string;
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly authorizes: {
    readonly inventoryConnection: true;
    readonly inventoryRead: true;
    readonly artifactWrite: true;
    readonly trustedInventoryDesignation: false;
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

export class CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError extends Error {
  constructor(
    readonly code:
      | 'INPUT_INVALID'
      | 'CUSTODY_INVALID'
      | 'APPROVAL_INVALID'
      | 'CLOCK_INVALID'
      | 'LEDGER_INVALID'
      | 'AUTHORIZATION_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError';
  }
}

function fail(
  code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError['code'],
): never {
  throw new CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError(code);
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathSha256(path: string): string {
  return digest(`${path}\n`);
}

function isCanonicalAbsolutePath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
}

function exactEvidencePathMap(
  value: Readonly<Record<EvidenceCode, string>>,
): value is Readonly<Record<EvidenceCode, string>> {
  const actual = Object.keys(value).sort();
  const expected = [
    ...COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  ].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]) &&
    Object.values(value).every(isCanonicalAbsolutePath) &&
    new Set(Object.values(value)).size === expected.length
  );
}

function assertCurrentTime(
  value: string,
  notBeforeUnixSeconds: string,
  expiresAtUnixSeconds: string,
): void {
  if (
    !UNIX_SECONDS.test(value) ||
    !UNIX_SECONDS.test(notBeforeUnixSeconds) ||
    !UNIX_SECONDS.test(expiresAtUnixSeconds)
  )
    fail('CLOCK_INVALID');
  const current = BigInt(value);
  if (current < BigInt(notBeforeUnixSeconds) || current >= BigInt(expiresAtUnixSeconds))
    fail('CLOCK_INVALID');
}

function parseEvidenceBytes(
  bytes: Buffer,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence {
  try {
    return parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(
      bytes.toString('utf8'),
    );
  } catch {
    fail('INPUT_INVALID');
  }
}

function parseApprovalBytes(
  bytes: Buffer,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval {
  try {
    return parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(
      bytes.toString('utf8'),
    );
  } catch {
    fail('APPROVAL_INVALID');
  }
}

function parseAuthorizationBytes(
  bytes: Buffer,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  try {
    return parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization(bytes.toString('utf8'));
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
}

function validateEvidence(input: {
  readonly request: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  readonly evidence: Readonly<Record<EvidenceCode, Buffer>>;
  readonly evidencePaths: Readonly<Record<EvidenceCode, string>>;
  readonly issuerSubjectSha256: string;
  readonly approverSubjectSha256: string;
  readonly clockSubjectSha256: string;
  readonly ledgerSubjectSha256: string;
}): void {
  if (!exactEvidencePathMap(input.evidencePaths)) fail('INPUT_INVALID');
  const evidenceKeys = Object.keys(input.evidence).sort();
  const expectedKeys = [
    ...COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  ].sort();
  if (
    evidenceKeys.length !== expectedKeys.length ||
    evidenceKeys.some((key, index) => key !== expectedKeys[index])
  )
    fail('INPUT_INVALID');

  for (const [
    index,
    code,
  ] of COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.entries()) {
    const pin = input.request.evidencePins[index];
    const bytes = input.evidence[code];
    if (!pin || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES)
      fail('INPUT_INVALID');
    const envelope = parseEvidenceBytes(bytes);
    if (
      pin.code !== code ||
      communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256(envelope) !==
        pin.evidenceSha256 ||
      digest(bytes) !== pin.evidenceSha256 ||
      pathSha256(input.evidencePaths[code]) !== pin.evidencePathSha256 ||
      envelope.code !== code ||
      envelope.requestIdSha256 !== input.request.requestIdSha256 ||
      envelope.candidateCommitSha !== input.request.candidateCommitSha ||
      envelope.phase !== input.request.phase ||
      envelope.gateSha256 !== input.request.gateSha256 ||
      envelope.subjectSha256 !== pin.subjectSha256 ||
      envelope.evidencePathSha256 !== pin.evidencePathSha256 ||
      [
        input.issuerSubjectSha256,
        input.approverSubjectSha256,
        input.clockSubjectSha256,
        input.ledgerSubjectSha256,
      ].includes(envelope.attestorSubjectSha256)
    )
      fail('INPUT_INVALID');
  }
}

export function issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization(input: {
  readonly request: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  readonly expectedRequestSha256: string;
  readonly gateInput: GateInput;
  readonly gateVerification: CommunitiesStagingRoleSplitTrustedInventoryGateVerification;
  readonly evidence: Readonly<Record<EvidenceCode, Buffer>>;
  readonly evidencePaths: Readonly<Record<EvidenceCode, string>>;
  readonly approval: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval;
  readonly expectedApprovalSha256: string;
  readonly issuerSubjectSha256: string;
  readonly clockSubjectSha256: string;
  readonly ledgerSubjectSha256: string;
  readonly currentUnixSeconds: string;
}): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  try {
    if (
      ![
        input.expectedRequestSha256,
        input.expectedApprovalSha256,
        input.issuerSubjectSha256,
        input.clockSubjectSha256,
        input.ledgerSubjectSha256,
      ].every((entry) => SHA256.test(entry))
    )
      fail('INPUT_INVALID');

    const requestVerification =
      verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest({
        request: input.request,
        expectedRequestSha256: input.expectedRequestSha256,
        gateInput: input.gateInput,
        gateVerification: input.gateVerification,
      });
    const requestSha256 = communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(
      input.request,
    );
    const requestVerificationSha256 = digest(
      communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText(
        requestVerification,
      ),
    );
    validateEvidence({
      request: input.request,
      evidence: input.evidence,
      evidencePaths: input.evidencePaths,
      issuerSubjectSha256: input.issuerSubjectSha256,
      approverSubjectSha256: input.approval.approverSubjectSha256,
      clockSubjectSha256: input.clockSubjectSha256,
      ledgerSubjectSha256: input.ledgerSubjectSha256,
    });

    const approvalSha256 = communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256(
      input.approval,
    );
    const evidenceSetSha256 =
      communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSetSha256(input.request);
    if (
      approvalSha256 !== input.expectedApprovalSha256 ||
      input.approval.requestSha256 !== requestSha256 ||
      input.approval.requestVerificationSha256 !== requestVerificationSha256 ||
      input.approval.evidenceSetSha256 !== evidenceSetSha256 ||
      input.approval.issuerSubjectSha256 !== input.issuerSubjectSha256 ||
      input.approval.clockSubjectSha256 !== input.clockSubjectSha256 ||
      input.approval.ledgerSubjectSha256 !== input.ledgerSubjectSha256
    )
      fail('APPROVAL_INVALID');
    assertCurrentTime(
      input.currentUnixSeconds,
      input.approval.notBeforeUnixSeconds,
      input.approval.expiresAtUnixSeconds,
    );

    return {
      schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-v1',
      status: 'ISSUED_PENDING_SINGLE_USE_CONSUMPTION',
      approvalSha256,
      approvalIdSha256: input.approval.approvalIdSha256,
      requestSha256,
      requestVerificationSha256,
      requestIdSha256: input.request.requestIdSha256,
      candidateCommitSha: input.request.candidateCommitSha,
      phase: input.request.phase,
      gateSha256: input.request.gateSha256,
      evidenceSetSha256,
      issuerSubjectSha256: input.issuerSubjectSha256,
      approverSubjectSha256: input.approval.approverSubjectSha256,
      clockSubjectSha256: input.clockSubjectSha256,
      ledgerSubjectSha256: input.ledgerSubjectSha256,
      notBeforeUnixSeconds: input.approval.notBeforeUnixSeconds,
      expiresAtUnixSeconds: input.approval.expiresAtUnixSeconds,
      maximumAttempts: 1,
      requestedAuthorities: input.request.requestedAuthorities,
      authorizes: input.request.authorizes,
    };
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitTrustedInventoryAuthorizationLoaderError)
      throw error;
    fail('INPUT_INVALID');
  }
}

export async function loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(input: {
  readonly requestPath: string;
  readonly expectedRequestSha256: string;
  readonly approvalPath: string;
  readonly expectedApprovalSha256: string;
  readonly authorizationPath: string;
  readonly expectedAuthorizationSha256: string;
  readonly evidencePaths: Readonly<Record<EvidenceCode, string>>;
  readonly gateInput: GateInput;
  readonly gateVerification: CommunitiesStagingRoleSplitTrustedInventoryGateVerification;
  readonly issuerSubjectSha256: string;
  readonly clock: CommunitiesStagingRoleSplitTrustedInventoryClock;
  readonly ledger: CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger;
}): Promise<CommunitiesStagingRoleSplitTrustedInventoryConsumedAuthorization> {
  const clockSubjectSha256 = input.clock.subjectSha256;
  const ledgerSubjectSha256 = input.ledger.subjectSha256;
  const nowUnixSeconds = input.clock.nowUnixSeconds;
  const consumeOnce = input.ledger.consumeOnce;
  if (
    ![input.requestPath, input.approvalPath, input.authorizationPath].every(
      isCanonicalAbsolutePath,
    ) ||
    !exactEvidencePathMap(input.evidencePaths) ||
    new Set([
      input.requestPath,
      input.approvalPath,
      input.authorizationPath,
      ...Object.values(input.evidencePaths),
    ]).size !==
      3 + COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.length ||
    ![
      input.expectedRequestSha256,
      input.expectedApprovalSha256,
      input.expectedAuthorizationSha256,
      input.issuerSubjectSha256,
      clockSubjectSha256,
      ledgerSubjectSha256,
    ].every((entry) => SHA256.test(entry)) ||
    typeof nowUnixSeconds !== 'function' ||
    typeof consumeOnce !== 'function'
  )
    fail('INPUT_INVALID');

  const read = async (path: string, maximumBytes: number): Promise<Buffer> =>
    readRootOwnedEvidence(path, maximumBytes).catch(() => fail('CUSTODY_INVALID'));
  const requestBytes = await read(input.requestPath, MAX_REQUEST_BYTES);
  const approvalBytes = await read(input.approvalPath, MAX_APPROVAL_BYTES);
  const authorizationBytes = await read(input.authorizationPath, MAX_AUTHORIZATION_BYTES);
  const evidence = {} as Record<EvidenceCode, Buffer>;
  for (const code of COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES)
    evidence[code] = await read(input.evidencePaths[code], MAX_EVIDENCE_BYTES);

  let request: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  try {
    request = parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
      requestBytes.toString('utf8'),
    );
  } catch {
    fail('INPUT_INVALID');
  }
  if (
    digest(requestBytes) !== input.expectedRequestSha256 ||
    communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(request) !==
      input.expectedRequestSha256
  )
    fail('INPUT_INVALID');
  const approval = parseApprovalBytes(approvalBytes);
  if (
    digest(approvalBytes) !== input.expectedApprovalSha256 ||
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(approval) !==
      approvalBytes.toString('utf8')
  )
    fail('APPROVAL_INVALID');
  const loadedAuthorization = parseAuthorizationBytes(authorizationBytes);
  if (digest(authorizationBytes) !== input.expectedAuthorizationSha256)
    fail('AUTHORIZATION_INVALID');

  let before: string;
  try {
    before = await nowUnixSeconds.call(input.clock);
  } catch {
    fail('CLOCK_INVALID');
  }
  const expectedAuthorization = issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization({
    request,
    expectedRequestSha256: input.expectedRequestSha256,
    gateInput: input.gateInput,
    gateVerification: input.gateVerification,
    evidence,
    evidencePaths: input.evidencePaths,
    approval,
    expectedApprovalSha256: input.expectedApprovalSha256,
    issuerSubjectSha256: input.issuerSubjectSha256,
    clockSubjectSha256,
    ledgerSubjectSha256,
    currentUnixSeconds: before,
  });
  const authorizationSha256 =
    communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(expectedAuthorization);
  if (
    authorizationSha256 !== input.expectedAuthorizationSha256 ||
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(expectedAuthorization) !==
      authorizationBytes.toString('utf8') ||
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadedAuthorization) !==
      authorizationBytes.toString('utf8')
  )
    fail('AUTHORIZATION_INVALID');

  let consumption: CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt;
  try {
    consumption = await consumeOnce.call(input.ledger, {
      authorizationSha256,
      requestIdSha256: request.requestIdSha256,
      expiresAtUnixSeconds: expectedAuthorization.expiresAtUnixSeconds,
      maximumAttempts: 1,
    });
  } catch {
    fail('LEDGER_INVALID');
  }
  let consumptionReceiptSha256: string;
  try {
    consumptionReceiptSha256 =
      communitiesStagingRoleSplitTrustedInventoryConsumptionReceiptSha256(consumption);
  } catch {
    fail('LEDGER_INVALID');
  }
  if (
    consumption.authorizationSha256 !== authorizationSha256 ||
    consumption.requestIdSha256 !== request.requestIdSha256 ||
    consumption.ledgerSubjectSha256 !== ledgerSubjectSha256 ||
    consumption.attempt !== 1 ||
    Object.values(consumption.authorizes).some((entry) => entry !== false)
  )
    fail('LEDGER_INVALID');

  let after: string;
  try {
    after = await nowUnixSeconds.call(input.clock);
  } catch {
    fail('CLOCK_INVALID');
  }
  assertCurrentTime(
    after,
    expectedAuthorization.notBeforeUnixSeconds,
    expectedAuthorization.expiresAtUnixSeconds,
  );
  if (
    !UNIX_SECONDS.test(consumption.consumedAtUnixSeconds) ||
    BigInt(after) < BigInt(before) ||
    BigInt(consumption.consumedAtUnixSeconds) < BigInt(before) ||
    BigInt(consumption.consumedAtUnixSeconds) > BigInt(after)
  )
    fail('CLOCK_INVALID');

  const authorizes = Object.freeze({
    inventoryConnection: true as const,
    inventoryRead: true as const,
    artifactWrite: true as const,
    trustedInventoryDesignation: false as const,
    roleCreation: false as const,
    roleSplit: false as const,
    aclMutation: false as const,
    sharedDatabaseMutation: false as const,
    migration: false as const,
    deploy: false as const,
    activation: false as const,
  });
  return Object.freeze({
    status: 'CONSUMED_SINGLE_USE_AUTHORIZATION' as const,
    authorizationSha256,
    consumptionReceiptSha256,
    requestIdSha256: request.requestIdSha256,
    candidateCommitSha: request.candidateCommitSha,
    phase: request.phase,
    gateSha256: request.gateSha256,
    authorizes,
  });
}
