import type { RealtimeAuthorizationRepository } from '@phub/database';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeTicketIssuer } from '../messaging/realtime-ticket-issuer.js';
import { registerRealtimeRoutes } from './realtime-routes.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '55555555-5555-4555-8555-555555555555';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function appWith(options: {
  readonly enabled?: boolean;
  readonly authorization?: 'ok' | 'revoked';
  readonly auditFailure?: boolean;
}) {
  const app = Fastify();
  apps.push(app);
  const issue = vi.fn<RealtimeTicketIssuer['issue']>().mockResolvedValue({
    ticketId: '33333333-3333-4333-8333-333333333333',
    ticket: 'signed-one-time-ticket',
    expiresAt: '2026-08-04T12:00:30.000Z',
  });
  const revoke = vi.fn<RealtimeTicketIssuer['revoke']>().mockResolvedValue(undefined);
  const recordTicketIssued = options.auditFailure
    ? vi
        .fn<RealtimeAuthorizationRepository['recordTicketIssued']>()
        .mockRejectedValue(new Error('audit failed'))
    : vi.fn<RealtimeAuthorizationRepository['recordTicketIssued']>().mockResolvedValue(undefined);
  registerRealtimeRoutes(app, {
    enabled: options.enabled ?? true,
    repository: {
      authorizeConnection: vi.fn().mockResolvedValue({ outcome: options.authorization ?? 'ok' }),
      authorizeCommunitySubscription: vi.fn(),
      authorizeCommunityFanoutRecipients: vi.fn(),
      recordTicketIssued,
    },
    ticketIssuer: { issue, revoke },
    authenticatedTenantHandlers: [
      (request: FastifyRequest) => {
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: {
            sub: string;
            sid: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
          };
        };
        current.tenantId = tenantId;
        current.padlHubClaims = {
          sub: userId,
          sid: sessionId,
          tenants: [tenantId],
          roles: ['client'],
          permissions: ['communities.read'],
        };
        return Promise.resolve();
      },
    ],
  });
  return { app, issue, revoke, recordTicketIssued };
}

describe('realtime ticket route', () => {
  it('issues and audits a no-store session-bound ticket', async () => {
    const { app, issue, recordTicketIssued } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/realtime/tickets',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      ticket: 'signed-one-time-ticket',
      expiresAt: '2026-08-04T12:00:30.000Z',
    });
    expect(issue).toHaveBeenCalledWith({ tenantId, userId, sessionId, tenantKey: 'local-padel' });
    expect(recordTicketIssued.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      userId,
      ticketId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('does not issue for a revoked session or a disabled gate', async () => {
    const revoked = appWith({ authorization: 'revoked' });
    expect(
      (await revoked.app.inject({ method: 'POST', url: '/user/api/v1/x/realtime/tickets' }))
        .statusCode,
    ).toBe(401);
    expect(revoked.issue).not.toHaveBeenCalled();

    const disabled = appWith({ enabled: false });
    expect(
      (await disabled.app.inject({ method: 'POST', url: '/user/api/v1/x/realtime/tickets' }))
        .statusCode,
    ).toBe(404);
    expect(disabled.issue).not.toHaveBeenCalled();
  });

  it('revokes the Redis marker when mandatory audit fails', async () => {
    const { app, revoke } = appWith({ auditFailure: true });
    await expect(
      app.inject({ method: 'POST', url: '/user/api/v1/local-padel/realtime/tickets' }),
    ).resolves.toMatchObject({ statusCode: 500 });
    expect(revoke).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
  });
});
