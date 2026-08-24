import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readRootOwnedEvidence: vi.fn(),
  verifyRequest: vi.fn(),
  verificationText: vi.fn(() => '{"verified":true}\n'),
}));

vi.mock('./root-owned-evidence.js', () => ({
  readRootOwnedEvidence: mocks.readRootOwnedEvidence,
}));

vi.mock('./communities-staging-role-split-trusted-inventory-authorization-request.js', () => ({
  verifyCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest: mocks.verifyRequest,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestVerificationText:
    mocks.verificationText,
}));

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSetSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  type CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization.js';
import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization-request.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_VERSION,
  issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryClock,
  type CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger,
} from './communities-staging-role-split-trusted-inventory-authorization-loader.js';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const candidateCommitSha = 'a'.repeat(40);
const noAuthorities = {
  inventoryConnection: false,
  inventoryRead: false,
  artifactWrite: false,
  trustedInventoryDesignation: false,
  roleCreation: false,
  roleSplit: false,
  aclMutation: false,
  sharedDatabaseMutation: false,
  migration: false,
  deploy: false,
  activation: false,
} as const;
const requestedAuthorities = {
  ...noAuthorities,
  inventoryConnection: true,
  inventoryRead: true,
  artifactWrite: true,
} as const;

type EvidenceCode = CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode;

function pathSha256(path: string): string {
  return sha256(`${path}\n`);
}

