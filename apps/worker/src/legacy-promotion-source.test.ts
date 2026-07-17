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
});
