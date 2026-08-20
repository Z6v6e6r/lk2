import {
  assertCommunitiesStagingRoleSplitAttestedEvidence,
  assertCommunitiesStagingRoleSplitHostAuthorization,
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitAttestedEvidence,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitMarkerCeremonyObservation,
  type CommunitiesStagingRoleSplitMarkerCeremonyState,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';

import type {
  CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  CommunitiesStagingRoleSplitMarkerCeremonyHost,
  CommunitiesStagingRoleSplitMarkerCeremonyLease,
} from './communities-staging-role-split-marker-ceremony.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-ddl-fence.js';

export interface CommunitiesStagingRoleSplitCanonicalMarkerWriter {
  readonly subjectSha256: string;
  readonly connectionFactorySubjectSha256: string;
  write(input: {
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
    readonly cloneDatabaseOid: string;
    readonly marker: string;
  }): Promise<void>;
}

export interface CommunitiesStagingRoleSplitCanonicalOwnershipAclAttestor {
  readonly subjectSha256: string;
  attest(input: {
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
    readonly evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence;
    readonly artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts;
  }): Promise<{ readonly subjectSha256: string; readonly evidenceSha256: string }>;
}

export interface CommunitiesStagingRoleSplitCanonicalSourceWriteDenialAttestor {
  readonly subjectSha256: string;
  attest(input: {
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
    readonly evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence;
    readonly artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts;
  }): Promise<{ readonly subjectSha256: string; readonly evidenceSha256: string }>;
}

export interface CommunitiesStagingRoleSplitCanonicalEvidenceSink {
  readonly subjectSha256: string;
  observe(
    evidence: CommunitiesStagingRoleSplitAttestedEvidence,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation>;
  publish(evidence: CommunitiesStagingRoleSplitAttestedEvidence): Promise<void>;
}

export interface CommunitiesStagingRoleSplitCanonicalHostAdapterConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly authorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly expectedAuthorizationSha256: string;
  readonly canonicalHostAdapterSha256: string;
  readonly fenceTimeoutMs: number;
  readonly delegate: CommunitiesStagingRoleSplitMarkerCeremonyHost;
  readonly fence: CommunitiesStagingRoleSplitDdlFence & { readonly subjectSha256: string };
  readonly markerWriter: CommunitiesStagingRoleSplitCanonicalMarkerWriter;
  readonly ownershipAclAttestor: CommunitiesStagingRoleSplitCanonicalOwnershipAclAttestor;
  readonly sourceWriteDenialAttestor: CommunitiesStagingRoleSplitCanonicalSourceWriteDenialAttestor;
  readonly evidenceSink: CommunitiesStagingRoleSplitCanonicalEvidenceSink;
}

export class CommunitiesStagingRoleSplitCanonicalHostAdapterError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'FENCE_UNAVAILABLE'
      | 'FENCE_LOST'
      | 'FENCE_RELEASE_FAILED'
      | 'MARKER_OUTCOME_AMBIGUOUS'
      | 'ATTESTATION_INVALID'
      | 'EVIDENCE_OUTCOME_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_CANONICAL_HOST_ADAPTER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitCanonicalHostAdapterError';
  }
}

function fail(code: CommunitiesStagingRoleSplitCanonicalHostAdapterError['code']): never {
  throw new CommunitiesStagingRoleSplitCanonicalHostAdapterError(code);
}

function exactSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function binding(
  authorization: CommunitiesStagingRoleSplitHostAuthorization,
  code: (typeof authorization.bindings)[number]['code'],
): (typeof authorization.bindings)[number] {
  const result = authorization.bindings.find((candidate) => candidate.code === code);
  if (result === undefined) fail('AUTHORIZATION_INVALID');
  return result;
}

