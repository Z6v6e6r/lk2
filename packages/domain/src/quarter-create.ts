/** Private quarter CREATE wire. Never expose provider bindings/capsules in public DTOs. */
export class QuarterCreateError extends Error {
  constructor(
    public readonly code = 'GAME_QUARTER_CREATE_UNAVAILABLE',
    public readonly status = 503,
  ) {
    super(code);
  }
}
export const qcBad = (): never => {
  throw new QuarterCreateError('GAME_QUARTER_CREATE_EVIDENCE_INVALID');
};
export const qcObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : qcBad();
export const qcExact = (v: unknown, keys: string) => {
  const r = qcObject(v);
  if (Object.keys(r).sort().join() !== keys.split(',').sort().join()) qcBad();
  return r;
};
export const qcUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const qcId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v) && !/[\r\n]/.test(v);
export const qcDigest = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 71 && /^sha256:[a-f0-9]{64}$/.test(v);
export const qcIso = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const ordered = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(ordered)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, ordered(x)]),
        )
      : v;
export const qcEqual = (a: unknown, b: unknown) =>
  JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export async function qcHash(s: string) {
  const { createHash } = await import('node:crypto');
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}
async function uuidHash(s: string) {
  const h = (await qcHash(s)).slice(7, 39).split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const qcOperationId = (tenant: string, user: string, key: string) =>
  uuidHash(`booked-operation-admission:v1\0lk2-api\0${tenant}\0${user}\0${key}`);
export const qcDraftId = (tenant: string, user: string, key: string) =>
  uuidHash(`game-quarter-create:v1\0draft\0${tenant}\0${user}\0${key}`);
export interface QuarterInput {
  stationId: string;
  courtId: string;
  startsAt: string;
  subscriptionId: string;
}
export function parseQuarterInput(v: unknown): QuarterInput {
  const r = qcExact(v, 'stationId,courtId,startsAt,subscriptionId');
  if (
    ![r.stationId, r.courtId, r.subscriptionId].every(qcUuid) ||
    !qcIso(r.startsAt) ||
    Date.parse(r.startsAt) % 60000
  )
    qcBad();
  return {
    stationId: r.stationId as string,
    courtId: r.courtId as string,
    startsAt: r.startsAt as string,
    subscriptionId: r.subscriptionId as string,
  };
}
export interface QuarterTarget {
  draftId: string;
  expectedRevision: number;
  stationId: string;
  courtId: string;
  startsAt: string;
  durationMinutes: 60;
}
export interface QuarterRequest {
  contractVersion: 1;
  action: 'CREATE_GAME';
  subscriptionId: string;
  target: QuarterTarget;
}
export function parseQuarterRequest(v: unknown): QuarterRequest {
  const r = qcExact(v, 'contractVersion,action,subscriptionId,target'),
    t = qcExact(r.target, 'draftId,expectedRevision,stationId,courtId,startsAt,durationMinutes');
  if (
    r.contractVersion !== 1 ||
    r.action !== 'CREATE_GAME' ||
    !qcUuid(r.subscriptionId) ||
    ![t.draftId, t.stationId, t.courtId].every(qcUuid) ||
    !Number.isSafeInteger(t.expectedRevision) ||
    Number(t.expectedRevision) < 1 ||
    !qcIso(t.startsAt) ||
    Date.parse(t.startsAt) % 60000 ||
    t.durationMinutes !== 60
  )
    qcBad();
  return {
    contractVersion: 1,
    action: 'CREATE_GAME',
    subscriptionId: r.subscriptionId as string,
    target: {
      draftId: t.draftId as string,
      expectedRevision: t.expectedRevision as number,
      stationId: t.stationId as string,
      courtId: t.courtId as string,
      startsAt: t.startsAt as string,
      durationMinutes: 60,
    },
  };
}
export interface QuarterContext {
  providerClientId: string;
  providerMappingId: string;
  providerClientSubscriptionId: string;
  stationMappingId: string;
  courtMappingId: string;
  mappingVersion: string;
  providerStationId: string;
  providerRoomId: string;
}
export function parseQuarterContext(v: unknown): QuarterContext {
  const r = qcExact(
    v,
    'providerClientId,providerMappingId,providerClientSubscriptionId,stationMappingId,courtMappingId,mappingVersion,providerStationId,providerRoomId',
  );
  if (
    ![r.providerMappingId, r.stationMappingId, r.courtMappingId].every(qcUuid) ||
    ![
      r.providerClientId,
      r.providerClientSubscriptionId,
      r.mappingVersion,
      r.providerStationId,
      r.providerRoomId,
    ].every(qcId)
  )
    qcBad();
  return {
    providerClientId: r.providerClientId as string,
    providerMappingId: r.providerMappingId as string,
    providerClientSubscriptionId: r.providerClientSubscriptionId as string,
    stationMappingId: r.stationMappingId as string,
    courtMappingId: r.courtMappingId as string,
    mappingVersion: r.mappingVersion as string,
    providerStationId: r.providerStationId as string,
    providerRoomId: r.providerRoomId as string,
  };
}
export interface QuarterCapsule {
  schemaVersion: 1;
  nonBinding: true;
  operationId: string;
  requestSha256: string;
  idempotencyKeySha256: string;
  actor: { tenantId: string; userId: string; providerClientId: string; providerMappingId: string };
  subscription: { id: string; providerClientSubscriptionId: string };
  target: QuarterTarget & {
    endsAt: string;
    stationMappingId: string;
    courtMappingId: string;
    mappingVersion: string;
    providerStationId: string;
    providerRoomId: string;
  };
  pricing: {
    masterServiceId: string;
    subServiceIds: string[];
    selectorRevision: string;
    catalogEvidenceSha256: string;
    participantCount: 4;
    priceBasis: 'WHOLE_COURT_WINDOW';
    courtWindowPriceMinor: number;
    quarterPriceMinor: number;
    currency: 'RUB';
  };
  observedAt: string;
  expiresAt: string;
  sha256: string;
}
export interface QuarterAdmission extends QuarterRequest {
  preparation: QuarterCapsule;
}
export const qcPrepareHash = (r: QuarterRequest) =>
  qcHash('game-create-preparation:v1\0' + JSON.stringify(r));
export const qcAdmissionHash = (r: QuarterAdmission) =>
  qcHash('game-create-admission:v1\0' + JSON.stringify(r));
export const qcReadBody = (operationId: string, admissionRequestSha256: string) => ({
  contractVersion: 1 as const,
  operationId,
  admissionRequestSha256,
});
export const qcReadHash = (r: ReturnType<typeof qcReadBody>) =>
  qcHash('game-create-read:v1\0' + JSON.stringify(r));
export async function parseQuarterAdmission(v: unknown): Promise<QuarterAdmission> {
  const r = qcExact(v, 'contractVersion,action,subscriptionId,target,preparation'),
    q = parseQuarterRequest({
      contractVersion: r.contractVersion,
      action: r.action,
      subscriptionId: r.subscriptionId,
      target: r.target,
    });
  const p = qcExact(
      r.preparation,
      'schemaVersion,nonBinding,operationId,requestSha256,idempotencyKeySha256,actor,subscription,target,pricing,observedAt,expiresAt,sha256',
    ),
    a = qcExact(p.actor, 'tenantId,userId,providerClientId,providerMappingId'),
    s = qcExact(p.subscription, 'id,providerClientSubscriptionId'),
    t = qcExact(
      p.target,
      'draftId,expectedRevision,stationId,courtId,startsAt,durationMinutes,endsAt,stationMappingId,courtMappingId,mappingVersion,providerStationId,providerRoomId',
    ),
    price = qcExact(
      p.pricing,
      'masterServiceId,subServiceIds,selectorRevision,catalogEvidenceSha256,participantCount,priceBasis,courtWindowPriceMinor,quarterPriceMinor,currency',
    );
  if (
    p.schemaVersion !== 1 ||
    p.nonBinding !== true ||
    !qcUuid(p.operationId) ||
    ![p.requestSha256, p.idempotencyKeySha256, p.sha256].every(qcDigest) ||
    ![a.tenantId, a.userId, a.providerMappingId, t.stationMappingId, t.courtMappingId].every(
      qcUuid,
    ) ||
    ![
      a.providerClientId,
      s.providerClientSubscriptionId,
      t.mappingVersion,
      t.providerStationId,
      t.providerRoomId,
      price.masterServiceId,
      price.selectorRevision,
    ].every(qcId) ||
    s.id !== q.subscriptionId ||
    Object.entries(q.target).some(([k, val]) => t[k] !== val) ||
    t.endsAt !== new Date(Date.parse(q.target.startsAt) + 3600000).toISOString() ||
    !Array.isArray(price.subServiceIds) ||
    price.subServiceIds.length !== 1 ||
    !price.subServiceIds.every(qcId) ||
    !qcDigest(price.catalogEvidenceSha256) ||
    price.participantCount !== 4 ||
    price.priceBasis !== 'WHOLE_COURT_WINDOW' ||
    price.currency !== 'RUB' ||
    !Number.isSafeInteger(price.courtWindowPriceMinor) ||
    Number(price.courtWindowPriceMinor) <= 0 ||
    Number(price.courtWindowPriceMinor) > 10000000 ||
    Number(price.courtWindowPriceMinor) % 4 ||
    price.quarterPriceMinor !== Number(price.courtWindowPriceMinor) / 4 ||
    !qcIso(p.observedAt) ||
    !qcIso(p.expiresAt) ||
    Date.parse(p.expiresAt) - Date.parse(p.observedAt) !== 60000 ||
    p.requestSha256 !== (await qcPrepareHash(q))
  )
    qcBad();
  const canonical = {
    schemaVersion: 1,
    nonBinding: true,
    operationId: p.operationId,
    requestSha256: p.requestSha256,
    idempotencyKeySha256: p.idempotencyKeySha256,
    actor: {
      tenantId: a.tenantId,
      userId: a.userId,
      providerClientId: a.providerClientId,
      providerMappingId: a.providerMappingId,
    },
    subscription: { id: s.id, providerClientSubscriptionId: s.providerClientSubscriptionId },
    target: {
      ...q.target,
      endsAt: t.endsAt,
      stationMappingId: t.stationMappingId,
      courtMappingId: t.courtMappingId,
      mappingVersion: t.mappingVersion,
      providerStationId: t.providerStationId,
      providerRoomId: t.providerRoomId,
    },
    pricing: {
      masterServiceId: price.masterServiceId,
      subServiceIds: price.subServiceIds,
      selectorRevision: price.selectorRevision,
      catalogEvidenceSha256: price.catalogEvidenceSha256,
      participantCount: 4,
      priceBasis: 'WHOLE_COURT_WINDOW',
      courtWindowPriceMinor: price.courtWindowPriceMinor,
      quarterPriceMinor: price.quarterPriceMinor,
      currency: 'RUB',
    },
    observedAt: p.observedAt,
    expiresAt: p.expiresAt,
  };
  if ((await qcHash('game-create-capsule:v1\0' + JSON.stringify(canonical))) !== p.sha256) qcBad();
  return { ...q, preparation: { ...canonical, sha256: p.sha256 } as QuarterCapsule };
}
export interface QuarterReceipt {
  schemaVersion: 1;
  operationId: string;
  admissionRequestSha256: string;
  actor: { tenantId: string; userId: string };
  target: QuarterTarget;
  providerExerciseId: string;
  providerBookingId: string;
  entitlement: {
    subscriptionInstanceId: string;
    policyVersion: number;
    policyDigest: string;
    usageOperationId: string;
    reservedUnits: 1;
  };
  confirmedAt: string;
}
export interface QuarterProviderRejection {
  schemaVersion: 1;
  outcome: 'REJECTED';
  operationId: string;
  admissionRequestSha256: string;
  actor: { tenantId: string; userId: string };
  target: QuarterTarget;
  reason: 'PROVIDER_REJECTED';
  providerStatusCode: number;
  providerRejectedAt: string;
  rejectedAt: string;
  entitlement: {
    subscriptionInstanceId: string;
    usageOperationId: string;
    operationState: 'FAILED';
    compensationState: 'APPLIED';
    releaseReason: 'PROVIDER_REJECTED';
    providerBookingId: null;
  };
}
export interface QuarterExpiredRejection {
  schemaVersion: 2;
  outcome: 'REJECTED';
  operationId: string;
  admissionRequestSha256: string;
  actor: { tenantId: string; userId: string };
  target: QuarterTarget;
  reason: 'PRECREATE_EXPIRED_NOT_DISPATCHED';
  abortId: string;
  capsuleExpiresAt: string;
  abortedAt: string;
  rejectedAt: string;
  entitlement: {
    subscriptionInstanceId: string;
    usageOperationId: string;
    operationState: 'FAILED';
    compensationState: 'APPLIED';
    releaseReason: 'PRECREATE_EXPIRED_NOT_DISPATCHED';
    providerBookingId: null;
  };
}
export type QuarterRejection = QuarterProviderRejection | QuarterExpiredRejection;
export async function parseQuarterReceipt(
  v: unknown,
  q: QuarterAdmission,
  rejected = false,
): Promise<QuarterReceipt | QuarterRejection> {
  const expired = rejected && qcObject(v).schemaVersion === 2;
  const r = qcExact(
    v,
    expired
      ? 'schemaVersion,outcome,operationId,admissionRequestSha256,actor,target,reason,abortId,capsuleExpiresAt,abortedAt,rejectedAt,entitlement'
      : rejected
        ? 'schemaVersion,outcome,operationId,admissionRequestSha256,actor,target,reason,providerStatusCode,providerRejectedAt,rejectedAt,entitlement'
        : 'schemaVersion,operationId,admissionRequestSha256,actor,target,providerExerciseId,providerBookingId,entitlement,confirmedAt',
  );
  const a = qcExact(r.actor, 'tenantId,userId');
  if (
    r.schemaVersion !== (expired ? 2 : 1) ||
    r.operationId !== q.preparation.operationId ||
    r.admissionRequestSha256 !== (await qcAdmissionHash(q)) ||
    a.tenantId !== q.preparation.actor.tenantId ||
    a.userId !== q.preparation.actor.userId ||
    !qcEqual(r.target, q.target)
  )
    qcBad();
  if (rejected) {
    const e = qcExact(
      r.entitlement,
      'subscriptionInstanceId,usageOperationId,operationState,compensationState,releaseReason,providerBookingId',
    );
    if (
      r.outcome !== 'REJECTED' ||
      r.reason !== (expired ? 'PRECREATE_EXPIRED_NOT_DISPATCHED' : 'PROVIDER_REJECTED') ||
      !(expired
        ? qcUuid(r.abortId) &&
          qcIso(r.capsuleExpiresAt) &&
          qcIso(r.abortedAt) &&
          r.capsuleExpiresAt === q.preparation.expiresAt &&
          Date.parse(r.capsuleExpiresAt) <= Date.parse(r.abortedAt) &&
          qcIso(r.rejectedAt) &&
          Date.parse(r.abortedAt) <= Date.parse(r.rejectedAt)
        : typeof r.providerStatusCode === 'number' &&
          [400, 401, 403, 404, 405, 410, 415, 422].includes(r.providerStatusCode) &&
          qcIso(r.providerRejectedAt) &&
          qcIso(r.rejectedAt) &&
          Date.parse(r.providerRejectedAt) <= Date.parse(r.rejectedAt)) ||
      !qcIso(r.rejectedAt) ||
      Date.parse(r.rejectedAt) > Date.now() ||
      ![e.subscriptionInstanceId, e.usageOperationId].every(qcId) ||
      e.operationState !== 'FAILED' ||
      e.compensationState !== 'APPLIED' ||
      e.releaseReason !== r.reason ||
      e.providerBookingId !== null
    )
      qcBad();
  } else {
    const e = qcExact(
      r.entitlement,
      'subscriptionInstanceId,policyVersion,policyDigest,usageOperationId,reservedUnits',
    );
    if (
      ![
        r.providerExerciseId,
        r.providerBookingId,
        e.subscriptionInstanceId,
        e.usageOperationId,
      ].every(qcId) ||
      !Number.isSafeInteger(e.policyVersion) ||
      Number(e.policyVersion) < 1 ||
      !qcDigest(e.policyDigest) ||
      e.reservedUnits !== 1 ||
      !qcIso(r.confirmedAt) ||
      Date.parse(r.confirmedAt) > Date.now()
    )
      qcBad();
  }
  return r as unknown as QuarterReceipt | QuarterRejection;
}
export interface QuarterOutcome {
  status: 'UNKNOWN' | 'CONFIRMED' | 'REJECTED';
  receipt: QuarterReceipt | QuarterRejection | null;
  registration: { status: 'CONFIRMED' | 'UNKNOWN'; asOf: string | null };
  reason: string | null;
}
export async function parseQuarterOutcome(
  v: unknown,
  q: QuarterAdmission,
): Promise<QuarterOutcome> {
  const raw = qcObject(v);
  if (Object.hasOwn(raw, 'status')) {
    const r = qcExact(v, 'contractVersion,operationId,status,asOf,reason');
    if (
      r.contractVersion !== 1 ||
      r.operationId !== q.preparation.operationId ||
      r.status !== 'UNKNOWN' ||
      r.asOf !== null ||
      !qcId(r.reason)
    )
      qcBad();
    return {
      status: 'UNKNOWN',
      receipt: null,
      registration: { status: 'UNKNOWN', asOf: null },
      reason: r.reason as string,
    };
  }
  const r = qcExact(v, 'contractVersion,operationId,operation,registration'),
    o = qcObject(r.operation),
    g = qcExact(r.registration, 'status,asOf');
  if (
    r.contractVersion !== 1 ||
    r.operationId !== q.preparation.operationId ||
    typeof o.status !== 'string' ||
    !['UNKNOWN', 'CONFIRMED', 'REJECTED'].includes(o.status) ||
    typeof g.status !== 'string' ||
    !['UNKNOWN', 'CONFIRMED'].includes(g.status) ||
    (g.asOf !== null && (!qcIso(g.asOf) || Date.parse(g.asOf) > Date.now())) ||
    (g.status === 'CONFIRMED' && g.asOf === null)
  )
    qcBad();
  qcExact(o, o.status === 'UNKNOWN' ? 'status,receipt,reason' : 'status,receipt');
  if (o.status === 'UNKNOWN' && (o.receipt !== null || !qcId(o.reason) || g.status !== 'UNKNOWN'))
    qcBad();
  const receipt =
    o.status === 'UNKNOWN'
      ? null
      : await parseQuarterReceipt(o.receipt, q, o.status === 'REJECTED');
  if (o.status === 'REJECTED' && (g.status !== 'UNKNOWN' || g.asOf !== null)) qcBad();
  if (
    receipt &&
    'confirmedAt' in receipt &&
    g.asOf !== null &&
    Date.parse(receipt.confirmedAt) > Date.parse(g.asOf as string)
  )
    qcBad();
  return {
    status: o.status as QuarterOutcome['status'],
    receipt,
    registration: g as QuarterOutcome['registration'],
    reason: o.status === 'UNKNOWN' ? (o.reason as string) : null,
  };
}
