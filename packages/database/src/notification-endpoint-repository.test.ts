import { describe, expect, it, vi } from 'vitest';

import { createNotificationEndpointRepository } from './notification-endpoint-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const installationId = '11111111-1111-4111-8111-111111111111';
const providerId = '22222222-2222-4222-8222-222222222222';
const endpointId = '33333333-3333-4333-8333-333333333333';
const selector = { appId: 'padlhub-web', environment: 'SANDBOX' as const };

function poolWithQuery(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('notification endpoint repository', () => {
  it('reports tenant and provider gates independently', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('provider_configured')) {
        return Promise.resolve({
          rows: [{ web_push_enabled: true, provider_configured: true }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(repository.getWebPushCapabilities(tenantId, selector)).resolves.toEqual({
      tenantEnabled: true,
      providerConfigured: true,
    });
  });

  it('registers encrypted endpoint material and audits only hashes/metadata', async () => {
    const ciphertext = Buffer.from('encrypted-notification-endpoint');
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_provider_accounts')) {
        return Promise.resolve({ rows: [{ id: providerId }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoint_commands')) {
        return Promise.resolve({
          rows: [{ idempotency_key: 'endpoint-register-test-0001' }],
          rowCount: 1,
        });
      }
      if (
        text.includes('from integration.notification_endpoints') &&
        (text.includes('installation_id = $4') ||
          text.includes('address_hash = $3') ||
          text.includes('address_hash = $4'))
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('count(*)::integer as endpoint_count')) {
        return Promise.resolve({ rows: [{ endpoint_count: 0 }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoints')) {
        return Promise.resolve({
          rows: [
            {
              id: endpointId,
              installation_id: installationId,
              address_hash: 'a'.repeat(64),
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      if (
        text.includes('update integration.notification_endpoint_commands') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext,
        addressHash: 'a'.repeat(64),
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'b'.repeat(64),
        idempotencyKey: 'endpoint-register-test-0001',
        correlationId: 'endpoint-register-correlation',
      }),
    ).resolves.toEqual({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: false,
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('insert into integration.notification_endpoints') &&
          (values as unknown[]).includes(ciphertext),
      ),
    ).toBe(true);
    expect(
      query.mock.calls
        .filter(([text]) => String(text).includes('insert into audit.audit_log'))
        .every(([, values]) => !JSON.stringify(values).includes('encrypted-notification-endpoint')),
    ).toBe(true);
  });

  it('merges a subscription reused by another installation without breaking delivery history', async () => {
    const oldInstallationEndpointId = '44444444-4444-4444-8444-444444444444';
    const reusedAddressEndpointId = '55555555-5555-4555-8555-555555555555';
    const addressHash = 'c'.repeat(64);
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_provider_accounts')) {
        return Promise.resolve({ rows: [{ id: providerId }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoint_commands')) {
        return Promise.resolve({
          rows: [{ idempotency_key: 'endpoint-register-merge-0001' }],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.notification_endpoints') && text.includes('for update')) {
        if (values[3] === installationId) {
          return Promise.resolve({
            rows: [
              {
                id: oldInstallationEndpointId,
                installation_id: installationId,
                address_hash: 'd'.repeat(64),
                status: 'ACTIVE',
              },
            ],
            rowCount: 1,
          });
        }
        if (values[2] === addressHash) {
          return Promise.resolve({
            rows: [
              {
                id: reusedAddressEndpointId,
                user_id: userId,
                installation_id: '66666666-6666-4666-8666-666666666666',
                address_hash: addressHash,
                status: 'ACTIVE',
              },
            ],
            rowCount: 1,
          });
        }
      }
      if (text.includes('count(*)::integer as endpoint_count')) {
        return Promise.resolve({ rows: [{ endpoint_count: 1 }], rowCount: 1 });
      }
      if (text.includes('set installation_id = null')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('set installation_id = $4')) {
        return Promise.resolve({
          rows: [
            {
              id: reusedAddressEndpointId,
              installation_id: installationId,
              address_hash: addressHash,
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      if (
        text.includes('update integration.notification_endpoint_commands') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext: Buffer.from('rotated-encrypted-endpoint'),
        addressHash,
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'e'.repeat(64),
        idempotencyKey: 'endpoint-register-merge-0001',
        correlationId: 'endpoint-register-merge',
      }),
    ).resolves.toMatchObject({
      outcome: 'updated',
      endpointId: reusedAddressEndpointId,
      installationId,
      status: 'ACTIVE',
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('set installation_id = null') &&
          (values as readonly unknown[])[2] === oldInstallationEndpointId,
      ),
    ).toBe(true);
  });

  it('revokes a different owner and creates a target-owned endpoint without leaking delivery ownership', async () => {
    const previousUserId = '77777777-7777-4777-8777-777777777777';
    const previousEndpointId = '88888888-8888-4888-8888-888888888888';
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_provider_accounts')) {
        return Promise.resolve({ rows: [{ id: providerId }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoint_commands')) {
        return Promise.resolve({
          rows: [{ idempotency_key: 'endpoint-register-transfer-0001' }],
          rowCount: 1,
        });
      }
      if (text.includes('installation_id = $4')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('address_hash = $3')) {
        return Promise.resolve({
          rows: [
            {
              id: previousEndpointId,
              user_id: previousUserId,
              installation_id: '99999999-9999-4999-8999-999999999999',
              address_hash: 'f'.repeat(64),
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('address_hash = $4')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('count(*)::integer as endpoint_count')) {
        return Promise.resolve({ rows: [{ endpoint_count: 0 }], rowCount: 1 });
      }
      if (text.includes("set installation_id = null, status = 'REVOKED'")) {
        expect(values).toEqual([tenantId, previousUserId, previousEndpointId]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoints')) {
        return Promise.resolve({
          rows: [
            {
              id: endpointId,
              installation_id: installationId,
              address_hash: 'f'.repeat(64),
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      if (
        text.includes('update integration.notification_endpoint_commands') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext: Buffer.from('target-owned-endpoint'),
        addressHash: 'f'.repeat(64),
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'a'.repeat(64),
        idempotencyKey: 'endpoint-register-transfer-0001',
        correlationId: 'endpoint-register-transfer',
      }),
    ).resolves.toMatchObject({ outcome: 'updated', endpointId, replayed: false });

    expect(
      query.mock.calls.some(
        ([text]) =>
          String(text).includes('update integration.notification_endpoints') &&
          String(text).includes("set installation_id = null, status = 'REVOKED'"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([text]) =>
          String(text).includes('update integration.notification_endpoints') &&
          String(text).includes('set user_id'),
      ),
    ).toBe(false);
    const ownershipAudit = query.mock.calls.find(([text]) =>
      String(text).includes('WEB_PUSH_ENDPOINT_OWNERSHIP_REVOKED'),
    );
    expect(ownershipAudit?.[1]).toEqual([
      tenantId,
      userId,
      previousEndpointId,
      'endpoint-register-transfer',
      JSON.stringify({ status: 'ACTIVE', addressHash: 'f'.repeat(64) }),
      JSON.stringify({ status: 'REVOKED', installationId: null }),
    ]);
    const locks = query.mock.calls.filter(([text]) =>
      String(text).includes('pg_advisory_xact_lock'),
    );
    expect(locks.map(([, values]) => (values as readonly unknown[])[0])).toEqual([
      `notification-endpoint-address:${tenantId}:${providerId}:${'f'.repeat(64)}`,
      `notification-endpoint:${userId}`,
    ]);
    for (const sql of query.mock.calls
      .map(([text]) => String(text))
      .filter(
        (text) =>
          text.includes('address_hash = $3') ||
          text.includes('address_hash = $4') ||
          text.includes('count(*)::integer as endpoint_count'),
      )) {
      expect(sql).toContain("channel = 'PUSH'");
    }
  });

  it('rolls back a quota rejection so the same key can succeed after capacity is freed', async () => {
    let quotaExhausted = true;
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_provider_accounts')) {
        return Promise.resolve({ rows: [{ id: providerId }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoint_commands')) {
        return Promise.resolve({
          rows: [{ idempotency_key: 'endpoint-register-quota-0001' }],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.notification_endpoints') && text.includes('for update')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('count(*)::integer as endpoint_count')) {
        return Promise.resolve({
          rows: [{ endpoint_count: quotaExhausted ? 5 : 0 }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into integration.notification_endpoints')) {
        return Promise.resolve({
          rows: [
            {
              id: endpointId,
              installation_id: installationId,
              address_hash: 'a'.repeat(64),
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      if (
        text.includes('update integration.notification_endpoint_commands') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext: Buffer.from('quota-limited-endpoint'),
        addressHash: 'a'.repeat(64),
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'b'.repeat(64),
        idempotencyKey: 'endpoint-register-quota-0001',
        correlationId: 'endpoint-register-quota',
      }),
    ).resolves.toEqual({ outcome: 'endpoint_limit_reached' });

    expect(query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
    quotaExhausted = false;
    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext: Buffer.from('quota-limited-endpoint'),
        addressHash: 'a'.repeat(64),
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'b'.repeat(64),
        idempotencyKey: 'endpoint-register-quota-0001',
        correlationId: 'endpoint-register-quota-retry',
      }),
    ).resolves.toMatchObject({ outcome: 'updated', endpointId, replayed: false });
  });

  it('returns a successful idempotent replay before checking the endpoint quota', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_provider_accounts')) {
        return Promise.resolve({ rows: [{ id: providerId }], rowCount: 1 });
      }
      if (text.includes('insert into integration.notification_endpoint_commands')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.notification_endpoint_commands')) {
        return Promise.resolve({
          rows: [
            {
              command_type: 'REGISTER',
              installation_id: installationId,
              request_hash: 'b'.repeat(64),
              endpoint_id: endpointId,
              result_status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Quota or endpoint query must not run for a replay: ${text}`);
    });
    const repository = createNotificationEndpointRepository(poolWithQuery(query) as never);

    await expect(
      repository.registerWebPush({
        tenantId,
        userId,
        selector,
        installationId,
        ciphertext: Buffer.from('replayed-endpoint'),
        addressHash: 'a'.repeat(64),
        encryptionKeyId: 'v1',
        endpointsPerUserMax: 5,
        requestHash: 'b'.repeat(64),
        idempotencyKey: 'endpoint-register-replay-0001',
        correlationId: 'endpoint-register-replay',
      }),
    ).resolves.toEqual({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: true,
    });
  });
});
