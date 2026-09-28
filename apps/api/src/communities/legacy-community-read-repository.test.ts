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

function payload(options: { readonly embeddedRank?: boolean } = {}) {
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
            ...(options.embeddedRank === false ? {} : { rating: { position: 7 } }),
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

function oversizedChunkedResponse(): Response {
  const chunk = new Uint8Array(1024 * 1024 + 1);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('legacy community read repository', () => {
  it('fails closed while streaming a chunked response beyond the byte limit', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(oversizedChunkedResponse()));
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
    });

    await expect(
      repository.listMemberships({ tenantId, userId, correlationId: 'chunked-limit', limit: 20 }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_LEGACY_RESPONSE_INVALID' });
  });

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
      staleTtlMs: 0,
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
        memberRank: 7,
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

  it('enriches the visible membership from the current community rating snapshot', async () => {
    const source = payload({ embeddedRank: false });
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/rating')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              communityId: 'community_legacy_mine',
              calculationVersion: 'community-rating-v1.3.0',
              items: [
                {
                  rank: 12,
                  playerId: 'legacy-client-1',
                  playerName: 'Скрытое имя',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(source), { status: 200 }));
    });
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 30_000,
      staleTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
    });

    const page = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'community-rating-test',
      limit: 4,
    });

    expect(page.items[0]).toEqual(expect.objectContaining({ memberRank: 12 }));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const rankingRequest = fetchImplementation.mock.calls[1]?.[0];
    const rankingUrl =
      typeof rankingRequest === 'string'
        ? rankingRequest
        : rankingRequest instanceof URL
          ? rankingRequest.href
          : rankingRequest?.url;
    expect(rankingUrl).toContain('/lk/communities/community_legacy_mine/rating');
  });

  it('accepts a large rating snapshot instead of treating it as invalid', async () => {
    // Large communities return ranking rows for every member: live responses reach ~7 MB, so both
    // the original 512 KB bound and the later 4 MB bound discarded them as
    // COMMUNITY_LEGACY_RESPONSE_INVALID. This snapshot is deliberately larger than 4 MB.
    const source = payload({ embeddedRank: false });
    const filler = Array.from({ length: 24_000 }, (_value, index) => ({
      rank: index + 100,
      playerId: `legacy-filler-${index}`,
      playerName: 'Заполнитель',
      note: 'x'.repeat(120),
    }));
    const ratingSnapshot = JSON.stringify({
      communityId: 'community_legacy_mine',
      calculationVersion: 'community-rating-v1.3.0',
      items: [{ rank: 12, playerId: 'legacy-client-1', playerName: 'Скрытое имя' }, ...filler],
    });
    expect(ratingSnapshot.length).toBeGreaterThan(4 * 1024 * 1024);
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/rating')) {
        return Promise.resolve(new Response(ratingSnapshot, { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(source), { status: 200 }));
    });
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 5_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 30_000,
      staleTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
    });

    const page = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'community-rating-large',
      limit: 4,
    });

    expect(page.items[0]).toEqual(expect.objectContaining({ memberRank: 12 }));
  });

  it('does not hold the membership page open for a slow optional rank lookup', async () => {
    const source = payload({ embeddedRank: false });
    let resolveRank: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/rating')) {
        return new Promise<Response>((resolve) => {
          resolveRank = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify(source), { status: 200 }));
    });
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 30_000,
      staleTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
    });

    const startedAt = Date.now();
    const page = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'community-rank-budget-test',
      limit: 4,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(page.items[0]).not.toHaveProperty('memberRank');
    resolveRank?.(new Response(JSON.stringify({ items: [] }), { status: 200 }));
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
      staleTtlMs: 0,
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
      staleTtlMs: 0,
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
      staleTtlMs: 0,
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

  it('serves a stale directory at once and revalidates it out of band', async () => {
    const initialRead = deferred<Response>();
    const revalidation = deferred<Response>();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => initialRead.promise)
      .mockImplementationOnce(() => revalidation.promise)
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 60_000,
      bridge: bridge(),
      fetchImplementation,
    });

    const firstRead = repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-first',
      limit: 20,
    });
    initialRead.resolve(jsonResponse(payload()));
    await expect(firstRead).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Моё сообщество' })],
    });

    // The page is past its freshness window: the reader is answered from the cache while the legacy
    // projection is asked again outside the request.
    const staleRead = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-stale',
      limit: 20,
    });
    expect(staleRead.items[0]?.title).toBe('Моё сообщество');
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));
    expect(revalidation.promise).toBeDefined();

    const refreshedPayload = payload();
    refreshedPayload.communities[0] = {
      ...refreshedPayload.communities[0]!,
      name: 'Обновлённое сообщество',
    };
    revalidation.resolve(jsonResponse(refreshedPayload));
    await vi.waitFor(async () => {
      const page = await repository.listMemberships({
        tenantId,
        userId,
        correlationId: 'swr-refreshed',
        limit: 20,
      });
      expect(page.items[0]?.title).toBe('Обновлённое сообщество');
    });
  });

  it('keeps one revalidation for concurrent stale readers', async () => {
    const initialRead = deferred<Response>();
    const revalidation = deferred<Response>();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => initialRead.promise)
      .mockImplementation(() => revalidation.promise);
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 60_000,
      bridge: bridge(),
      fetchImplementation,
    });

    const firstRead = repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-dedupe-first',
      limit: 20,
    });
    initialRead.resolve(jsonResponse(payload()));
    await firstRead;

    const readers = await Promise.all(
      ['a', 'b', 'c'].map((suffix) =>
        repository.listMemberships({
          tenantId,
          userId,
          correlationId: `swr-dedupe-${suffix}`,
          limit: 20,
        }),
      ),
    );
    expect(readers.map((page) => page.items[0]?.title)).toEqual([
      'Моё сообщество',
      'Моё сообщество',
      'Моё сообщество',
    ]);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    revalidation.resolve(jsonResponse(payload()));
  });

  it('keeps the last good directory when the background revalidation fails', async () => {
    const revalidation = deferred<Response>();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockImplementationOnce(() => revalidation.promise);
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 60_000,
      bridge: bridge(),
      fetchImplementation,
    });

    await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-failure-first',
      limit: 20,
    });
    const staleRead = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-failure-stale',
      limit: 20,
    });
    expect(staleRead.items[0]?.title).toBe('Моё сообщество');
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));

    // The legacy read fails, but the reader of the stale page never sees that failure and the page
    // keeps answering inside its window.
    revalidation.resolve(new Response('', { status: 503 }));
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));
    const afterFailure = await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-failure-after',
      limit: 20,
    });
    expect(afterFailure.items[0]?.title).toBe('Моё сообщество');
  });

  it('waits for the legacy read once the stale window has closed', async () => {
    const slowRead = deferred<Response>();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockImplementationOnce(() => slowRead.promise);
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 20,
      bridge: bridge(),
      fetchImplementation,
    });

    await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-window-first',
      limit: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    let settled = false;
    const pending = repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-window-closed',
      limit: 20,
    });
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    slowRead.resolve(jsonResponse(payload()));
    await expect(pending).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Моё сообщество' })],
    });
  });

  it('blocks the reader instead of serving stale data when the stale window is disabled', async () => {
    const slowRead = deferred<Response>();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockImplementationOnce(() => slowRead.promise);
    const repository = new LegacyCommunityReadRepository({
      baseUrl: 'https://legacy.padlhub.test',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      cacheTtlMs: 0,
      staleTtlMs: 0,
      bridge: bridge(),
      fetchImplementation,
    });

    await repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-disabled-first',
      limit: 20,
    });

    let settled = false;
    const pending = repository.listMemberships({
      tenantId,
      userId,
      correlationId: 'swr-disabled-second',
      limit: 20,
    });
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    slowRead.resolve(jsonResponse(payload()));
    await expect(pending).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Моё сообщество' })],
    });
  });
});
