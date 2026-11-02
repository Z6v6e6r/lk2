import {
  quarterStationActor,
  quarterStationIntent,
  quarterStationRequest,
  type QuarterStationMarker,
} from './quarter-create-station-membership.js';
import { stationAdmissionId } from './station-membership.js';
import type { QuarterAdmission } from '@phub/domain/quarter-create';
export async function quarterStationFixture(
  q: QuarterAdmission,
  blocked = false,
): Promise<Extract<QuarterStationMarker, { outcome: 'OWNER_ADMISSION' }>> {
  const intent = await quarterStationIntent(q),
    actor = quarterStationActor(q),
    request = await quarterStationRequest(q);
  return {
    ...intent,
    outcome: 'OWNER_ADMISSION',
    actor,
    request,
    response: {
      contractVersion: 1,
      operationId: request.operationId,
      replayed: false,
      admission: {
        outcome: blocked ? 'NO_ENROLLMENT' : 'ADMITTED',
        admissionId: stationAdmissionId(actor.tenantId, request.operationId),
        communityId: 'synthetic-community',
        membershipEpoch: 7,
        reason: blocked ? 'MEMBERSHIP_BLOCKED' : 'ELIGIBLE',
        bindingSha256: 'sha256:' + 'e'.repeat(64),
      },
    },
  };
}
