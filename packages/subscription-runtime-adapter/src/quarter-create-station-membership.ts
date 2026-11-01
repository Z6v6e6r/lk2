import {
  parseQuarterAdmission,
  parseQuarterReceipt,
  qcAdmissionHash,
  qcHash,
  qcEqual,
  qcUuid,
  type QuarterAdmission,
  type QuarterReceipt,
} from '@phub/domain/quarter-create';
import {
  parseStationActor,
  parseStationRequest,
  parseStationAdmissionResponse,
  stationCanonical,
  StationMembershipError,
  type StationActor,
  type StationAdmissionRequest,
  type StationAdmissionResponse,
} from './station-membership.js';
interface Pinned {
  version: 1;
  admission: QuarterAdmission;
  admissionSha256: string;
}
interface Settled extends Pinned {
  actor: StationActor;
  request: StationAdmissionRequest;
  response: StationAdmissionResponse;
}
export type QuarterStationMarker =
  | { version: 1; outcome: 'PENDING_ADMISSION' }
  | (Pinned & { outcome: 'INTENT' })
  | (Settled & { outcome: 'OWNER_ADMISSION' })
  | (Settled & { outcome: 'CONFIRMED_FACT'; receiptSha256: string; generationId: string });
export function quarterStationActor(q: QuarterAdmission): StationActor {
  const a = q.preparation.actor;
  return parseStationActor({
    tenantId: a.tenantId,
    canonicalUserId: a.userId,
    playerId: a.providerClientId,
    providerMappingId: a.providerMappingId,
  });
}
export async function quarterStationRequest(q: QuarterAdmission): Promise<StationAdmissionRequest> {
  return parseStationRequest(
    {
      contractVersion: 1,
      operationId: q.preparation.operationId,
      requestSha256: await qcAdmissionHash(q),
      activity: { kind: 'GAME_CREATE', id: q.target.draftId },
      stationId: q.preparation.target.providerStationId,
    },
    'admission',
  ) as StationAdmissionRequest;
}
export async function quarterStationGeneration(
  q: QuarterAdmission,
  raw: QuarterReceipt,
): Promise<string> {
  const r = (await parseQuarterReceipt(raw, q, false)) as QuarterReceipt;
  // Deliberately excludes operation/key/capsule timestamps: one original booking is one generation.
  const hash = await qcHash(
    'station-quarter-create-generation:v1\0' +
      stationCanonical({
        tenantId: q.preparation.actor.tenantId,
        providerClientId: q.preparation.actor.providerClientId,
        providerExerciseId: r.providerExerciseId,
        providerBookingId: r.providerBookingId,
      }),
  );
  const chars = hash.slice(7, 39).split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function quarterStationIntent(
  raw: QuarterAdmission,
): Promise<Extract<QuarterStationMarker, { outcome: 'INTENT' }>> {
  const admission = await parseQuarterAdmission(raw);
  return {
    version: 1,
    outcome: 'INTENT',
    admission,
    admissionSha256: await qcAdmissionHash(admission),
  };
}
export async function parseQuarterStationMarker(
  raw: unknown,
  receipt?: unknown,
): Promise<QuarterStationMarker> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StationMembershipError();
  const x = structuredClone(raw) as Record<string, unknown>;
  const exact = (names: string) => Object.keys(x).sort().join() === names.split(',').sort().join();
  if (x.version !== 1) throw new StationMembershipError();
  if (x.outcome === 'PENDING_ADMISSION') {
    if (!exact('version,outcome')) throw new StationMembershipError();
    return { version: 1, outcome: 'PENDING_ADMISSION' };
  }
  if (
    !['INTENT', 'OWNER_ADMISSION', 'CONFIRMED_FACT'].includes(
      typeof x.outcome === 'string' ? x.outcome : '',
    )
  )
    throw new StationMembershipError();
  if (
    !exact(
      'version,outcome,admission,admissionSha256' +
        (x.outcome === 'INTENT' ? '' : ',actor,request,response') +
        (x.outcome === 'CONFIRMED_FACT' ? ',receiptSha256,generationId' : ''),
    )
  )
    throw new StationMembershipError();
  const q = await parseQuarterAdmission(x.admission);
  if (x.admissionSha256 !== (await qcAdmissionHash(q))) throw new StationMembershipError();
  if (x.outcome !== 'INTENT') {
    const actor = quarterStationActor(q),
      request = await quarterStationRequest(q);
    if (!qcEqual(x.actor, actor) || !qcEqual(x.request, request))
      throw new StationMembershipError();
    parseStationAdmissionResponse(x.response, actor, request);
  }
  if (x.outcome === 'CONFIRMED_FACT') {
    const r = (await parseQuarterReceipt(receipt, q, false)) as QuarterReceipt;
    if (
      !qcUuid(x.generationId) ||
      x.generationId !== (await quarterStationGeneration(q, r)) ||
      x.receiptSha256 !== (await qcHash(stationCanonical(r)))
    )
      throw new StationMembershipError();
  }
  if (Buffer.byteLength(stationCanonical(x)) > 32768) throw new StationMembershipError();
  // JSONB may reorder nested keys. Keep the verified canonical admission representation
  // used by the original order-sensitive owner hash; never regenerate its authority/hash.
  return { ...x, admission: q } as unknown as QuarterStationMarker;
}
export async function quarterStationConfirmed(
  marker: Extract<QuarterStationMarker, { outcome: 'OWNER_ADMISSION' }>,
  receipt: QuarterReceipt,
): Promise<Extract<QuarterStationMarker, { outcome: 'CONFIRMED_FACT' }>> {
  return (await parseQuarterStationMarker(
    {
      ...marker,
      outcome: 'CONFIRMED_FACT',
      receiptSha256: await qcHash(stationCanonical(receipt)),
      generationId: await quarterStationGeneration(marker.admission, receipt),
    },
    receipt,
  )) as Extract<QuarterStationMarker, { outcome: 'CONFIRMED_FACT' }>;
}