function assertConfig(config: CommunitiesStagingRoleSplitCanonicalHostAdapterConfig): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(config.request);
    assertCommunitiesStagingRoleSplitHostAuthorization(config.authorization);
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  if (
    !exactSha256(config.expectedAuthorizationSha256) ||
    communitiesStagingRoleSplitHostAuthorizationSha256(config.authorization) !==
      config.expectedAuthorizationSha256 ||
    config.authorization.markerRequestSha256 !==
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(config.request)
  )
    fail('AUTHORIZATION_INVALID');
  if (
    !exactSha256(config.canonicalHostAdapterSha256) ||
    binding(config.authorization, 'CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER').subjectSha256 !==
      config.canonicalHostAdapterSha256 ||
    binding(config.authorization, 'CLUSTER_DDL_FENCE').subjectSha256 !==
      config.fence.subjectSha256 ||
    binding(config.authorization, 'OWNERSHIP_ACL_ATTESTATION').subjectSha256 !==
      config.ownershipAclAttestor.subjectSha256 ||
    binding(config.authorization, 'SOURCE_WRITE_DENIAL_ATTESTATION').subjectSha256 !==
      config.sourceWriteDenialAttestor.subjectSha256 ||
    binding(config.authorization, 'INDEPENDENT_EVIDENCE_SINK').subjectSha256 !==
      config.evidenceSink.subjectSha256 ||
    binding(config.authorization, 'CLONE_ONLY_CONNECTION_FACTORY').subjectSha256 !==
      config.markerWriter.connectionFactorySubjectSha256 ||
    config.markerWriter.subjectSha256 !== config.request.markerWriterSha256 ||
    !Number.isSafeInteger(config.fenceTimeoutMs) ||
    config.fenceTimeoutMs < 1 ||
    config.fenceTimeoutMs > 60_000
  )
    fail('BINDING_INVALID');
}

function assertDdlLease(lease: CommunitiesStagingRoleSplitDdlFenceLease): void {
  if (
    !exactSha256(lease.requestSha256) ||
    !/^[0-9]{10,32}$/u.test(lease.systemIdentifier) ||
    !/^[1-9][0-9]*$/u.test(lease.backendPid) ||
    !exactSha256(lease.fencingToken) ||
    lease.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY
  )
    fail('FENCE_LOST');
}

export class CommunitiesStagingRoleSplitCanonicalHostAdapter implements CommunitiesStagingRoleSplitMarkerCeremonyHost {
  private readonly leases = new Map<
    string,
    {
      readonly ddlLease: CommunitiesStagingRoleSplitDdlFenceLease;
      delegateReleaseAttempted: boolean;
      delegateReleased: boolean;
      delegateReleaseError: Error | null;
    }
  >();

  constructor(private readonly config: CommunitiesStagingRoleSplitCanonicalHostAdapterConfig) {
    assertConfig(config);
  }

  private ddlLease(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): CommunitiesStagingRoleSplitDdlFenceLease {
    const entry = this.leases.get(lease.fencingToken);
    if (
      entry === undefined ||
      lease.requestSha256 !== this.config.authorization.markerRequestSha256
    )
      fail('FENCE_LOST');
    return entry.ddlLease;
  }

