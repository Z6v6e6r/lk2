import {
  verifyTournamentSource,
  tournamentBinding,
  tournamentPublication,
  tournamentCandidate,
  type TournamentMessageNotificationRepository,
} from '@phub/database/tournament-message-notifications';
import type { TournamentNotificationOwnerClient } from './tournament-chat-notification-owner.js';
import {
  projectTournamentRecipient,
  type TournamentProvider,
} from './tournament-notification-projector.js';
/** One bounded publication page, one candidate page and one projection per cycle. */
export async function runTournamentImportCycle(
  repo: TournamentMessageNotificationRepository,
  owner: TournamentNotificationOwnerClient,
  tenantId: string,
  providers: readonly TournamentProvider[],
) {
  const outcomes = { source: 'IDLE', fanout: 'IDLE', recipient: 'IDLE' };
  const s = await repo.claimSource(tenantId);
  if (s)
    try {
      await repo.tx(tenantId, (c) => verifyTournamentSource(c, s));
      const page = await owner.publications({
        ...tournamentBinding(s),
        afterSequence: Number(s.after_sequence),
        throughSequence: s.through_sequence === null ? null : Number(s.through_sequence),
        limit: 50,
      });
      outcomes.source = (await repo.storePage(s, page)) ? 'STORED' : 'STALE';
    } catch {
      outcomes.source = 'HELD';
      await repo.hold(tenantId, 'source', s.id, s.lease_token);
    }
  const f = await repo.claimFact(tenantId);
  if (f)
    try {
      await repo.tx(tenantId, (c) => verifyTournamentSource(c, f));
      const page = await owner.recipients(tournamentPublication(f), 50, f.recipient_cursor);
      outcomes.fanout = (await repo.storeRecipients(f, page)) ? 'STORED' : 'STALE';
    } catch {
      outcomes.fanout = 'HELD';
      // Restart the bounded read scan without removing durable contexts or advancing completion.
      // Auth failures still stay held; no page/partial receipt can acknowledge the source watermark.
      if (f.recipient_cursor !== null) await repo.restartFact(f);
      else await repo.hold(tenantId, 'fact', f.fact_id, f.fact_lease_token);
    }
  const p = await repo.claimRecipient(tenantId);
  if (p)
    try {
      await repo.tx(tenantId, (c) => verifyTournamentSource(c, p));
      const proof = await owner.eligibilityWithIdentity(
        tournamentPublication(p),
        tournamentCandidate(p),
      );
      outcomes.recipient = await projectTournamentRecipient(repo, p, proof, providers);
    } catch {
      outcomes.recipient = 'HELD';
      await repo.hold(tenantId, 'recipient', p.context_id, p.recipient_lease_token);
    }
  return outcomes;
}
