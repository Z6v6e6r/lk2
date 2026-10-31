/** Private owner wire. Never return capsules or receipts from a public API. */
export class TrainingRegistrationError extends Error {
  constructor(
    public readonly code = 'TRAINING_REGISTRATION_UNAVAILABLE',
    public readonly status = 503,
  ) {
    super(code);
  }
}
const bad = (): never => {
  throw new TrainingRegistrationError('TRAINING_REGISTRATION_EVIDENCE_INVALID');
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad();
const exact = (v: unknown, names: string): Record<string, unknown> => {
  const r = object(v);
  if (Object.keys(r).sort().join() !== names.split(',').sort().join()) bad();
  return r;
};
export const trainingUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const trainingPrivateId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(v) && !/[\r\n]/.test(v);
export const trainingDigest = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 71 && /^sha256:[a-f0-9]{64}$/.test(v);
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const trainingDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export async function trainingHash(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}
async function hashUuid(value: string, version: '4' | '8'): Promise<string> {
  const chars = (await trainingHash(value)).slice(7, 39).split('');
  chars[12] = version;
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export const trainingOperationId = (
  tenantId: string,
  userId: string,
  keySha256: string,
): Promise<string> =>
  hashUuid(`booked-operation-admission:v1\0lk2-api\0${tenantId}\0${userId}\0${keySha256}`, '8');
export interface TrainingRequest {
  contractVersion: 1;
  action: 'BOOK_GROUP_TRAINING';
  target: { id: string; dateHint: string };
  subscriptionId: string;
  paymentIntent: 'USE_SUBSCRIPTION';
}
export interface TrainingTarget {
  id: string;
  dateHint: string;
  providerExerciseId: string;
  providerStudioId: string;
  providerRoomId: string;
  providerTypeId: number;
  providerDirectionId: number;
  category: 'GROUP_TRAINING';
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  capacity: number;
  fingerprint: string;
}
export interface TrainingCapsule {
  schemaVersion: 1;
  operationId: string;
  actor: { tenantId: string; userId: string; providerClientId: string; providerMappingId: string };
  subscription: { id: string; providerClientSubscriptionId: string };
  target: TrainingTarget;
  selection: {
    management: 'LEGACY';
    authority: 'LK1_SUBSCRIPTION';
    cupSelection: 'EXPLICIT_UNMANAGED';
    lk1Selection: 'LEGACY' | 'UNMATCHED';
    chargeMode: 'SUBSCRIPTION_ONLY';
  };
  observedAt: string;
  expiresAt: string;
  sha256: string;
}
export interface TrainingAdmission extends TrainingRequest {
  preparation: TrainingCapsule;
}
export interface TrainingReceipt {
  contractVersion: 1;
  receiptId: string;
  authority: 'LK1_SUBSCRIPTION';
  operationId: string;
  action: 'BOOK_GROUP_TRAINING';
  tenantId: string;
  userId: string;
  subscriptionId: string;
  trainingId: string;
  targetFingerprint: string;
  requestSha256: string;
  preparationSha256: string;
  provider: 'VIVA';
  providerClientId: string;
  providerMappingId: string;
  providerClientSubscriptionId: string;
  providerExerciseId: string;
  providerBookingId: string;
  chargeMode: 'SUBSCRIPTION_ONLY';
  confirmedAt: string;
}
export interface TrainingAuthority {
  request: TrainingAdmission;
  keySha256: string;
  requestSha256: string;
  issuer: string;
  audience: string;
  bindingSha256: string;
}
export function parseTrainingRequest(v: unknown): TrainingRequest {
  const r = exact(v, 'contractVersion,action,target,subscriptionId,paymentIntent'),
    t = exact(r.target, 'id,dateHint');
  if (
    r.contractVersion !== 1 ||
    r.action !== 'BOOK_GROUP_TRAINING' ||
    r.paymentIntent !== 'USE_SUBSCRIPTION' ||
    !trainingUuid(r.subscriptionId) ||
    !trainingUuid(t.id) ||
    !trainingDate(t.dateHint)
  )
    return bad();
  return {
    contractVersion: 1,
    action: 'BOOK_GROUP_TRAINING',
    target: { id: t.id, dateHint: t.dateHint },
    subscriptionId: r.subscriptionId,
    paymentIntent: 'USE_SUBSCRIPTION',
  };
}
export async function parseTrainingCapsule(v: unknown): Promise<TrainingCapsule> {
  const c = exact(
    v,
    'schemaVersion,operationId,actor,subscription,target,selection,observedAt,expiresAt,sha256',
  );
  const a = exact(c.actor, 'tenantId,userId,providerClientId,providerMappingId'),
    s = exact(c.subscription, 'id,providerClientSubscriptionId'),
    t = exact(
      c.target,
      'id,dateHint,providerExerciseId,providerStudioId,providerRoomId,providerTypeId,providerDirectionId,category,startsAt,endsAt,durationMinutes,capacity,fingerprint',
    ),
    selection = exact(c.selection, 'management,authority,cupSelection,lk1Selection,chargeMode');
  if (
    c.schemaVersion !== 1 ||
    !trainingUuid(c.operationId) ||
    ![a.tenantId, a.userId, a.providerMappingId, s.id, t.id].every(trainingUuid) ||
    ![
      a.providerClientId,
      s.providerClientSubscriptionId,
      t.providerExerciseId,
      t.providerStudioId,
      t.providerRoomId,
    ].every(trainingPrivateId) ||
    !trainingDate(t.dateHint) ||
    ![t.providerTypeId, t.providerDirectionId, t.durationMinutes, t.capacity].every(positive) ||
    Number(t.durationMinutes) > 1440 ||
    Number(t.capacity) > 1000 ||
    t.category !== 'GROUP_TRAINING' ||
    !iso(t.startsAt) ||
    !iso(t.endsAt) ||
    Date.parse(t.endsAt) - Date.parse(t.startsAt) !== Number(t.durationMinutes) * 60000 ||
    new Date(Date.parse(t.startsAt) + 10800000).toISOString().slice(0, 10) !== t.dateHint ||
    !trainingDigest(t.fingerprint) ||
    !iso(c.observedAt) ||
    !iso(c.expiresAt) ||
    Date.parse(c.expiresAt) - Date.parse(c.observedAt) !== 60000 ||
    !trainingDigest(c.sha256) ||
    selection.management !== 'LEGACY' ||
    selection.authority !== 'LK1_SUBSCRIPTION' ||
    selection.cupSelection !== 'EXPLICIT_UNMANAGED' ||
    !['LEGACY', 'UNMATCHED'].includes(String(selection.lk1Selection)) ||
    selection.chargeMode !== 'SUBSCRIPTION_ONLY'
  )
    return bad();
  const target = {
    id: t.id,
    dateHint: t.dateHint,
    providerExerciseId: t.providerExerciseId,
    providerStudioId: t.providerStudioId,
    providerRoomId: t.providerRoomId,
    providerTypeId: t.providerTypeId,
    providerDirectionId: t.providerDirectionId,
    category: t.category,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    durationMinutes: t.durationMinutes,
    capacity: t.capacity,
  };
  if (
    (await hashUuid('phub-viva-exercise-v1:exercise:' + String(t.providerExerciseId), '4')) !==
      t.id ||
    (await trainingHash('training-registration-target:v1\0' + JSON.stringify(target))) !==
      t.fingerprint
  )
    return bad();
  const core = {
    schemaVersion: 1,
    operationId: c.operationId,
    actor: {
      tenantId: a.tenantId,
      userId: a.userId,
      providerClientId: a.providerClientId,
      providerMappingId: a.providerMappingId,
    },
    subscription: { id: s.id, providerClientSubscriptionId: s.providerClientSubscriptionId },
    target: { ...target, fingerprint: t.fingerprint },
    selection: {
      management: selection.management,
      authority: selection.authority,
      cupSelection: selection.cupSelection,
      lk1Selection: selection.lk1Selection,
      chargeMode: selection.chargeMode,
    },
    observedAt: c.observedAt,
    expiresAt: c.expiresAt,
  };
  if (
    (await trainingHash('training-registration-capsule:v1\0' + JSON.stringify(core))) !== c.sha256
  )
    return bad();
  return { ...core, sha256: c.sha256 } as TrainingCapsule;
}
export async function parseTrainingAdmission(v: unknown): Promise<TrainingAdmission> {
  const r = exact(v, 'contractVersion,action,target,subscriptionId,paymentIntent,preparation');
  const q = parseTrainingRequest({
    contractVersion: r.contractVersion,
    action: r.action,
    target: r.target,
    subscriptionId: r.subscriptionId,
    paymentIntent: r.paymentIntent,
  });
  const p = await parseTrainingCapsule(r.preparation);
  if (
    p.target.id !== q.target.id ||
    p.target.dateHint !== q.target.dateHint ||
    p.subscription.id !== q.subscriptionId
  )
    return bad();
  return { ...q, preparation: p };
}
export const trainingRequestHash = (q: TrainingRequest | TrainingAdmission): Promise<string> =>
  trainingHash(
    ('preparation' in q
      ? 'training-registration-admission:v1\0'
      : 'training-registration-prepare:v1\0') + JSON.stringify(q),
  );
export async function trainingBinding(
  a: Omit<TrainingAuthority, 'bindingSha256'>,
): Promise<string> {
  const p = a.request.preparation;
  return trainingHash(
    'training-registration-binding:v1\0' +
      JSON.stringify([
        a.issuer,
        a.audience,
        'lk2-api',
        p.actor.tenantId,
        'iSkq6G',
        p.actor.userId,
        'VIVA',
        p.actor.providerClientId,
        p.actor.providerMappingId,
        p.subscription.id,
        p.subscription.providerClientSubscriptionId,
        p.operationId,
        a.keySha256,
        p.target.id,
        p.target.dateHint,
        a.requestSha256,
      ]),
  );
}
export async function parseTrainingAuthority(v: unknown): Promise<TrainingAuthority> {
  const a = exact(v, 'request,keySha256,requestSha256,issuer,audience,bindingSha256');
  const request = await parseTrainingAdmission(a.request);
  if (
    !trainingDigest(a.keySha256) ||
    !trainingDigest(a.requestSha256) ||
    !trainingDigest(a.bindingSha256) ||
    typeof a.issuer !== 'string' ||
    typeof a.audience !== 'string' ||
    !a.issuer ||
    !a.audience
  )
    return bad();
  const result = {
    request,
    keySha256: a.keySha256,
    requestSha256: a.requestSha256,
    issuer: a.issuer,
    audience: a.audience,
    bindingSha256: a.bindingSha256,
  };
  if (
    (await trainingRequestHash(request)) !== a.requestSha256 ||
    (await trainingBinding(result)) !== a.bindingSha256 ||
    (await trainingOperationId(
      request.preparation.actor.tenantId,
      request.preparation.actor.userId,
      a.keySha256,
    )) !== request.preparation.operationId
  )
    return bad();
  return result;
}
export async function parseTrainingReceipt(
  v: unknown,
  authority: TrainingAuthority,
): Promise<TrainingReceipt> {
  const a = await parseTrainingAuthority(authority),
    p = a.request.preparation,
    r = exact(
      v,
      'contractVersion,receiptId,authority,operationId,action,tenantId,userId,subscriptionId,trainingId,targetFingerprint,requestSha256,preparationSha256,provider,providerClientId,providerMappingId,providerClientSubscriptionId,providerExerciseId,providerBookingId,chargeMode,confirmedAt',
    );
  const expected = {
    contractVersion: 1,
    authority: 'LK1_SUBSCRIPTION',
    operationId: p.operationId,
    action: 'BOOK_GROUP_TRAINING',
    tenantId: p.actor.tenantId,
    userId: p.actor.userId,
    subscriptionId: p.subscription.id,
    trainingId: p.target.id,
    targetFingerprint: p.target.fingerprint,
    requestSha256: a.requestSha256,
    preparationSha256: p.sha256,
    provider: 'VIVA',
    providerClientId: p.actor.providerClientId,
    providerMappingId: p.actor.providerMappingId,
    providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
    providerExerciseId: p.target.providerExerciseId,
    chargeMode: 'SUBSCRIPTION_ONLY',
  };
  if (
    Object.entries(expected).some(([k, value]) => r[k] !== value) ||
    !trainingPrivateId(r.providerBookingId) ||
    !iso(r.confirmedAt) ||
    Date.parse(r.confirmedAt) < Date.parse(p.observedAt) ||
    !trainingUuid(r.receiptId)
  )
    return bad();
  if (
    r.receiptId !==
    (await hashUuid(
      'training-registration-receipt:v1\0' +
        p.actor.tenantId +
        '\0' +
        p.actor.userId +
        '\0' +
        p.operationId +
        '\0' +
        a.requestSha256 +
        '\0' +
        r.providerBookingId,
      '8',
    ))
  )
    return bad();
  return {
    contractVersion: 1,
    receiptId: r.receiptId,
    authority: 'LK1_SUBSCRIPTION',
    operationId: p.operationId,
    action: 'BOOK_GROUP_TRAINING',
    tenantId: p.actor.tenantId,
    userId: p.actor.userId,
    subscriptionId: p.subscription.id,
    trainingId: p.target.id,
    targetFingerprint: p.target.fingerprint,
    requestSha256: a.requestSha256,
    preparationSha256: p.sha256,
    provider: 'VIVA',
    providerClientId: p.actor.providerClientId,
    providerMappingId: p.actor.providerMappingId,
    providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
    providerExerciseId: p.target.providerExerciseId,
    providerBookingId: r.providerBookingId,
    chargeMode: 'SUBSCRIPTION_ONLY',
    confirmedAt: r.confirmedAt,
  };
}
