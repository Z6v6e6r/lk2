import raw from './fixtures/training-registration-v1-contract.json' with { type: 'json' };
import {
  trainingHash,
  trainingOperationId,
  trainingRequestHash,
  trainingBinding,
  parseTrainingAdmission,
  parseTrainingAuthority,
  parseTrainingReceipt,
  type TrainingAuthority,
} from '@phub/domain/training-registration';
export const trainingFixture = raw;
export async function trainingAuthorityFixture(
  options: { tenantId?: string; userId?: string; key?: string; observedAt?: string } = {},
): Promise<TrainingAuthority> {
  const q = structuredClone(raw.requests.admit),
    p = q.preparation;
  p.actor.tenantId = options.tenantId ?? p.actor.tenantId;
  p.actor.userId = options.userId ?? p.actor.userId;
  const keySha256 = await trainingHash(options.key ?? raw.ids.idempotencyKey);
  p.operationId = await trainingOperationId(p.actor.tenantId, p.actor.userId, keySha256);
  p.observedAt = options.observedAt ?? p.observedAt;
  p.expiresAt = new Date(Date.parse(p.observedAt) + 60000).toISOString();
  const core = { ...p };
  delete (core as Partial<typeof p>).sha256;
  p.sha256 = await trainingHash('training-registration-capsule:v1\0' + JSON.stringify(core));
  const request = await parseTrainingAdmission(q),
    base = {
      request,
      keySha256,
      requestSha256: await trainingRequestHash(request),
      issuer: raw.claims.admit.iss,
      audience: raw.claims.admit.aud,
    };
  return parseTrainingAuthority({ ...base, bindingSha256: await trainingBinding(base) });
}
export async function trainingReceiptFixture(
  a: TrainingAuthority,
  confirmedAt = raw.responses.confirmed.receipt.confirmedAt,
) {
  const p = a.request.preparation;
  const chars = (
    await trainingHash(
      'training-registration-receipt:v1\0' +
        p.actor.tenantId +
        '\0' +
        p.actor.userId +
        '\0' +
        p.operationId +
        '\0' +
        a.requestSha256 +
        '\0' +
        raw.responses.confirmed.receipt.providerBookingId,
    )
  )
    .slice(7, 39)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const h = chars.join(''),
    receiptId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return parseTrainingReceipt(
    {
      ...raw.responses.confirmed.receipt,
      receiptId,
      operationId: p.operationId,
      tenantId: p.actor.tenantId,
      userId: p.actor.userId,
      preparationSha256: p.sha256,
      requestSha256: a.requestSha256,
      confirmedAt,
    },
    a,
  );
}