function fixture() {
  const requestIdSha256 = sha256('request-id');
  const gateSha256 = sha256('gate');
  const issuerSubjectSha256 = sha256('issuer');
  const approverSubjectSha256 = sha256('approver');
  const clockSubjectSha256 = sha256('clock');
  const ledgerSubjectSha256 = sha256('ledger');
  const attestorSubjectSha256 = sha256('attestor');
  const evidencePaths = Object.fromEntries(
    COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.map(
      (code, index) => [code, `/authorization/evidence/${index}-${code}.json`],
    ),
  ) as Record<EvidenceCode, string>;
  const evidence = {} as Record<EvidenceCode, Buffer>;
  const evidencePins =
    COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.map((code) => {
      const envelope = {
        schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-evidence-v1',
        status: 'INDEPENDENTLY_ATTESTED',
        code,
        requestIdSha256,
        candidateCommitSha,
        phase: 'BEFORE',
        gateSha256,
        subjectSha256: sha256(`subject-${code}`),
        payloadSha256: sha256(`payload-${code}`),
        evidencePathSha256: pathSha256(evidencePaths[code]),
        attestorSubjectSha256,
        authorizes: noAuthorities,
      } as const satisfies CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence;
      evidence[code] = Buffer.from(
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(envelope),
        'utf8',
      );
      return {
        code,
        status: 'PINNED_FOR_SEPARATE_REVIEW' as const,
        subjectSha256: envelope.subjectSha256,
        evidenceSha256:
          communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256(envelope),
        evidencePathSha256: envelope.evidencePathSha256,
      };
    });
  const request = {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-request-v1',
    status: 'AUTHORIZATION_REQUEST_REVIEW_ONLY',
    requestIdSha256,
    candidateCommitSha,
    phase: 'BEFORE',
    gateSha256,
    gateVerificationSha256: sha256('gate-verification'),
    evidencePins,
    policy: {
      singleUse: true,
      maximumAttempts: 1,
      authorizationValiditySeconds: 300,
      requiresDurableConsumptionLedger: true,
      requiresRootOwnedEvidence: true,
      requiresIndependentApprover: true,
      requiresFailClosedClock: true,
    },
    requestedAuthorities,
    authorizes: noAuthorities,
  } as const satisfies CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
  const expectedRequestSha256 =
    communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(request);
  const approval = {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-approval-v1',
    status: 'INDEPENDENTLY_APPROVED',
    approvalIdSha256: sha256('approval-id'),
    requestSha256: expectedRequestSha256,
    requestVerificationSha256: sha256('{"verified":true}\n'),
    evidenceSetSha256:
      communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSetSha256(request),
    issuerSubjectSha256,
    approverSubjectSha256,
    clockSubjectSha256,
    ledgerSubjectSha256,
    notBeforeUnixSeconds: '1000',
    expiresAtUnixSeconds: '1300',
    maximumAttempts: 1,
    authorizes: noAuthorities,
  } as const satisfies CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval;
  const expectedApprovalSha256 =
    communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256(approval);
  const gateInput = {} as Parameters<
    typeof issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization
  >[0]['gateInput'];
  const gateVerification = {} as Parameters<
    typeof issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization
  >[0]['gateVerification'];
  const authorization = issueCommunitiesStagingRoleSplitTrustedInventoryAuthorization({
    request,
    expectedRequestSha256,
    gateInput,
    gateVerification,
    evidence,
    evidencePaths,
    approval,
    expectedApprovalSha256,
    issuerSubjectSha256,
    clockSubjectSha256,
    ledgerSubjectSha256,
    currentUnixSeconds: '1001',
  });
  const expectedAuthorizationSha256 =
    communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(authorization);
  const requestPath = '/authorization/request.json';
  const approvalPath = '/authorization/approval.json';
  const authorizationPath = '/authorization/authorization.json';
  const files = new Map<string, Buffer>([
    [
      requestPath,
      Buffer.from(
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(request),
      ),
    ],
    [
      approvalPath,
      Buffer.from(
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(approval),
      ),
    ],
    [
      authorizationPath,
      Buffer.from(canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(authorization)),
    ],
    ...Object.entries(evidencePaths).map(
      ([code, path]) => [path, evidence[code as EvidenceCode]] as [string, Buffer],
    ),
  ]);
  const clockValues = ['1001', '1002'];
  const clock = {
    subjectSha256: clockSubjectSha256,
    nowUnixSeconds: vi.fn<CommunitiesStagingRoleSplitTrustedInventoryClock['nowUnixSeconds']>(() =>
      Promise.resolve(clockValues.shift() ?? '1002'),
    ),
  } satisfies CommunitiesStagingRoleSplitTrustedInventoryClock;
  const consumeOnce = vi.fn<
    CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger['consumeOnce']
  >((input) =>
    Promise.resolve<CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt>({
      schemaVersion: 'communities-staging-role-split-trusted-inventory-consumption-receipt-v1',
      status: 'CONSUMED',
      authorizationSha256: input.authorizationSha256,
      requestIdSha256: input.requestIdSha256,
      ledgerSubjectSha256,
      attempt: 1,
      consumedAtUnixSeconds: '1001',
      authorizes: noAuthorities,
    }),
  );
  const ledger = {
    subjectSha256: ledgerSubjectSha256,
    consumeOnce,
  } satisfies CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger;
  return {
    request,
    expectedRequestSha256,
    gateInput,
    gateVerification,
    evidence,
    evidencePaths,
    approval,
    expectedApprovalSha256,
    issuerSubjectSha256,
    clockSubjectSha256,
    ledgerSubjectSha256,
    authorization,
    expectedAuthorizationSha256,
    requestPath,
    approvalPath,
    authorizationPath,
    files,
    clock,
    clockValues,
    ledger,
    consumeOnce,
  };
}

function loadInput(value: ReturnType<typeof fixture>) {
  return {
    requestPath: value.requestPath,
    expectedRequestSha256: value.expectedRequestSha256,
    approvalPath: value.approvalPath,
    expectedApprovalSha256: value.expectedApprovalSha256,
    authorizationPath: value.authorizationPath,
    expectedAuthorizationSha256: value.expectedAuthorizationSha256,
    evidencePaths: value.evidencePaths,
    gateInput: value.gateInput,
    gateVerification: value.gateVerification,
    issuerSubjectSha256: value.issuerSubjectSha256,
    clock: value.clock,
    ledger: value.ledger,
  };
}

beforeEach(() => {
  mocks.readRootOwnedEvidence.mockReset();
  mocks.verifyRequest.mockReset().mockReturnValue({});
  mocks.verificationText.mockClear();
});

