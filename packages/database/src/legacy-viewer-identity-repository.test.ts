import { describe, expect, it, vi } from 'vitest';

import {
  linkLegacyViewerPhone,
  readLegacyViewerPhone,
} from './legacy-viewer-identity-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '9f0e4bb0-9a8e-4f39-9a1c-3b1d3d5b6a11';
const rowId = '11111111-1111-4111-8111-111111111111';

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

  it('links the phone inside integration custody without an unsupported conflict arbiter', async () => {
    let insertText: string | undefined;
    const { pool } = poolWith((text) => {
      if (text.includes('select internal_id')) return { rows: [], rowCount: 0 };
      if (text.includes('select id, external_id')) return { rows: [], rowCount: 0 };
      insertText = text;
      return { rows: [], rowCount: 1 };
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
    expect(insertText).toContain('legacy_viewer_phone');
    expect(insertText).not.toContain('profile.user_summaries');
    // Migration 0042 dropped the table-level unique constraint on internal_id in favour of a partial
    // unique index, so an `on conflict` arbiter on that column cannot be inferred and fails with 42P10.
    expect(insertText).not.toContain('on conflict');
  });

  it('reports an unchanged link when the provider repeats the same phone', async () => {
    const { pool } = poolWith((text) => {
      if (text.includes('select internal_id')) {
        return { rows: [{ internal_id: userId }], rowCount: 1 };
      }
      if (text.includes('select id, external_id')) {
        return { rows: [{ id: rowId, external_id: '+79104303190' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
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

  it('replaces a different provider phone for the same user instead of trusting the old value', async () => {
    const updates: (readonly unknown[])[] = [];
    const { pool } = poolWith((text, values) => {
      if (text.includes('select internal_id')) return { rows: [], rowCount: 0 };
      if (text.includes('select id, external_id')) {
        return { rows: [{ id: rowId, external_id: '+79100000000' }], rowCount: 1 };
      }
      updates.push(values);
      return { rows: [], rowCount: 1 };
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
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('+79104303190');
  });

  it('fails closed when another PadlHub user already owns the phone', async () => {
    const statements: string[] = [];
    const { pool } = poolWith((text) => {
      statements.push(text);
      if (text.includes('select internal_id')) {
        return { rows: [{ internal_id: otherUserId }], rowCount: 1 };
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
    expect(statements.some((text) => text.startsWith('update'))).toBe(false);
    expect(statements.some((text) => text.includes('insert into'))).toBe(false);
  });

  it('keeps a unique violation a conflict instead of rewriting the other account', async () => {
    const { pool } = poolWith((text) => {
      if (text.includes('select internal_id')) return { rows: [], rowCount: 0 };
      if (text.includes('select id, external_id')) return { rows: [], rowCount: 0 };
      return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
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