  /**
   * Supplies the already-held lease to the reviewed restore adapter. The caller
   * may assert it, but ownership and release remain with this canonical adapter.
   */
  async ddlFenceLeaseForRestore(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<CommunitiesStagingRoleSplitDdlFenceLease> {
    const ddlLease = this.ddlLease(lease);
    await this.config.fence.assertHeld(ddlLease).catch(() => fail('FENCE_LOST'));
    return ddlLease;
  }

  private async fenced<T>(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    const ddlLease = this.ddlLease(lease);
    await this.config.fence.assertHeld(ddlLease).catch(() => fail('FENCE_LOST'));
    const result = await operation();
    await this.config.fence.assertHeld(ddlLease).catch(() => fail('FENCE_LOST'));
    return result;
  }

  private async attestedEvidence(
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
    artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  ): Promise<CommunitiesStagingRoleSplitAttestedEvidence> {
    if (
      artifacts.payload.requestSha256 !== this.config.authorization.markerRequestSha256 ||
      artifacts.payload.creationReceiptSha256 !== this.config.authorization.creationReceiptSha256 ||
      artifacts.payload.cloneDatabaseOid !== this.config.authorization.execution.cloneDatabaseOid
    )
      fail('ATTESTATION_INVALID');
    try {
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
        artifacts.payload,
        artifacts.marker,
        evidence,
      );
    } catch {
      fail('ATTESTATION_INVALID');
    }
    let ownershipAclAttestation: {
      readonly subjectSha256: string;
      readonly evidenceSha256: string;
    };
    let sourceWriteDenialAttestation: {
      readonly subjectSha256: string;
      readonly evidenceSha256: string;
    };
    try {
      ownershipAclAttestation = await this.config.ownershipAclAttestor.attest({
        request: this.config.request,
        evidence,
        artifacts,
      });
      sourceWriteDenialAttestation = await this.config.sourceWriteDenialAttestor.attest({
        request: this.config.request,
        evidence,
        artifacts,
      });
    } catch {
      fail('ATTESTATION_INVALID');
    }
    const expectedOwnershipAcl = binding(this.config.authorization, 'OWNERSHIP_ACL_ATTESTATION');
    const expectedSourceWriteDenial = binding(
      this.config.authorization,
      'SOURCE_WRITE_DENIAL_ATTESTATION',
    );
    if (
      ownershipAclAttestation.subjectSha256 !== expectedOwnershipAcl.subjectSha256 ||
      ownershipAclAttestation.evidenceSha256 !== expectedOwnershipAcl.evidenceSha256 ||
      sourceWriteDenialAttestation.subjectSha256 !== expectedSourceWriteDenial.subjectSha256 ||
      sourceWriteDenialAttestation.evidenceSha256 !== expectedSourceWriteDenial.evidenceSha256
    )
      fail('ATTESTATION_INVALID');
    const attested = {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION,
      status: 'ATTESTED',
      authorizationSha256: this.config.expectedAuthorizationSha256,
      markerEvidence: evidence,
      ownershipAclAttestation,
      sourceWriteDenialAttestation,
      evidenceSinkSubjectSha256: this.config.evidenceSink.subjectSha256,
    } as const satisfies CommunitiesStagingRoleSplitAttestedEvidence;
    try {
      assertCommunitiesStagingRoleSplitAttestedEvidence(
        attested,
        artifacts.payload,
        artifacts.marker,
      );
    } catch {
      fail('ATTESTATION_INVALID');
    }
    return attested;
  }

  async acquireLease(
    requestSha256: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyLease> {
    if (requestSha256 !== this.config.authorization.markerRequestSha256)
      fail('AUTHORIZATION_INVALID');
    let ddlLease: CommunitiesStagingRoleSplitDdlFenceLease;
    try {
      ddlLease = await this.config.fence.acquire({
        requestSha256,
        systemIdentifier: this.config.request.systemIdentifier,
        timeoutMs: this.config.fenceTimeoutMs,
        signal: AbortSignal.timeout(this.config.fenceTimeoutMs),
      });
      assertDdlLease(ddlLease);
      if (
        ddlLease.requestSha256 !== requestSha256 ||
        ddlLease.systemIdentifier !== this.config.request.systemIdentifier
      )
        fail('FENCE_UNAVAILABLE');
      await this.config.fence.assertHeld(ddlLease);
    } catch {
      fail('FENCE_UNAVAILABLE');
    }
    let lease: CommunitiesStagingRoleSplitMarkerCeremonyLease;
    try {
      lease = await this.config.delegate.acquireLease(requestSha256);
    } catch (error) {
      await this.config.fence.release(ddlLease).catch(() => undefined);
      throw error;
    }
    if (
      lease.requestSha256 !== requestSha256 ||
      !exactSha256(lease.fencingToken) ||
      this.leases.has(lease.fencingToken)
    ) {
      await this.config.fence.release(ddlLease).catch(() => undefined);
      fail('FENCE_UNAVAILABLE');
    }
    this.leases.set(lease.fencingToken, {
      ddlLease,
      delegateReleaseAttempted: false,
      delegateReleased: false,
      delegateReleaseError: null,
    });
    return lease;
  }

  async releaseLease(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease): Promise<void> {
    const entry = this.leases.get(lease.fencingToken);
    if (
      entry === undefined ||
      lease.requestSha256 !== this.config.authorization.markerRequestSha256
    )
      fail('FENCE_LOST');
    if (!entry.delegateReleaseAttempted) {
      await this.config.fence.assertHeld(entry.ddlLease).catch(() => fail('FENCE_LOST'));
      entry.delegateReleaseAttempted = true;
      try {
        await this.config.delegate.releaseLease(lease);
        entry.delegateReleased = true;
      } catch (error) {
        entry.delegateReleaseError =
          error instanceof Error
            ? error
            : new CommunitiesStagingRoleSplitCanonicalHostAdapterError('FENCE_LOST');
      }
      if (entry.delegateReleaseError !== null) {
        try {
          await this.config.fence.release(entry.ddlLease);
        } catch {
          fail('FENCE_RELEASE_FAILED');
        }
        this.leases.delete(lease.fencingToken);
        throw entry.delegateReleaseError;
      }
      await this.config.fence.assertHeld(entry.ddlLease).catch(() => fail('FENCE_LOST'));
    }
    try {
      await this.config.fence.release(entry.ddlLease);
    } catch {
      fail('FENCE_RELEASE_FAILED');
    }
    this.leases.delete(lease.fencingToken);
    if (entry.delegateReleaseError !== null) throw entry.delegateReleaseError;
  }

  loadState(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    return this.fenced(lease, () => this.config.delegate.loadState(lease));
  }

  createCandidate(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    return this.fenced(lease, () => this.config.delegate.createCandidate(lease, state));
  }

  advanceState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    return this.fenced(lease, () => this.config.delegate.advanceState(lease, current, next));
  }

