import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerStationMessageRoutes } from './station-message-routes.js';
const id = '11111111-1111-4111-8111-111111111111';
const unknown = {
  contractVersion: 1 as const,
  contract: 'station-message' as const,
  requestId: id,
  outcome: 'UNKNOWN' as const,
  code: 'MESSAGE_RECEIPT_UNPROVEN' as const,
};
function setup(auth = true, available = true) {
  const app = Fastify();
  const owner = {
    send: vi.fn(() => Promise.resolve(unknown)),
    status: vi.fn(() => Promise.resolve(unknown)),
  };
  registerStationMessageRoutes(app, {
    ...(available ? { owner } : {}),
    authenticatedTenantHandlers: auth
      ? [
          (request, _reply, done) => {
            Object.assign(request, {
              tenantId: 'verified-tenant',
              padlHubClaims: { sub: 'verified-user', sid: 'verified-session' },
            });
            done();
          },
        ]
      : [],
  });
  return { app, owner };
}
describe('station canonical public routes', () => {
  it('binds verified tenant/sub/sid and forwards exact key; status read cannot call send', async () => {
    const { app, owner } = setup();
    const url = `/user/api/v1/test/community-views/${id}/message-requests`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'Idempotency-Key': id },
          payload: { requestId: id, text: 'hello' },
        })
      ).statusCode,
    ).toBe(200);
    expect(owner.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'verified-tenant',
        tenantKey: 'test',
        userId: 'verified-user',
        sessionId: 'verified-session',
        communityId: id,
      }),
      { requestId: id, text: 'hello' },
    );
    expect((await app.inject({ method: 'GET', url: `${url}/${id}` })).json()).toEqual(unknown);
    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(owner.status).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('rejects caller identity, missing/mismatched key, query injection and missing auth', async () => {
    const { app, owner } = setup();
    const url = `/user/api/v1/test/community-views/${id}/message-requests`;
    for (const payload of [
      { requestId: id, text: 'hi', member: { id: 'forged' } },
      { requestId: id, text: '  ' },
    ])
      expect(
        (await app.inject({ method: 'POST', url, payload, headers: { 'Idempotency-Key': id } }))
          .statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url, payload: { requestId: id, text: 'hi' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `${url}/${id}?userId=forged` })).statusCode,
    ).toBe(400);
    expect(owner.send).not.toHaveBeenCalled();
    expect(owner.status).not.toHaveBeenCalled();
    await app.close();
    const anon = setup(false);
    expect((await anon.app.inject({ method: 'GET', url: `${url}/${id}` })).statusCode).toBe(401);
    await anon.app.close();
  });
  it('unconfigured/local runtime returns unavailable without command', async () => {
    const { app, owner } = setup(true, false);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/user/api/v1/test/community-views/${id}/message-requests/${id}`,
        })
      ).statusCode,
    ).toBe(503);
    expect(owner.status).not.toHaveBeenCalled();
    await app.close();
  });
});
