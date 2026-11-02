import { describe, expect, it, vi } from 'vitest';
import { runTournamentImportCycle } from './tournament-notification-importer.js';
import type { TournamentMessageNotificationRepository } from '@phub/database/tournament-message-notifications';
import type { TournamentNotificationOwnerClient } from './tournament-chat-notification-owner.js';
const source = {
  tenant_id: 'tenant',
  id: 'source',
  tournament_id: 'tournament',
  incarnation_hash: 'hash',
  stream_id: 'stream',
  after_sequence: '10',
  through_sequence: '20',
  lease_token: 'source-lease',
};
const fact = {
  ...source,
  fact_id: 'fact',
  sequence: '11',
  message_id: 'message',
  author_user_id: 'author',
  fact_hash: 'fact-hash',
  recipient_cursor: 'cursor',
  fact_lease_token: 'fact-lease',
};
function fixture() {
  const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
  const repo = {
    claimSource: vi.fn().mockResolvedValue(null),
    claimFact: vi.fn().mockResolvedValue(null),
    claimRecipient: vi.fn().mockResolvedValue(null),
    storePage: vi.fn().mockResolvedValue(true),
    storeRecipients: vi.fn().mockResolvedValue(true),
    hold: vi.fn().mockResolvedValue(undefined),
    restartFact: vi.fn().mockResolvedValue(undefined),
    tx: vi.fn((_tenant: string, run: (c: typeof client) => unknown) => run(client)),
  };
  const owner = { publications: vi.fn(), recipients: vi.fn(), eligibilityWithIdentity: vi.fn() };
  return {
    repo,
    owner,
    run: () =>
      runTournamentImportCycle(
        repo as unknown as TournamentMessageNotificationRepository,
        owner as unknown as TournamentNotificationOwnerClient,
        'tenant',
        [],
      ),
  };
}
describe('bounded durable tournament import', () => {
  it('pins original publication frontier and never acknowledges a failed owner page', async () => {
    const f = fixture();
    f.repo.claimSource.mockResolvedValue(source);
    f.owner.publications.mockRejectedValue(Error('offline'));
    expect(await f.run()).toMatchObject({ source: 'HELD' });
    expect(f.owner.publications).toHaveBeenCalledWith({
      tournamentId: 'tournament',
      incarnationHash: 'hash',
      streamId: 'stream',
      afterSequence: 10,
      throughSequence: 20,
      limit: 50,
    });
    expect(f.repo.storePage).not.toHaveBeenCalled();
    expect(f.repo.hold).toHaveBeenCalledWith('tenant', 'source', 'source', 'source-lease');
  });
  it('stores empty advancing scan pages without confusing them with completion', async () => {
    const f = fixture();
    f.repo.claimFact.mockResolvedValue(fact);
    const page = { candidates: [], hasMore: true, nextCursor: 'next' };
    f.owner.recipients.mockResolvedValue(page);
    expect(await f.run()).toMatchObject({ fanout: 'STORED' });
    expect(f.repo.storeRecipients).toHaveBeenCalledWith(fact, page);
    expect(f.repo.restartFact).not.toHaveBeenCalled();
  });
  it('restarts only traversal on snapshot failure without deleting durable recipients', async () => {
    const f = fixture();
    f.repo.claimFact.mockResolvedValue(fact);
    f.owner.recipients.mockRejectedValue(Error('snapshot changed'));
    expect(await f.run()).toMatchObject({ fanout: 'HELD' });
    expect(f.repo.restartFact).toHaveBeenCalledWith(fact);
    expect(f.repo.storeRecipients).not.toHaveBeenCalled();
  });
  it('holds the original recipient when identity or current owner is unavailable', async () => {
    const f = fixture();
    const p = {
      ...fact,
      context_id: 'context',
      recipient_lease_token: 'recipient-lease',
      witness: { kind: 'ORGANIZER', revision: 1, selectedUserId: 'user' },
      witness_hash: 'witness',
      baseline_sequence: '5',
      read_through_sequence: '6',
    };
    f.repo.claimRecipient.mockResolvedValue(p);
    f.owner.eligibilityWithIdentity.mockRejectedValue(Error('unavailable'));
    expect(await f.run()).toMatchObject({ recipient: 'HELD' });
    expect(f.owner.eligibilityWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message' }),
      {
        witness: p.witness,
        witnessHash: 'witness',
        baselineSequence: 5,
        capturedReadThroughSequence: 6,
      },
    );
    expect(f.repo.hold).toHaveBeenCalledWith('tenant', 'recipient', 'context', 'recipient-lease');
  });
});