  saveVerified(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
    artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  ) {
    return this.fenced(lease, () =>
      this.config.delegate.saveVerified(lease, current, next, artifacts),
    );
  }

  loadVerifiedArtifacts(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    return this.fenced(lease, () => this.config.delegate.loadVerifiedArtifacts(lease));
  }

  observeClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string | null,
  ) {
    return this.fenced(lease, () =>
      this.config.delegate.observeClone(lease, expectedCloneDatabaseOid),
    );
  }

  observeMarkerPresence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
  ) {
    return this.fenced(lease, () =>
      this.config.delegate.observeMarkerPresence(lease, expectedCloneDatabaseOid),
    );
  }

  observeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
    marker: string,
  ) {
    return this.fenced(lease, () =>
      this.config.delegate.observeMarker(lease, expectedCloneDatabaseOid, marker),
    );
  }

  observeEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ) {
    return this.fenced(lease, async () => {
      const artifacts = await this.config.delegate.loadVerifiedArtifacts(lease);
      return this.config.evidenceSink.observe(await this.attestedEvidence(evidence, artifacts));
    });
  }

  createClone(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    return this.fenced(lease, () => this.config.delegate.createClone(lease));
  }

  restoreClone(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease, cloneDatabaseOid: string) {
    return this.fenced(lease, () => this.config.delegate.restoreClone(lease, cloneDatabaseOid));
  }

  verifyBindings(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease, cloneDatabaseOid: string) {
    return this.fenced(lease, () => this.config.delegate.verifyBindings(lease, cloneDatabaseOid));
  }

  writeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
    marker: string,
  ) {
    return this.fenced(lease, async () => {
      try {
        await this.config.markerWriter.write({
          request: this.config.request,
          cloneDatabaseOid,
          marker,
        });
      } catch {
        fail('MARKER_OUTCOME_AMBIGUOUS');
      }
    });
  }

  publishEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ) {
    return this.fenced(lease, async () => {
      const artifacts = await this.config.delegate.loadVerifiedArtifacts(lease);
      const attested = await this.attestedEvidence(evidence, artifacts);
      try {
        await this.config.evidenceSink.publish(attested);
      } catch {
        fail('EVIDENCE_OUTCOME_AMBIGUOUS');
      }
    });
  }

  dropExactClone(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease, cloneDatabaseOid: string) {
    return this.fenced(lease, () => this.config.delegate.dropExactClone(lease, cloneDatabaseOid));
  }

  clearState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    return this.fenced(lease, () => this.config.delegate.clearState(lease, current));
  }
}
