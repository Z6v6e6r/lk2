import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  createLocationDigest,
  type CreateLocationLineage,
  type CreateLocationMapping,
  type GameCreateLocationBinding,
} from '../../../packages/database/src/game-create-location-binding-repository.js';
import { parseLegacyCreateLocationEvidence } from '@phub/legacy-games-adapter';
import { CreateLocationProviderContradiction } from '@phub/viva-adapter';
import {
  deriveCreateLocationCandidate,
  runGameCreateLocationBindingSync,
} from './game-create-location-binding-sync.js';

const now = Date.parse('2026-10-31T12:00:00Z');
function fixture() {
  const tenantId = randomUUID(),
    courtId = randomUUID(),
    stationId = randomUUID(),
    gameId = randomUUID();
  const evidence = [
    parseLegacyCreateLocationEvidence({
      id: 'synthetic-game',
      updatedAt: '2026-10-30T12:00:00Z',
      booking: { studioId: 'synthetic-studio', roomId: 'synthetic-room' },
    }),
  ];
  const map = (
    entity_type: CreateLocationMapping['entity_type'],
    internal_id: string,
    external_id: string,
  ): CreateLocationMapping => ({
    id: randomUUID(),
    entity_type,
    internal_id,
    external_id,
    external_version: 'v1',
    sync_status: 'synced',
    sync_error_code: null,
    last_synced_at: '2026-10-30T12:00:00Z',
  });
  const mappings = [
    ...evidence[0]!.gameAliases.map((id) => map('game', gameId, id)),
    ...evidence[0]!.stationAliases.map((id) => map('game_station', stationId, id)),
    ...evidence[0]!.courtAliases.map((id) => map('game_court', courtId, id)),
  ];
  const lineage: CreateLocationLineage = {
    mappings,
    games: [{ id: gameId, station_id: stationId, court_id: courtId }],
    digest: createLocationDigest(mappings),
  };
  const repository = {
    snapshot: vi.fn().mockResolvedValue({ lineage, bindings: [] }),
    publish: vi.fn().mockResolvedValue('APPLIED'),
    revoke: vi.fn().mockResolvedValue(true),
  };
  const source = { readCreateLocationEvidence: vi.fn().mockResolvedValue(evidence) };
  const provider = {
    readRoomStudio: vi.fn().mockResolvedValue({
      studioId: 'synthetic-studio',
      roomId: 'synthetic-room',
      observedAt: new Date(now).toISOString(),
    }),
  };
  const readCredentials = vi.fn().mockResolvedValue({
    purpose: 'GAME_CREATE_LOCATION_BINDING',
    providerTenantKey: 'iSkq6G',
    accessToken: 'synthetic-token-with-no-authority',
    expiresAt: new Date(now + 600_000).toISOString(),
  });
  const pool = { connect: vi.fn() } as unknown as Pool;
  const config = {
    GAME_CREATE_LOCATION_BINDING_SYNC_ENABLED: true,
    GAME_CREATE_LOCATION_BINDING_TENANT_ID: tenantId,
    GAME_CREATE_LOCATION_BINDING_ADMIN_CREDENTIAL_FILE: '/synthetic/credential.json',
    LEGACY_GAMES_MONGODB_URI: 'mongodb://synthetic.invalid/fixture',
  };
  const input = {
    pool,
    config,
    dependencies: { repository, source, provider, readCredentials, now: () => now },
  };
  return {
    tenantId,
    courtId,
    stationId,
    gameId,
    evidence,
    lineage,
    map,
    repository,
    source,
    provider,
    readCredentials,
    input,
  };
}
describe('CREATE location complete lineage', () => {
  it('accepts every agreeing raw and pseudonymous alias, independent of order', () => {
    const f = fixture();
    expect(
      deriveCreateLocationCandidate(f.lineage, f.evidence, f.courtId, new Date(now).toISOString()),
    ).toMatchObject({ courtId: f.courtId, stationId: f.stationId, roomId: 'synthetic-room' });
    f.lineage.mappings.reverse();
    expect(
      deriveCreateLocationCandidate(f.lineage, f.evidence, f.courtId, new Date(now).toISOString()),
    ).not.toBeNull();
  });
  it('rejects a reverse raw-source collision even when the other court aliases are already corrupt', () => {
    const f = fixture(),
      otherGame = randomUUID(),
      otherCourt = randomUUID();
    f.lineage.games.push({ id: otherGame, station_id: f.stationId, court_id: otherCourt });
    f.lineage.mappings.push(
      f.map('game', otherGame, 'other-source-game'),
      f.map('game_court', otherCourt, 'unrelated-corrupt-room-alias'),
    );
    f.evidence.push(
      parseLegacyCreateLocationEvidence({
        id: 'other-source-game',
        updatedAt: '2026-01-01T00:00:00Z',
        booking: { studioId: 'synthetic-studio', roomId: 'synthetic-room' },
      }),
    );
    expect(
      deriveCreateLocationCandidate(f.lineage, f.evidence, f.courtId, new Date(now).toISOString()),
    ).toBeNull();
  });
  it.each([
    'unknown-alias',
    'historical-missing',
    'historical-conflict',
    'cross-station',
    'reverse-court',
    'reverse-station',
    'orphan',
    'unsynced',
    'future-source',
  ])('fails closed for %s', (kind) => {
    const f = fixture();
    if (kind === 'unknown-alias')
      f.lineage.mappings.push(f.map('game_court', f.courtId, 'unknown-alias'));
    if (kind.startsWith('historical')) {
      const id = randomUUID();
      f.lineage.games.push({ id, station_id: f.stationId, court_id: f.courtId });
      f.lineage.mappings.push(f.map('game', id, 'historical-game'));
      if (kind === 'historical-conflict')
        f.evidence.push(
          parseLegacyCreateLocationEvidence({
            id: 'historical-game',
            updatedAt: '2026-01-01T00:00:00Z',
            booking: { studioId: 'synthetic-studio', roomId: 'other-room' },
          }),
        );
    }
    if (kind === 'cross-station')
      f.lineage.games.push({ id: randomUUID(), station_id: randomUUID(), court_id: f.courtId });
    if (kind === 'reverse-court')
      f.lineage.mappings.push(f.map('game_court', randomUUID(), f.evidence[0]!.courtAliases[1]!));
    if (kind === 'reverse-station')
      f.lineage.mappings.push(
        f.map('game_station', randomUUID(), f.evidence[0]!.stationAliases[1]!),
      );
    if (kind === 'orphan') f.lineage.mappings.push(f.map('game', randomUUID(), 'orphan'));
    if (kind === 'unsynced') f.lineage.mappings[0]!.sync_status = 'pending';
    if (kind === 'future-source')
      f.evidence[0] = { ...f.evidence[0]!, sourceUpdatedAt: new Date(now + 1).toISOString() };
    expect(
      deriveCreateLocationCandidate(f.lineage, f.evidence, f.courtId, new Date(now).toISOString()),
    ).toBeNull();
  });
});
describe('CREATE dedicated worker', () => {
  it('off performs no DB, source, credential or provider access', async () => {
    const f = fixture();
    f.input.config.GAME_CREATE_LOCATION_BINDING_SYNC_ENABLED = false;
    expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({ outcome: 'DISABLED' });
    for (const fn of [
      f.repository.snapshot,
      f.readCredentials,
      f.source.readCreateLocationEvidence,
      f.provider.readRoomStudio,
    ])
      expect(fn).not.toHaveBeenCalled();
  });
  it('old schema/missing tenant binding closes before credentials and provider', async () => {
    const f = fixture();
    f.repository.snapshot.mockResolvedValue(null);
    expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
      outcome: 'UNAVAILABLE',
    });
    expect(f.readCredentials).not.toHaveBeenCalled();
  });
  it.each(['wrong-purpose', 'expired', 'unknown-key'])(
    'rejects %s credential without provider access',
    async (kind) => {
      const f = fixture();
      const c = (await f.readCredentials()) as { purpose: string; expiresAt: string };
      if (kind === 'wrong-purpose') c.purpose = 'NOTIFICATION';
      if (kind === 'expired') c.expiresAt = new Date(now).toISOString();
      if (kind === 'unknown-key') Object.assign(c, { identity: 'unverified' });
      f.readCredentials.mockResolvedValue(c);
      expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
        outcome: 'UNAVAILABLE',
      });
      expect(f.provider.readRoomStudio).not.toHaveBeenCalled();
      expect(f.repository.publish).not.toHaveBeenCalled();
    },
  );
  it('publishes only after exact provider evidence using CAS; never stores bearer', async () => {
    const f = fixture();
    expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
      outcome: 'COMPLETE',
      applied: 1,
    });
    const command: unknown = f.repository.publish.mock.calls[0]![0];
    expect(command).toMatchObject({
      tenantId: f.tenantId,
      expectedRevision: null,
      candidate: {
        courtId: f.courtId,
        stationId: f.stationId,
        verifiedAt: new Date(now).toISOString(),
      },
    });
    expect(JSON.stringify(command)).not.toContain('synthetic-token');
  });
  it('revokes definitive lineage contradiction with original revision', async () => {
    const f = fixture();
    f.lineage.mappings.push(f.map('game_court', f.courtId, 'unknown'));
    f.repository.snapshot.mockResolvedValue({
      lineage: f.lineage,
      bindings: [
        { court_id: f.courtId, state: 'ACTIVE', revision: '7' } as GameCreateLocationBinding,
      ],
    });
    expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
      revoked: 1,
      applied: 0,
    });
    expect(f.repository.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: '7' }),
    );
    expect(f.provider.readRoomStudio).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'provider failure renews nothing; contradiction=%s revokes only existing exact revision',
    async (contradiction) => {
      const f = fixture();
      f.repository.snapshot.mockResolvedValue({
        lineage: f.lineage,
        bindings: [
          { court_id: f.courtId, state: 'ACTIVE', revision: '7' } as GameCreateLocationBinding,
        ],
      });
      f.provider.readRoomStudio.mockRejectedValue(
        contradiction ? new CreateLocationProviderContradiction() : new Error('timeout'),
      );
      expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
        failed: 1,
        applied: 0,
        revoked: contradiction ? 1 : 0,
      });
      expect(f.repository.publish).not.toHaveBeenCalled();
    },
  );
  it('does not extend evidence when the complete source read exhausts TTL', async () => {
    const f = fixture();
    let time = now;
    f.input.dependencies.now = () => time;
    f.source.readCreateLocationEvidence.mockImplementation(() => {
      time += 300_000;
      return Promise.resolve(f.evidence);
    });
    expect(await runGameCreateLocationBindingSync(f.input)).toMatchObject({
      failed: 1,
      applied: 0,
    });
    expect(f.provider.readRoomStudio).not.toHaveBeenCalled();
  });
});
