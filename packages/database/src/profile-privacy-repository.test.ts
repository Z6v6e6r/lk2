import { describe, expect, it, vi } from 'vitest';

import { createProfilePrivacyRepository } from './profile-privacy-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const updatedAt = new Date('2026-07-17T12:00:00.000Z');

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

function transactionQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  return vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(handler(text, values));
  });
}

describe('profile privacy repository', () => {
  it('returns access-neutral defaults without creating a row', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from profile.privacy_settings')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfilePrivacyRepository(poolWithQuery(query) as never);

    await expect(repository.get(tenantId, userId)).resolves.toEqual({
      contactPolicy: 'AUTHORIZED',
      chatPolicy: 'AUTHORIZED',
      version: 0,
      updatedAt: null,
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
  });

  it('writes privacy, audit and outbox atomically', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from profile.privacy_commands')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.privacy_settings')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into profile.privacy_settings')) {
        return {
          rows: [
            {
              contact_policy: 'NOBODY',
              chat_policy: 'AUTHORIZED',
              version: 1,
              updated_at: updatedAt,
            },
          ],
          rowCount: 1,
        };
      }
      if (
        text.includes('insert into profile.privacy_commands') ||
        text.includes('insert into audit.audit_log') ||
        text.includes('insert into audit.outbox_events')
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfilePrivacyRepository(poolWithQuery(query) as never);

    await expect(
      repository.update({
        tenantId,
        userId,
        actorUserId: userId,
        idempotencyKey: 'profile-privacy-test-0001',
        requestHash: 'a'.repeat(64),
        correlationId: 'profile-privacy-correlation-0001',
        expectedVersion: 0,
        contactPolicy: 'NOBODY',
        chatPolicy: 'AUTHORIZED',
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      settings: {
        contactPolicy: 'NOBODY',
        chatPolicy: 'AUTHORIZED',
        version: 1,
        updatedAt: updatedAt.toISOString(),
      },
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
  });

  it('replays the original result and rejects a reused key with different input', async () => {
    const stored = {
      contactPolicy: 'NOBODY',
      chatPolicy: 'NOBODY',
      version: 2,
      updatedAt: updatedAt.toISOString(),
    };
    const query = transactionQuery((text) => {
      if (text.includes('from profile.privacy_commands')) {
        return { rows: [{ request_hash: 'b'.repeat(64), result_payload: stored }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfilePrivacyRepository(poolWithQuery(query) as never);
    const command = {
      tenantId,
      userId,
      actorUserId: userId,
      idempotencyKey: 'profile-privacy-test-0002',
      correlationId: 'profile-privacy-correlation-0002',
      expectedVersion: 1,
      contactPolicy: 'NOBODY' as const,
      chatPolicy: 'NOBODY' as const,
    };

    await expect(repository.update({ ...command, requestHash: 'b'.repeat(64) })).resolves.toEqual({
      outcome: 'applied',
      settings: stored,
      replayed: true,
    });
    await expect(repository.update({ ...command, requestHash: 'c'.repeat(64) })).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });
  });

  it('returns the current settings on optimistic version conflict', async () => {
    const query = transactionQuery((text) => {
      if (text.includes('from profile.privacy_commands')) return { rows: [], rowCount: 0 };
      if (text.includes('from profile.privacy_settings')) {
        return {
          rows: [
            {
              contact_policy: 'AUTHORIZED',
              chat_policy: 'NOBODY',
              version: 3,
              updated_at: updatedAt,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createProfilePrivacyRepository(poolWithQuery(query) as never);

    await expect(
      repository.update({
        tenantId,
        userId,
        actorUserId: userId,
        idempotencyKey: 'profile-privacy-test-0003',
        requestHash: 'd'.repeat(64),
        correlationId: 'profile-privacy-correlation-0003',
        expectedVersion: 2,
        contactPolicy: 'NOBODY',
        chatPolicy: 'NOBODY',
      }),
    ).resolves.toEqual({
      outcome: 'version_conflict',
      current: {
        contactPolicy: 'AUTHORIZED',
        chatPolicy: 'NOBODY',
        version: 3,
        updatedAt: updatedAt.toISOString(),
      },
    });
  });
});
