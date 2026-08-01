import { describe, expect, it, vi } from 'vitest';

import { LegacyPromotionSource } from './legacy-promotion-source.js';

describe('legacy CUP promotion source', () => {
  it('normalizes the active cabinet-home placement without exposing source selection', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          placement: 'cabinet_home',
          rotationEnabled: true,
          ads: [
            {
              id: 'legacy-ad-1',
              title: 'Летняя акция',
              href: '/ab_leto',
              imageUrl: 'https://padlhub.su/api/advertising/assets/asset-1',
            },
          ],
          updatedAt: '2026-07-17T10:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const source = new LegacyPromotionSource({
      baseUrl: 'https://padlhub.su',
      timeoutMs: 1_000,
      maxAttempts: 2,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation,
    });

    await expect(source.getSnapshot('promotion-source-test')).resolves.toEqual({
      rotationEnabled: true,
      items: [
        {
          externalId: 'legacy-ad-1',
          title: 'Летняя акция',
          href: '/ab_leto',
          imageSourceUrl: 'https://padlhub.su/api/advertising/assets/asset-1',
        },
      ],
      updatedAt: '2026-07-17T10:00:00.000Z',
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [request, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(request).toEqual(new URL('https://padlhub.su/api/advertising/cabinet-home'));
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('X-Correlation-ID')).toBe('promotion-source-test');
  });

  it('fails closed on unsafe links from the legacy response', async () => {
    const source = new LegacyPromotionSource({
      baseUrl: 'https://padlhub.su',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation: vi.fn().mockResolvedValue(
        Response.json({
          placement: 'cabinet_home',
          rotationEnabled: true,
          ads: [
            {
              id: 'legacy-ad-1',
              href: 'javascript:alert(1)',
              imageUrl: 'https://padlhub.su/api/advertising/assets/asset-1',
            },
          ],
        }),
      ),
    });

    await expect(source.getSnapshot('promotion-source-test')).rejects.toMatchObject({
      code: 'PROMOTION_LEGACY_RESPONSE_INVALID',
    });
  });

  it('reads the independently managed upper placement from its dedicated route', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        placement: 'cabinet_home_top',
        rotationEnabled: false,
        ads: [],
      }),
    );
    const source = new LegacyPromotionSource({
      baseUrl: 'https://padlhub.su',
      placement: 'cabinet_home_top',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation,
    });

    await expect(source.getSnapshot('promotion-top-source-test')).resolves.toMatchObject({
      rotationEnabled: false,
      items: [],
    });
    const [request] = fetchImplementation.mock.calls[0] ?? [];
    expect(request).toEqual(new URL('https://padlhub.su/api/advertising/cabinet-home-top'));
  });

  it('reads repeat interval and card presentation fields from the dedicated placement', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        placement: 'cabinet_for_me_card',
        rotationEnabled: false,
        repeatEveryCards: 5,
        ads: [
          {
            id: 'recommendation-ad-1',
            title: 'Новая ракетка',
            badgeText: 'Партнёр',
            footerText: 'Выбрать',
            href: '/offers/racket',
            imageUrl: 'https://padlhub.su/api/advertising/assets/card-asset-1',
            squareImageUrl: 'https://padlhub.su/api/advertising/assets/card-square-1',
            horizontalImageUrl: 'https://padlhub.su/api/advertising/assets/card-horizontal-1',
          },
        ],
      }),
    );
    const source = new LegacyPromotionSource({
      baseUrl: 'https://padlhub.su',
      placement: 'cabinet_for_me_card',
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation,
    });

    await expect(source.getSnapshot('recommendation-card-source-test')).resolves.toMatchObject({
      repeatEveryCards: 5,
      items: [
        {
          title: 'Новая ракетка',
          badgeText: 'Партнёр',
          footerText: 'Выбрать',
          squareImageSourceUrl: 'https://padlhub.su/api/advertising/assets/card-square-1',
          horizontalImageSourceUrl: 'https://padlhub.su/api/advertising/assets/card-horizontal-1',
        },
      ],
    });
    const [request] = fetchImplementation.mock.calls[0] ?? [];
    expect(request).toEqual(new URL('https://padlhub.su/api/advertising/cabinet-for-me-card'));
  });

  it('accepts image URLs from an explicitly allowlisted private staging host', async () => {
    const source = new LegacyPromotionSource({
      baseUrl: 'http://phab-showcase:3000',
      placement: 'cabinet_home',
      privateHttpHosts: ['phab-showcase'],
      timeoutMs: 1_000,
      maxAttempts: 1,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      fetchImplementation: vi.fn().mockResolvedValue(
        Response.json({
          placement: 'cabinet_home',
          rotationEnabled: false,
          ads: [
            {
              id: 'nano-ad-1',
              title: 'Nano Block 2',
              href: '/promotions/nano',
              imageUrl: 'http://phab-showcase:3000/api/advertising/assets/nano-asset-1',
            },
          ],
        }),
      ),
    });

    await expect(source.getSnapshot('nano-promotion-source-test')).resolves.toMatchObject({
      items: [
        {
          externalId: 'nano-ad-1',
          imageSourceUrl: 'http://phab-showcase:3000/api/advertising/assets/nano-asset-1',
        },
      ],
    });
  });
});