describe('trusted inventory single-use authorization issuer and root-owned loader', () => {
  it('issues only a pending all-false artifact after exact evidence and approval binding', () => {
    const value = fixture();

    expect(COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_LOADER_VERSION).toBe(
      'communities-staging-role-split-trusted-inventory-authorization-loader-v1',
    );
    expect(value.authorization.status).toBe('ISSUED_PENDING_SINGLE_USE_CONSUMPTION');
    expect(Object.values(value.authorization.authorizes).every((entry) => entry === false)).toBe(
      true,
    );
    expect(value.authorization.requestedAuthorities).toEqual(requestedAuthorities);
    expect(mocks.verifyRequest).toHaveBeenCalledTimes(1);
  });

  it('reads every artifact through root custody and grants only three in-memory capabilities after one consume', async () => {
    const value = fixture();
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(value.files.get(path)!),
    );

    const result = await loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
      loadInput(value),
    );

    expect(mocks.readRootOwnedEvidence).toHaveBeenCalledTimes(13);
    expect(value.consumeOnce).toHaveBeenCalledTimes(1);
    expect(value.clock.nowUnixSeconds).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('CONSUMED_SINGLE_USE_AUTHORIZATION');
    expect(result.authorizes).toEqual(requestedAuthorities);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authorizes)).toBe(true);
  });

  it('fails closed on custody, evidence and approval drift before ledger consumption', async () => {
    const custody = fixture();
    mocks.readRootOwnedEvidence.mockRejectedValueOnce(new Error('custody'));
    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadInput(custody)),
    ).rejects.toThrow(/LOADER_CUSTODY_INVALID/u);
    expect(custody.consumeOnce).not.toHaveBeenCalled();

    const evidenceDrift = fixture();
    evidenceDrift.files.set(
      evidenceDrift.evidencePaths.CLEAN_CLONE_PROVENANCE,
      Buffer.from('tampered\n'),
    );
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(evidenceDrift.files.get(path)),
    );
    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadInput(evidenceDrift)),
    ).rejects.toThrow(/LOADER_INPUT_INVALID/u);
    expect(evidenceDrift.consumeOnce).not.toHaveBeenCalled();

    const approvalDrift = fixture();
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(approvalDrift.files.get(path)),
    );
    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization({
        ...loadInput(approvalDrift),
        expectedApprovalSha256: sha256('wrong-approval'),
      }),
    ).rejects.toThrow(/LOADER_APPROVAL_INVALID/u);
    expect(approvalDrift.consumeOnce).not.toHaveBeenCalled();
  });

  it('never retries an ambiguous ledger response or a replay rejection', async () => {
    const ambiguous = fixture();
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(ambiguous.files.get(path)),
    );
    ambiguous.consumeOnce.mockRejectedValueOnce(new Error('response lost'));
    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadInput(ambiguous)),
    ).rejects.toThrow(/LOADER_LEDGER_INVALID/u);
    expect(ambiguous.consumeOnce).toHaveBeenCalledTimes(1);

    const malformed = fixture();
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(malformed.files.get(path)),
    );
    malformed.consumeOnce.mockResolvedValueOnce({ status: 'CONSUMED' } as never);
    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadInput(malformed)),
    ).rejects.toThrow(/LOADER_LEDGER_INVALID/u);
    expect(malformed.consumeOnce).toHaveBeenCalledTimes(1);
  });

  it('burns the single attempt when the post-consumption clock check fails', async () => {
    const value = fixture();
    value.clockValues.splice(0, value.clockValues.length, '1001', '1300');
    mocks.readRootOwnedEvidence.mockImplementation((path: string) =>
      Promise.resolve(value.files.get(path)),
    );

    await expect(
      loadCommunitiesStagingRoleSplitTrustedInventoryAuthorization(loadInput(value)),
    ).rejects.toThrow(/LOADER_CLOCK_INVALID/u);
    expect(value.consumeOnce).toHaveBeenCalledTimes(1);
    expect(value.clock.nowUnixSeconds).toHaveBeenCalledTimes(2);
  });

  it('adds no CLI, package export, build entry or PostgreSQL/process execution surface', async () => {
    const [source, rootPackage, tsupConfig, databaseIndex] = await Promise.all([
      readFile(
        new URL(
          './communities-staging-role-split-trusted-inventory-authorization-loader.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../tsup.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../packages/database/src/index.ts', import.meta.url), 'utf8'),
    ]);
    const basename = 'communities-staging-role-split-trusted-inventory-authorization-loader';

    expect(rootPackage).not.toContain(basename);
    expect(tsupConfig).not.toContain(basename);
    expect(databaseIndex).not.toContain(basename);
    expect(source).not.toMatch(/node:child_process|\bfrom ['"]pg['"]|process\.argv/u);
    expect(source).not.toMatch(/\b(?:spawn|execFile|connect)\s*\(/u);
  });
});
