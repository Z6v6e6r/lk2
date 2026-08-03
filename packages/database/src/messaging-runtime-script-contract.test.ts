import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { assertCommsOperatorAccess } from '../../../scripts/messaging-runtime-access.js';

describe('messaging runtime operator command', () => {
  it('requires current comms-operator authority for preview and apply', async () => {
    const source = await readFile(
      new URL('../../../scripts/set-messaging-runtime.ts', import.meta.url),
      'utf8',
    );

    expect(source.match(/assertCommsOperatorAccess\(client, tenantId, actorId\)/g)).toHaveLength(2);
    expect(source).toContain('MESSAGING_RUNTIME_CHANGED');
    expect(source.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      source.lastIndexOf('assertCommsOperatorAccess(client, tenantId, actorId)'),
    );
  });

  it('fails closed when the actor lacks the current admin permission pair', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      assertCommsOperatorAccess({ query } as never, 'tenant-id', 'actor-id'),
    ).rejects.toThrow('ADMIN_PERMISSION_REQUIRED');
    expect(String(query.mock.calls[0]?.[0])).toContain("'admin' = any(access.roles)");
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "'notifications.manage' = any(access.permissions)",
    );
  });

  it('accepts exactly one active authorized access row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });

    await expect(
      assertCommsOperatorAccess({ query } as never, 'tenant-id', 'actor-id'),
    ).resolves.toBeUndefined();
  });
});
