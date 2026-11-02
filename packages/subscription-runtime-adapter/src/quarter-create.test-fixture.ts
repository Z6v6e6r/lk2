import fixture from '../../domain/src/fixtures/quarter-create-owner-v1.json';
import {
  qcHash,
  qcOperationId,
  qcDraftId,
  qcPrepareHash,
  qcAdmissionHash,
  parseQuarterAdmission,
  type QuarterReceipt,
  type QuarterExpiredRejection,
} from '@phub/domain/quarter-create';
export async function quarterFixture(
  input: {
    tenantId?: string;
    userId?: string;
    key?: string;
    stationId?: string;
    startsAt?: string;
    observedAt?: string;
  } = {},
) {
  const raw = structuredClone(fixture.admission),
    key = input.key ?? 'synthetic-quarter-original-key',
    tenantId = input.tenantId ?? raw.preparation.actor.tenantId,
    userId = input.userId ?? raw.preparation.actor.userId,
    keySha256 = await qcHash(key),
    id = await qcOperationId(tenantId, userId, keySha256),
    draftId = await qcDraftId(tenantId, userId, keySha256);
  raw.target.draftId = draftId;
  if (input.startsAt) {
    raw.target.startsAt = input.startsAt;
    raw.preparation.target.endsAt = new Date(Date.parse(input.startsAt) + 3600000).toISOString();
  }
  if (input.stationId) raw.target.stationId = input.stationId;
  raw.preparation.target = { ...raw.preparation.target, ...raw.target };
  raw.preparation.actor.tenantId = tenantId;
  raw.preparation.actor.userId = userId;
  raw.preparation.operationId = id;
  raw.preparation.idempotencyKeySha256 = keySha256;
  raw.preparation.observedAt = input.observedAt ?? new Date().toISOString();
  raw.preparation.expiresAt = new Date(
    Date.parse(raw.preparation.observedAt) + 60000,
  ).toISOString();
  const request = {
    contractVersion: 1 as const,
    action: 'CREATE_GAME' as const,
    subscriptionId: raw.subscriptionId,
    target: { ...raw.target, durationMinutes: 60 as const },
  };
  raw.preparation.requestSha256 = await qcPrepareHash(request);
  const { sha256: _, ...capsule } = raw.preparation;
  void _;
  raw.preparation.sha256 = await qcHash('game-create-capsule:v1\0' + JSON.stringify(capsule));
  const admission = await parseQuarterAdmission(raw),
    p = admission.preparation;
  const context = {
    providerClientId: p.actor.providerClientId,
    providerMappingId: p.actor.providerMappingId,
    providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
    stationMappingId: p.target.stationMappingId,
    courtMappingId: p.target.courtMappingId,
    mappingVersion: p.target.mappingVersion,
    providerStationId: p.target.providerStationId,
    providerRoomId: p.target.providerRoomId,
  };
  const receipt: QuarterReceipt = {
    schemaVersion: 1,
    operationId: id,
    admissionRequestSha256: await qcAdmissionHash(admission),
    actor: { tenantId, userId },
    target: admission.target,
    providerExerciseId: 'synthetic-exercise-' + id,
    providerBookingId: 'synthetic-booking-' + id,
    entitlement: {
      subscriptionInstanceId: 'instance:synthetic-create',
      policyVersion: 3,
      policyDigest: 'sha256:' + 'a'.repeat(64),
      usageOperationId: 'synthetic-usage',
      reservedUnits: 1,
    },
    confirmedAt: new Date().toISOString(),
  };
  return {
    request,
    admission,
    context,
    receipt,
    key,
    scope: { tenantId, userId, keySha256, idempotencyKey: key },
    input: {
      stationId: request.target.stationId,
      courtId: request.target.courtId,
      startsAt: request.target.startsAt,
      subscriptionId: request.subscriptionId,
    },
  };
}

export function expiredQuarterReceipt(
  f: Awaited<ReturnType<typeof quarterFixture>>,
): QuarterExpiredRejection {
  return {
    schemaVersion: 2,
    outcome: 'REJECTED',
    operationId: f.receipt.operationId,
    admissionRequestSha256: f.receipt.admissionRequestSha256,
    actor: f.receipt.actor,
    target: f.receipt.target,
    reason: 'PRECREATE_EXPIRED_NOT_DISPATCHED',
    abortId: '11111111-1111-4111-8111-000000000080',
    capsuleExpiresAt: f.admission.preparation.expiresAt,
    abortedAt: f.admission.preparation.expiresAt,
    rejectedAt: f.admission.preparation.expiresAt,
    entitlement: {
      subscriptionInstanceId: f.receipt.entitlement.subscriptionInstanceId,
      usageOperationId: f.receipt.entitlement.usageOperationId,
      operationState: 'FAILED',
      compensationState: 'APPLIED',
      releaseReason: 'PRECREATE_EXPIRED_NOT_DISPATCHED',
      providerBookingId: null,
    },
  };
}
