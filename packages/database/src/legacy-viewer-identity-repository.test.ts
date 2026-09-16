import { describe, expect, it, vi } from 'vitest';

import {
  linkLegacyViewerPhone,
  readLegacyViewerPhone,
} from './legacy-viewer-identity-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

describe('legacy viewer phone link', () => {
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

  it('does not touch storage when the provider profile has no usable phone', async () => {
    const { pool, query } = poolWith(() => ({ rows: [], rowCount: 0 }));

    await expect(
      linkLegacyViewerPhone({
        pool: pool as never,
        tenantId,
        userId,
        phoneE164: undefined,
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }),
    ).resolves.toBe('absent');
    expect(query).not.toHaveBeenCalled();
  });

  it('links the phone inside integration custody with the provider row as the refresh target', async () => {
    const { pool, query } = poolWith((text) => {
      expect(text).toContain("'legacy_viewer_phone'");
      expect(text).toContain('on conflict (tenant_id, external_system, entity_type, internal_id)');
      expect(text).not.toContain('profile.user_summaries');
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
    });

    await expect(
      linkLegacyViewerPhone({
        pool: pool as never,
        tenantId,
        userId,
        phoneE164: '+79104303190',
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }),
    ).resolves.toBe('linked');
    expect(query).toHaveBeenCalled();
  });

  it('reports an unchanged link when the provider repeats the same phone', async () => {
    const { pool } = poolWith((text) => {
      if (text.includes('insert into integration.external_entity_map')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ external_id: '+79104303190' }], rowCount: 1 };
    });

    await expect(
      linkLegacyViewerPhone({
        pool: pool as never,
        tenantId,
        userId,
        phoneE164: '+79104303190',
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }),
    ).resolves.toBe('unchanged');
  });

  it('fails closed when another PadlHub user already owns the phone', async () => {
    const { pool } = poolWith((text) => {
      if (text.includes('insert into integration.external_entity_map')) {
        return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      linkLegacyViewerPhone({
        pool: pool as never,
        tenantId,
        userId,
        phoneE164: '+79104303190',
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }),
    ).resolves.toBe('conflict');
  });

  it('treats a divergent stored link as a conflict instead of trusting it', async () => {
    const { pool } = poolWith((text) => {
      if (text.includes('insert into integration.external_entity_map')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ external_id: '+79100000000' }], rowCount: 1 };
    });

    await expect(
      linkLegacyViewerPhone({
        pool: pool as never,
        tenantId,
        userId,
        phoneE164: '+79104303190',
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }),
    ).resolves.toBe('conflict');
  });
  it('reads the linked phone without inventing one for an unlinked viewer', async () => {
    const linked = poolWith(() => ({ rows: [{ external_id: '+79104303190' }], rowCount: 1 }));
    await expect(
      readLegacyViewerPhone({ pool: linked.pool as never, tenantId, userId }),
    ).resolves.toBe('+79104303190');

    const missing = poolWith(() => ({ rows: [], rowCount: 0 }));
    await expect(
      readLegacyViewerPhone({ pool: missing.pool as never, tenantId, userId }),
    ).resolves.toBeUndefined();
  });
});
