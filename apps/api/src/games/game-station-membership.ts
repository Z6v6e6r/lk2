import {
  createStationMembershipTransport,
  type StationTransportConfig,
} from '@phub/subscription-runtime-adapter';
import { createStationMembershipRepository } from '../../../../packages/database/src/station-membership-repository.js';
import type { Pool } from 'pg';
import type { CommercialJoinDependencies } from './game-commercial-join.js';

export function createGameStationMembershipAdmission(options: {
  config: StationTransportConfig;
  pool: Pool;
  onMetric?: (outcome: 'success' | 'unavailable' | 'circuit_open') => void;
}): CommercialJoinDependencies['stationMembership'] {
  const transport = createStationMembershipTransport(options.config, options.onMetric);
  if (!transport) return undefined;
  const repository = createStationMembershipRepository(options.pool);
  return async ({ command, providerBinding }) => {
    const location = await repository.resolveLocation({
      tenantId: command.tenantId,
      gameId: command.gameId,
      expectedRevision: command.expectedRevision,
      providerBinding,
    });
    if (!location)
      return { version: 1, outcome: 'NO_ENROLLMENT', reason: 'STATION_BINDING_UNAVAILABLE' };
    const actor = {
      tenantId: command.tenantId,
      canonicalUserId: command.userId,
      playerId: providerBinding.providerClientId,
      providerMappingId: providerBinding.providerMappingId,
    };
    const request = {
      contractVersion: 1 as const,
      operationId: command.operationId,
      requestSha256: command.requestHash.startsWith('sha256:')
        ? command.requestHash
        : 'sha256:' + command.requestHash,
      activity: { kind: 'GAME' as const, id: command.gameId },
      stationId: location.providerStationId,
    };
    const delegation = transport.signer.issue({
      mode: 'admission',
      actor,
      request,
      sessionId: command.sessionId,
      correlationId: command.correlationId,
    });
    const response = await transport.client.admit(request, actor, {
      delegation,
      correlationId: command.correlationId,
    });
    return { version: 1, outcome: 'OWNER_ADMISSION', actor, request, response, location };
  };
}
