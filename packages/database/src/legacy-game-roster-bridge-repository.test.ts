import { describe, expect, it, vi } from 'vitest';

import { createLegacyGameRosterBridgeRepository } from './legacy-game-roster-bridge-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';

function fakePool(row: Record<string, unknown> | undefined) {
  const clientQuery = vi.fn((text: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('from integration.external_identity_map identity_map')) {
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    },
    clientQuery,
  };
}

describe('legacy game roster bridge repository', () => {
  it('resolves only an exact issuer/subject and mapped canonical game', async () => {
    const { pool, clientQuery } = fakePool({
      user_id: userId,
      display_name: 'Анна Игрокова',
      phone_e164: '+79000000001',
      level_label: 'C+',
      level_value: '3.63',
      game_id: gameId,
      game_revision: '7',
    });
    const result = await createLegacyGameRosterBridgeRepository(pool as never).resolve({
      tenantId,
      issuer: 'https://kc.vivacrm.ru/realms/clients',
      subject: 'signed-subject',
      externalGameId: 'pay_legacy-game-id',
    });

    expect(result).toEqual({
      outcome: 'resolved',
      context: {
        tenantId,
        userId,
        gameId,
        gameRevision: 7,
        player: {
          userId,
          displayName: 'Анна Игрокова',
          phoneE164: '+79000000001',
          levelLabel: 'C+',
          levelValue: 3.63,
        },
      },
    });
    const lookup = clientQuery.mock.calls.find(([text]) =>
      String(text).includes('from integration.external_identity_map identity_map'),
    );
    expect(lookup?.[1]).toEqual([
      tenantId,
      'https://kc.vivacrm.ru/realms/clients',
      'signed-subject',
      'pay_legacy-game-id',
    ]);
    expect(String(lookup?.[0])).not.toContain('phone_e164 =');
  });

  it('distinguishes an unlinked actor from a game that has not been imported', async () => {
    const missingActor = fakePool(undefined);
    await expect(
      createLegacyGameRosterBridgeRepository(missingActor.pool as never).resolve({
        tenantId,
        issuer: 'issuer',
        subject: 'subject',
        externalGameId: 'legacy-game',
      }),
    ).resolves.toEqual({ outcome: 'actor_not_linked' });

    const missingGame = fakePool({
      user_id: userId,
      display_name: 'Анна',
      phone_e164: '+79000000001',
      level_label: null,
      level_value: null,
      game_id: null,
      game_revision: null,
    });
    await expect(
      createLegacyGameRosterBridgeRepository(missingGame.pool as never).resolve({
        tenantId,
        issuer: 'issuer',
        subject: 'subject',
        externalGameId: 'legacy-game',
      }),
    ).resolves.toEqual({ outcome: 'game_not_mapped' });
  });
});
