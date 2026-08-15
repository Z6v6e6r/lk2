import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withChatPushFoundationClients } from './chat-push-foundation-clients.js';

function client() {
  const release = vi.fn();
  return { value: { release } as unknown as PoolClient, release };
}

describe('chat/push foundation verifier clients', () => {
  it('releases the first client and closes both pools when the second connection fails', async () => {
    const runtimeClient = client();
    const runtimePool = {
      connect: vi.fn().mockResolvedValue(runtimeClient.value),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const migratorPool = {
      connect: vi.fn().mockRejectedValue(new Error('SECOND_CONNECT_FAILED')),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const operation = vi.fn();

    await expect(
      withChatPushFoundationClients({ runtimePool, migratorPool, operation }),
    ).rejects.toThrow('SECOND_CONNECT_FAILED');
    expect(runtimeClient.release).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    expect(runtimePool.end).toHaveBeenCalledOnce();
    expect(migratorPool.end).toHaveBeenCalledOnce();
  });

  it('preserves the primary verifier error when cleanup also fails', async () => {
    const runtimeClient = client();
    const migratorClient = client();
    const runtimePool = {
      connect: vi.fn().mockResolvedValue(runtimeClient.value),
      end: vi.fn().mockRejectedValue(new Error('RUNTIME_POOL_END_FAILED')),
    };
    const migratorPool = {
      connect: vi.fn().mockResolvedValue(migratorClient.value),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const operation = vi.fn().mockRejectedValue(new Error('PRIMARY_VERIFIER_FAILURE'));

    await expect(
      withChatPushFoundationClients({ runtimePool, migratorPool, operation }),
    ).rejects.toThrow('PRIMARY_VERIFIER_FAILURE');
    expect(runtimeClient.release).toHaveBeenCalledOnce();
    expect(migratorClient.release).toHaveBeenCalledOnce();
    expect(runtimePool.end).toHaveBeenCalledOnce();
    expect(migratorPool.end).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure after a successful verifier operation', async () => {
    const runtimeClient = client();
    const migratorClient = client();
    const runtimePool = {
      connect: vi.fn().mockResolvedValue(runtimeClient.value),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const migratorPool = {
      connect: vi.fn().mockResolvedValue(migratorClient.value),
      end: vi.fn().mockRejectedValue(new Error('MIGRATOR_POOL_END_FAILED')),
    };

    await expect(
      withChatPushFoundationClients({
        runtimePool,
        migratorPool,
        operation: vi.fn().mockResolvedValue('verified'),
      }),
    ).rejects.toThrow('CHAT_PUSH_FOUNDATION_DATABASE_CLEANUP_FAILED');
    expect(runtimeClient.release).toHaveBeenCalledOnce();
    expect(migratorClient.release).toHaveBeenCalledOnce();
  });
});
