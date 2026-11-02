import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerStationStreamRoutes } from './station-stream-routes.js';
const id = '11111111-1111-4111-8111-111111111111';
const body = { requestId: id, streamId: id, membershipEpoch: 0, throughSequence: 1 };
const unknown = {
  contractVersion: 1 as const,
  contract: 'station-read' as const,
  requestId: id,
  outcome: 'UNKNOWN' as const,
  code: 'READ_RECEIPT_UNPROVEN' as const,
};
function setup(auth = true, available = true) {
  const app = Fastify();
  const owner = {
    history: vi.fn(),
    summaries: vi.fn(),
    read: vi.fn(() => Promise.resolve(unknown)),
    readStatus: vi.fn(() => Promise.resolve(unknown)),
  };
  registerStationStreamRoutes(app, {
    ...(available ? { owner } : {}),
    authenticatedTenantHandlers: auth
      ? [
          (request, _reply, done) => {
            Object.assign(request, { tenantId: id, padlHubClaims: { sub: id, sid: 'session' } });
            done();
          },
        ]
      : [],
  });
  return { app, owner };
}
const base = '/user/api/v1/test/community-views';
describe('station stream public route boundary', () => {
  it('binds current actor and original key; status never mutates', async () => {
    const { app, owner } = setup();
    try {
      const sent = await app.inject({
        method: 'POST',
        url: `${base}/${id}/read-requests`,
        headers: { 'Idempotency-Key': id },
        payload: body,
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.headers['cache-control']).toBe('no-store');
      expect(sent.headers['referrer-policy']).toBe('no-referrer');
      expect(owner.read).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: id,
          userId: id,
          sessionId: 'session',
          communityId: id,
        }),
        body,
      );
      await app.inject({ method: 'GET', url: `${base}/${id}/read-requests/${id}` });
      expect(owner.readStatus).toHaveBeenCalledOnce();
      expect(owner.read).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it.each([
    { body: { ...body, phone: '123' }, key: id },
    { body, key: 'wrong' },
    { body: { ...body, membershipEpoch: '0' }, key: id },
    { body: { ...body, throughSequence: -1 }, key: id },
  ])('strict read body/key denies before owner %#', async (value) => {
    const { app, owner } = setup();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/read-requests`,
            headers: { 'Idempotency-Key': value.key },
            payload: value.body,
          })
        ).statusCode,
      ).toBe(400);
      expect(owner.read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    `${base}/station-stream-summaries?communityIds=${id},${id}`,
    `${base}/${id}/station-stream?phone=123`,
    `${base}/${id}/read-requests/${id}?throughSequence=1`,
    `${base}/station-stream-summaries?communityIds=${Array.from({ length: 51 }, () => id).join(',')}`,
  ])('rejects unsupported query %s', async (url) => {
    const { app, owner } = setup();
    try {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
      expect(owner.history).not.toHaveBeenCalled();
      expect(owner.summaries).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    [false, true, 401],
    [true, false, 503],
  ] as const)('auth/runtime fail before owner %#', async (auth, available, status) => {
    const { app, owner } = setup(auth, available);
    try {
      expect(
        (await app.inject({ method: 'GET', url: `${base}/${id}/station-stream` })).statusCode,
      ).toBe(status);
      expect(owner.history).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
