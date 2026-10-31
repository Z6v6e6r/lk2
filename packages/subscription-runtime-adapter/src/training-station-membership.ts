import {
  parseTrainingAuthority,
  trainingHash,
  type TrainingAuthority,
} from '@phub/domain/training-registration';
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

export type TrainingStationMarker =
  | { version: 1; outcome: 'PENDING_ADMISSION' }
  | { version: 1; outcome: 'INTENT'; authority: TrainingAuthority }
  | { version: 1; outcome: 'NO_ENROLLMENT'; reason: 'DISABLED' | 'OWNER_UNAVAILABLE' }
  | {
      version: 1;
      outcome: 'OWNER_ADMISSION';
      actor: StationActor;
      request: StationAdmissionRequest;
      response: StationAdmissionResponse;
      authoritySha256: string;
    };

export function trainingStationRequest(authority: TrainingAuthority): StationAdmissionRequest {
  const p = authority.request.preparation;
  return parseStationRequest(
    {
      contractVersion: 1,
      operationId: p.operationId,
      requestSha256: authority.requestSha256,
      activity: { kind: 'TRAINING', id: p.target.id },
      stationId: p.target.providerStudioId,
    },
    'admission',
  ) as StationAdmissionRequest;
}
export function trainingStationActor(authority: TrainingAuthority): StationActor {
  const a = authority.request.preparation.actor;
  return parseStationActor({
    tenantId: a.tenantId,
    canonicalUserId: a.userId,
    playerId: a.providerClientId,
    providerMappingId: a.providerMappingId,
  });
}
export async function parseTrainingStationMarker(raw: unknown): Promise<TrainingStationMarker> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StationMembershipError();
  const x = structuredClone(raw) as Record<string, unknown>;
  const keys = (...names: string[]) => Object.keys(x).sort().join(',') === names.sort().join(',');
  if (x.version !== 1) throw new StationMembershipError();
  switch (x.outcome) {
    case 'PENDING_ADMISSION':
      if (!keys('version', 'outcome')) throw new StationMembershipError();
      break;
    case 'INTENT':
      if (!keys('version', 'outcome', 'authority')) throw new StationMembershipError();
      x.authority = await parseTrainingAuthority(x.authority);
      break;
    case 'NO_ENROLLMENT':
      if (
        !keys('version', 'outcome', 'reason') ||
        !['DISABLED', 'OWNER_UNAVAILABLE'].includes(String(x.reason))
      )
        throw new StationMembershipError();
      break;
    case 'OWNER_ADMISSION': {
      if (
        !keys('version', 'outcome', 'actor', 'request', 'response', 'authoritySha256') ||
        typeof x.authoritySha256 !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(x.authoritySha256)
      )
        throw new StationMembershipError();
      const actor = parseStationActor(x.actor),
        request = parseStationRequest(x.request, 'admission') as StationAdmissionRequest;
      if (request.activity.kind !== 'TRAINING') throw new StationMembershipError();
      parseStationAdmissionResponse(x.response, actor, request);
      break;
    }
    default:
      throw new StationMembershipError();
  }
  if (Buffer.byteLength(stationCanonical(x)) > 32768) throw new StationMembershipError();
  return structuredClone(x) as unknown as TrainingStationMarker;
}
export async function verifyTrainingStationMarker(
  marker: TrainingStationMarker,
  authority: TrainingAuthority,
): Promise<void> {
  if (
    marker.outcome === 'INTENT' &&
    stationCanonical(marker.authority) !== stationCanonical(authority)
  )
    throw new StationMembershipError();
  if (
    marker.outcome === 'OWNER_ADMISSION' &&
    (marker.authoritySha256 !== (await trainingHash(JSON.stringify(authority))) ||
      stationCanonical(marker.actor) !== stationCanonical(trainingStationActor(authority)) ||
      stationCanonical(marker.request) !== stationCanonical(trainingStationRequest(authority)))
  )
    throw new StationMembershipError();
}
