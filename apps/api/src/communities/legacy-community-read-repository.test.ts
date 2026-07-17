import { describe, expect, it, vi } from 'vitest';

import { createCommunityDirectoryService } from '@phub/communities';
import type { CommunityLegacyBridgeRepository } from '@phub/database';

import { LegacyCommunityReadRepository } from './legacy-community-read-repository.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function bridge(): CommunityLegacyBridgeRepository {
  return {
    getViewerIdentity: () =>
      Promise.resolve({ phoneE164: '+79990000001', clientId: 'legacy-client-1' }),
    resolveCommunityIds: (_tenantId, externalIds) =>
      Promise.resolve(
        new Map(
          externalIds.map((externalId, index) => [
            externalId,
            index === 0
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          ]),
        ),
      ),
    getCommunityLogoUrls: () =>
      Promise.resolve(
        new Map([
          [
            '11111111-1111-4111-8111-111111111111',
            'https://media.padlhub.test/community.webp?sig=test',
          ],
        ]),
      ),
  };
}

function payload() {
  return {
    communities: [
      {
        id: 'community_legacy_mine',
        name: 'Моё сообщество',
        logoUrl: '/lk/media/community-logo/community_logo_123',
        isVerified: true,
        updatedAt: '2026-07-17T10:00:00.000Z',
        members: [
          {
            id: 'legacy-client-1',
            phone: '79990000001',
            name: 'Скрытое имя',
          },
        ],
      },
      {
        id: 'community_open_catalog',
        name: 'Только каталог',
        members: [],
      },
      {
        id: 'community_other_member',
        name: 'Чужое членство',
        members: [{ id: 'another-client', phone: '79990000002' }],
      },
    ],
    connections: [{ left: 'community_legacy_mine', right: 'community_open_catalog' }],
  };
}

describe('legacy community read repository', () => {
  it('keeps only the authenticated membership and exposes no legacy identity', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 30_000,
      bridge: bridge(),
      fetchImplementation,
    });

    const items = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'community-legacy-test',
      limit: 20,
    });

    expect(items.items).toEqual([
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Моё сообщество',
        logoUrl: 'https://media.padlhub.test/community.webp?sig=test',
        legacyLogoSourceUrl:
          'https://legacy.padlhub.test/lk/media/community-logo/community_logo_123',
        isVerified: true,
      }),
    ]);
    expect(JSON.stringify(items.items)).not.toContain('community_legacy_mine');
    expect(JSON.stringify(items.items)).not.toContain('79990000001');
    expect(JSON.stringify(items.items)).not.toContain('legacy-client-1');

    const publicPage = await createCommunityDirectoryService(repository).listMemberships({
      tenantId,
      userId,
      correlationId: 'community-public-test',
      limit: 20,
    });
    expect(publicPage.items[0]?.logoUrl).toBe('https://media.padlhub.test/community.webp?sig=test');
    expect(JSON.stringify(publicPage)).not.toContain('legacy.padlhub.test');
    expect(JSON.stringify(publicPage)).not.toContain('legacyLogoSourceUrl');

    await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'community-legacy-test-2',
      limit: 20,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('retries a bounded transient failure and reports only redacted metrics', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload()), { status: 200 }));
    const onMetric = vi.fn();
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
      onMetric,
    });

    await expect(
      repository.listMemberships({ tenantId, userId, correlationId: 'retry-test', limit: 20 }),
    ).resolves.toMatchObject({ items: { length: 1 }, hasMore: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(onMetric.mock.calls)).not.toContain('79990000001');
    expect(JSON.stringify(onMetric.mock.calls)).not.toContain('legacy-client-1');
  });

  it('rejects invalid JSON without retrying it as a transient outage', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{not-json', { status: 200 }));
    const onMetric = vi.fn();
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
      onMetric,
    });

    await expect(
      repository.listMemberships({
        tenantId,
        userId,
        correlationId: 'invalid-json-test',
        limit: 20,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'COMMUNITY_LEGACY_RESPONSE_INVALID' }));
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        attempt: 1,
        status: 200,
        code: 'COMMUNITY_LEGACY_RESPONSE_INVALID',
      }),
    );
  });

  it('does not retry a non-transient HTTP response and records the failure', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 404 }));
    const onMetric = vi.fn();
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
      onMetric,
    });

    await expect(
      repository.listMemberships({ tenantId, userId, correlationId: 'not-found-test', limit: 20 }),
    ).rejects.toEqual(expect.objectContaining({ code: 'COMMUNITY_LEGACY_UNAVAILABLE' }));
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        attempt: 1,
        status: 404,
        code: 'COMMUNITY_LEGACY_UNAVAILABLE',
      }),
    );
  });
});
