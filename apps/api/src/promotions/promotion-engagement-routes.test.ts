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
  readonly withoutBackend?: boolean;
  readonly logs?: string[];
}) {
  const logs = input.logs;
  const app = Fastify({
    ...(logs
      ? { logger: { level: 'warn', stream: { write: (line: string) => void logs.push(line) } } }
      : {}),
  });
  registerPromotionEngagementRoutes(app, {
    ...(input.withoutBackend
      ? {}
      : {
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
        }),
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

  it('warns once at startup and never per request while the backend is absent', async () => {
    const logs: string[] = [];
    const app = await createApp({ withoutBackend: true, logs });

    for (const eventId of ['promotion-impression-0003', 'promotion-impression-0004']) {
      const response = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/promotions/${IDS.promotion}/engagements`,
        headers: { 'idempotency-key': eventId },
        payload: { kind: 'IMPRESSION' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'PROMOTION_ENGAGEMENT_UNAVAILABLE' });
    }

    const startupWarnings = logs.filter((line) =>
      line.includes('PROMOTION_ENGAGEMENT_BACKEND_MISSING'),
    );
    expect(startupWarnings).toHaveLength(1);
    expect(startupWarnings[0]).toContain('ad engagement statistics stay disabled');
  });

  it('logs a stable failure code without the caller input when recording fails', async () => {
    const logs: string[] = [];
    const app = await createApp({
      logs,
      record: vi.fn().mockRejectedValue(new Error('PROMOTION_ENGAGEMENT_CIRCUIT_OPEN')),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/promotions/${IDS.promotion}/engagements`,
      headers: { 'idempotency-key': 'promotion-click-0003' },
      payload: { kind: 'CLICK' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROMOTION_ENGAGEMENT_UNAVAILABLE' });
    const failure = logs.find((line) => line.includes('promotion engagement recording failed'));
    expect(failure).toBeDefined();
    expect(failure).toContain('PROMOTION_ENGAGEMENT_CIRCUIT_OPEN');
    expect(failure).not.toContain('+79990000001');
  });

  it('never logs a failure message that is not a stable engagement code', async () => {
    const logs: string[] = [];
    const app = await createApp({
      logs,
      record: vi.fn().mockRejectedValue(new Error('delivery failed for +79990000009')),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/promotions/' + IDS.promotion + '/engagements',
      headers: { 'idempotency-key': 'promotion-click-0004' },
      payload: { kind: 'CLICK' },
    });

    expect(response.statusCode).toBe(503);
    const failure = logs.find((line) => line.includes('promotion engagement recording failed'));
    expect(failure).toBeDefined();
    expect(failure).toContain('PROMOTION_ENGAGEMENT_RECORD_FAILED');
    expect(failure).not.toContain('+79990000009');
  });
});
