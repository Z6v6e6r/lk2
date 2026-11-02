import { randomUUID } from 'node:crypto';
import type { StationMessageNotificationRepository } from '@phub/database/station-message-notifications';
import {
  verifyStationSource,
  type StationSource,
  type StationFactRow,
  type StationRecipientRow,
} from '@phub/database/station-message-notifications';
import type { StationNotificationClient } from './station-notification-client.js';
import { projectStationRecipient, type StationProvider } from './station-notification-projector.js';
export const stationScope = (s: StationSource) => ({
  contractVersion: 1 as const,
  requestId: randomUUID(),
  communityId: s.private_community_id,
  incarnationHash: s.incarnation_hash,
  streamId: s.stream_id,
});
export const stationFact = (f: StationFactRow) => ({
  messageId: f.message_id,
  sequence: Number(f.sequence),
  authorPlayerId: f.author_player_id,
  proofHash: f.proof_hash,
});
export const stationRecipient = (p: StationRecipientRow) => ({
  playerId: p.player_id,
  membershipEpoch: Number(p.membership_epoch),
  baselineSequence: Number(p.baseline_sequence),
  readThroughSequence: Number(p.read_through_sequence),
});
export async function runStationImportCycle(
  repo: StationMessageNotificationRepository,
  owner: StationNotificationClient,
  tenantId: string,
  providers: readonly StationProvider[],
) {
  const outcomes = { source: 'IDLE', fanout: 'IDLE', recipient: 'IDLE' };
  const s = await repo.claimSource(tenantId);
  if (s)
    try {
      await repo.tx(tenantId, (c) => verifyStationSource(c, s));
      const p = await owner.read('publications', {
        ...stationScope(s),
        afterSequence: Number(s.after_sequence),
        throughSequence: s.through_sequence === null ? null : Number(s.through_sequence),
        limit: 50,
      });
      outcomes.source = (await repo.storePage(s, p.value)) ? 'STORED' : 'STALE';
    } catch {
      outcomes.source = 'HELD';
      await repo.hold(tenantId, 'source', s.id, s.lease_token);
    }
  const f = await repo.claimFact(tenantId);
  if (f)
    try {
      await repo.tx(tenantId, (c) => verifyStationSource(c, f));
      const p = await owner.read('recipients', {
        ...stationScope(f),
        fact: stationFact(f),
        afterPlayerId: f.after_player_id,
        limit: 50,
      });
      outcomes.fanout = (await repo.storeRecipients(f, p.value)) ? 'STORED' : 'STALE';
    } catch {
      outcomes.fanout = 'HELD';
      await repo.hold(tenantId, 'fact', f.fact_id, f.fact_lease_token);
    }
  const r = await repo.claimRecipient(tenantId);
  if (r)
    try {
      await repo.tx(tenantId, (c) => verifyStationSource(c, r));
      const p = await owner.read('eligibility', {
        ...stationScope(r),
        fact: stationFact(r),
        recipient: stationRecipient(r),
      });
      outcomes.recipient = await projectStationRecipient(
        repo,
        r,
        p.value.outcome === 'ALLOW',
        p.fresh,
        providers,
      );
    } catch {
      outcomes.recipient = 'HELD';
      await repo.hold(tenantId, 'recipient', r.context_id, r.recipient_lease_token);
    }
  return outcomes;
}
