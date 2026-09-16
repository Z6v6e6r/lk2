import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerProfileProviderIdentityRoutes } from './profile-provider-identity-routes.js';

const TENANT = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const USER = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function appWith(options: {
  readonly enabled?: boolean;
  readonly linkProviderPhone?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly phoneE164: string;
    readonly fetchedAt: string;
  }) => Promise<'linked' | 'unchanged' | 'conflict' | 'absent'>;
}) {
  const app = Fastify();
  registerProfileProviderIdentityRoutes(app, {
    enabled: options.enabled ?? true,
    ...(options.linkProviderPhone
      ? { repository: { linkProviderPhone: options.linkProviderPhone } }
      : {}),
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    commandHandlers: [
      (request: FastifyRequest) => {
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        };
        current.tenantId = TENANT;
        current.padlHubClaims = {
          sub: USER,
          tenants: [TENANT],
          roles: ['client'],
          permissions: ['profile.read'],
          sid: 'session-provider-phone-test',
        };
        return Promise.resolve();
      },
    ],
  });
  return app.ready().then(() => app);
}

const url = '/user/api/v1/padlhub/profile/provider-phone';

describe('profile provider phone link route', () => {
  it('links a normalized russian provider phone for the authenticated viewer', async () => {
    const linkProviderPhone = vi.fn().mockResolvedValue('linked');
    const app = await appWith({ linkProviderPhone });

    const response = await app.inject({
      method: 'POST',
      url,
      payload: { phoneE164: '8 (910) 430-31-90' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'linked' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(linkProviderPhone).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: USER,
      phoneE164: '+79104303190',
      fetchedAt: '2026-09-16T12:00:00.000Z',
    });
  });

  it('rejects a foreign or malformed number before touching storage', async () => {
    const linkProviderPhone = vi.fn().mockResolvedValue('linked');
    const app = await appWith({ linkProviderPhone });

    for (const phoneE164 of ['4155552671', '7910430319', '+79104303190 доб. 12', '']) {
      const response = await app.inject({ method: 'POST', url, payload: { phoneE164 } });
      expect(response.statusCode, phoneE164).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(linkProviderPhone).not.toHaveBeenCalled();
  });

  it('reports a phone already owned by another viewer as a conflict', async () => {
    const app = await appWith({ linkProviderPhone: () => Promise.resolve('conflict') });

    const response = await app.inject({
      method: 'POST',
      url,
      payload: { phoneE164: '+79104303190' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'conflict' });
  });

  it('fails closed while the link is disabled or unwired', async () => {
    const disabled = await appWith({ enabled: false, linkProviderPhone: vi.fn() });
    const disabledResponse = await disabled.inject({
      method: 'POST',
      url,
      payload: { phoneE164: '+79104303190' },
    });
    expect(disabledResponse.statusCode).toBe(503);
    expect(disabledResponse.json()).toMatchObject({ code: 'PROVIDER_IDENTITY_LINK_DISABLED' });

    const unwired = await appWith({});
    const unwiredResponse = await unwired.inject({
      method: 'POST',
      url,
      payload: { phoneE164: '+79104303190' },
    });
    expect(unwiredResponse.statusCode).toBe(503);
    expect(unwiredResponse.json()).toMatchObject({ code: 'PROVIDER_IDENTITY_LINK_UNAVAILABLE' });
  });

  it('rejects an unexpected body shape instead of silently ignoring it', async () => {
    const linkProviderPhone = vi.fn();
    const app = await appWith({ linkProviderPhone });

    const response = await app.inject({
      method: 'POST',
      url,
      payload: { phoneE164: '+79104303190', userId: 'forged' },
    });

    expect(response.statusCode).toBe(400);
    expect(linkProviderPhone).not.toHaveBeenCalled();
  });
});
