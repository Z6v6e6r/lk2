import { describe, it, expect, vi } from 'vitest';
import type { StationMessageNotificationRepository } from '@phub/database/station-message-notifications';
import type { StationNotificationClient } from './station-notification-client.js';
import { runStationImportCycle } from './station-notification-importer.js';
const source = {
  tenant_id: 'tenant',
  id: 'source',
  private_community_id: 'private',
  stream_id: 'stream',
  incarnation_hash: 'hash',
  after_sequence: '9',
  through_sequence: '120',
  lease_token: 'lease',
};
describe('station importer durable page boundaries', () => {
  it('preserves fixed through and stores page before next polling; source failure advances nothing', async () => {
    const repo = {
      tx: vi.fn().mockResolvedValue(undefined),
      claimSource: vi.fn().mockResolvedValue(source),
      storePage: vi.fn(),
      claimFact: vi.fn().mockResolvedValue(null),
      claimRecipient: vi.fn().mockResolvedValue(null),
      hold: vi.fn(),
    };
    const owner = { read: vi.fn().mockRejectedValue(Error('offline')) };
    await runStationImportCycle(
      repo as unknown as StationMessageNotificationRepository,
      owner as unknown as StationNotificationClient,
      'tenant',
      [],
    );
    expect(repo.storePage).not.toHaveBeenCalled();
    expect(repo.hold).toHaveBeenCalledWith('tenant', 'source', 'source', 'lease');
    expect(owner.read.mock.calls[0]![1]).toMatchObject({ afterSequence: 9, throughSequence: 120 });
  });
  it('zero eligible recipients still commits scanned cursor, not invented completion', async () => {
    const f = {
      ...source,
      fact_id: 'fact',
      fact_lease_token: 'lease2',
      sequence: '10',
      message_id: 'message',
      author_player_id: 'author',
      proof_hash: 'proof',
      after_player_id: null,
    };
    const repo = {
      tx: vi.fn().mockResolvedValue(undefined),
      claimSource: vi.fn().mockResolvedValue(null),
      claimFact: vi.fn().mockResolvedValue(f),
      claimRecipient: vi.fn().mockResolvedValue(null),
      storeRecipients: vi.fn(),
      hold: vi.fn(),
    };
    const page = { items: [], nextAfterPlayerId: 'player-050', complete: false };
    const owner = { read: vi.fn().mockResolvedValue({ value: page }) };
    await runStationImportCycle(
      repo as unknown as StationMessageNotificationRepository,
      owner as unknown as StationNotificationClient,
      'tenant',
      [],
    );
    expect(repo.storeRecipients).toHaveBeenCalledWith(f, page);
    expect(repo.hold).not.toHaveBeenCalled();
  });
});
