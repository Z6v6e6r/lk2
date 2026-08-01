import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { PromotionEngagementRepository } from '@phub/database';

import { registerPromotionEngagementRoutes } from './promotion-engagement-routes.js';
import type { PromotionEngagementSink } from './legacy-promotion-engagement-sink.js';

const IDS = {
  tenant: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  user: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  promotion: '90000000-0000-4000-8000-000000000002',
} as const;

async function createApp(input: {
  readonly resolveContext?: PromotionEngagementRepository['resolveContext'];
  readonly record?: PromotionEngagementSink['record'];
}) {
  const app = Fastify();
  registerPromotionEngagementRoutes(app, {
    repository: {
      resolveContext:
        input.resolveContext ??
        vi.fn().mockResolvedValue({
          placement: 'cabinet_for_me_card',
          externalAdId: 'cup-ad-1',
          phoneE164: '+79990000001',
        }),
    },
    sink: { record: input.record ?? vi.fn().mockResolvedValue(undefined) },
    commandHandlers: [
      (request: FastifyRequest) => {
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: { sub: string };
        };
        current.tenantId = IDS.tenant;
        current.padlHubClaims = {
          sub: IDS.user,
          tenants: [IDS.tenant],
          roles: ['PLAYER'],
          permissions: ['home:read'],
          sid: 'promotion-engagement-test',
        };
        return Promise.resolve();
      },
    ],
  });
  await app.ready();
  return app;
}

describe('promotion engagement routes', () => {
  it('resolves the server-owned phone and forwards it only for a click', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const app = await createApp({ record });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/promotions/${IDS.promotion}/engagements`,
      headers: { 'idempotency-key': 'promotion-click-0001' },
      payload: { kind: 'CLICK' },
    });

    expect(response.statusCode).toBe(202);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'promotion-click-0001',
        placement: 'cabinet_for_me_card',
        adId: 'cup-ad-1',
        kind: 'CLICK',
        phoneE164: '+79990000001',
      }),
    );
  });

  it('rejects a browser-supplied phone before storage or delivery', async () => {
    const resolveContext = vi.fn();
    const record = vi.fn();
    const app = await createApp({ resolveContext, record });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/promotions/${IDS.promotion}/engagements`,
      headers: { 'idempotency-key': 'promotion-click-0002' },
      payload: { kind: 'CLICK', phoneE164: '+79990000002' },
    });

    expect(response.statusCode).toBe(400);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('maps repository and delivery failures to a stable unavailable error', async () => {
    const app = await createApp({
      resolveContext: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/promotions/${IDS.promotion}/engagements`,
      headers: { 'idempotency-key': 'promotion-impression-0001' },
      payload: { kind: 'IMPRESSION' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROMOTION_ENGAGEMENT_UNAVAILABLE' });
  });
});
