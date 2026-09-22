import { describe, expect, it, vi } from 'vitest';

import { createStationSupportRepository } from './station-support-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const stationId = '9b993668-ff54-4cce-8dfd-cad84c4a06fa';

function poolWith(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(handler(text, values));
  });
  return { pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) }, query };
}

describe('station support bindings', () => {
  it('reads the provider and verified phones for the authenticated user in one tenant transaction', async () => {
    const { pool, query } = poolWith((text) => {
      expect(text).toContain('integration.external_entity_map');
      expect(text).toContain("e.external_system = 'VIVA'");
      expect(text).toContain("e.entity_type = 'legacy_viewer_phone'");
      return {
        rows: [{ phone_e164: '+79990000002', provider_phone_e164: '+79990000001' }],
        rowCount: 1,
      };
    });

    const identity = await createStationSupportRepository(pool as never).readViewerIdentity({
      tenantId,
      userId,
    });
    expect(identity).toEqual({
      providerPhoneE164: '+79990000001',
      verifiedPhoneE164: '+79990000002',
    });
    const parameterised = query.mock.calls.find(([text]) =>
      text.includes('profile.user_summaries'),
    );
    expect(parameterised?.[1]).toEqual([tenantId, userId]);
  });

  it('fails closed with null phones when the user has neither link', async () => {
    const { pool } = poolWith(() => ({ rows: [], rowCount: 0 }));
    await expect(
      createStationSupportRepository(pool as never).readViewerIdentity({ tenantId, userId }),
    ).resolves.toEqual({ providerPhoneE164: null, verifiedPhoneE164: null });
  });

  it('prefers a raw legacy station key over the public-clone pseudonym', async () => {
    const pseudonym = 'a'.repeat(64);
    const { pool, query } = poolWith(() => ({
      rows: [{ external_id: pseudonym }, { external_id: 'Yasenevo' }],
      rowCount: 2,
    }));

    await expect(
      createStationSupportRepository(pool as never).readLegacyStationExternalId({
        tenantId,
        stationId,
      }),
    ).resolves.toBe('Yasenevo');
    const parameterised = query.mock.calls.find(([text]) => text.includes('game_station'));
    expect(parameterised?.[1]).toEqual([tenantId, stationId]);
  });

  it('falls back to the only stored key when every candidate is pseudonymous', async () => {
    const pseudonym = 'b'.repeat(64);
    const { pool } = poolWith(() => ({ rows: [{ external_id: pseudonym }], rowCount: 1 }));
    await expect(
      createStationSupportRepository(pool as never).readLegacyStationExternalId({
        tenantId,
        stationId,
      }),
    ).resolves.toBe(pseudonym);
  });

  it('maps provider station keys back to PadlHub stations without querying for an empty set', async () => {
    const { pool } = poolWith((_text, values) => {
      expect(values[1]).toEqual(['Yasenevo']);
      return { rows: [{ external_id: 'Yasenevo', internal_id: stationId }], rowCount: 1 };
    });
    const repository = createStationSupportRepository(pool as never);
    await expect(
      repository.readStationIdsByLegacyExternalIds({ tenantId, externalIds: ['Yasenevo'] }),
    ).resolves.toEqual(new Map([['Yasenevo', stationId]]));

    const empty = poolWith(() => {
      throw new Error('must not query');
    });
    await expect(
      createStationSupportRepository(empty.pool as never).readStationIdsByLegacyExternalIds({
        tenantId,
        externalIds: [],
      }),
    ).resolves.toEqual(new Map());
    expect(empty.query).not.toHaveBeenCalled();
  });
});
