import Fastify, { type preHandlerAsyncHookHandler } from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerQuarterCreateRoutes } from './game-quarter-create-routes.js';
import type { QuarterCreateRuntime } from './game-quarter-create-runtime.js';
import { qcOperationId, qcHash } from '@phub/domain/quarter-create';
const tenantId = '11111111-1111-4111-8111-000000000001',
  userId = '11111111-1111-4111-8111-000000000002',
  key = 'synthetic-quarter-original',
  input = {
    stationId: '11111111-1111-4111-8111-000000000003',
    courtId: '11111111-1111-4111-8111-000000000004',
    subscriptionId: '11111111-1111-4111-8111-000000000005',
    startsAt: '2030-01-01T12:00:00.000Z',
  },
  prefix = '/user/api/v1/synthetic/game-create-operations';
async function setup() {
  const app = Fastify(),
    runtime = {
      capability: vi.fn(async () => {
        await Promise.resolve();
        return { contractVersion: 1 as const, available: true };
      }),
      locations: vi.fn(async () => {
        await Promise.resolve();
        return {
          items: [
            {
              stationId: input.stationId,
              courtId: input.courtId,
              stationTitle: 'Synthetic station',
              courtName: 'Court1',
            },
          ],
        };
      }),
      read: vi.fn(async () => {
        await Promise.resolve();
        return null;
      }),
      execute: vi.fn(async () => {
        await Promise.resolve();
        return { operation: { status: 'UNKNOWN' } };
      }),
    };
  const authorize: preHandlerAsyncHookHandler = async (r, p) => {
    await Promise.resolve();
    if (r.headers.authorization !== 'Bearer synthetic-session')
      return p.code(401).send({ code: 'AUTH_REQUIRED' });
    if (r.headers['x-foreign-tenant']) return p.code(403).send({ code: 'TENANT_FORBIDDEN' });
    Object.assign(r, {
      tenantId,
      padlHubClaims: { sub: userId, sid: '11111111-1111-4111-8111-000000000006' },
    });
  };
  registerQuarterCreateRoutes(app, {
    runtime: runtime as unknown as QuarterCreateRuntime,
    readHandlers: [authorize],
    commandHandlers: [authorize],
  });
  await app.ready();
  return { app, runtime };
}
const headers = { authorization: 'Bearer synthetic-session', 'idempotency-key': key };
describe('quarter public route boundaries', () => {
  it('auth/tenant gate precedes all capability/location/journal/command access', async () => {
    const t = await setup();
    try {
      for (const path of ['/capability', '/locations', '/by-key']) {
        expect((await t.app.inject({ url: prefix + path })).statusCode).toBe(401);
        expect(
          (
            await t.app.inject({
              url: prefix + path,
              headers: { ...headers, 'x-foreign-tenant': '1' },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (await t.app.inject({ method: 'POST', url: prefix, headers: {}, payload: input }))
          .statusCode,
      ).toBe(401);
      expect(t.runtime.capability).not.toHaveBeenCalled();
      expect(t.runtime.locations).not.toHaveBeenCalled();
      expect(t.runtime.execute).not.toHaveBeenCalled();
    } finally {
      await t.app.close();
    }
  });
  it('no unsupported fields/query/native provider identifiers or missing keys reach writer', async () => {
    const t = await setup();
    try {
      for (const payload of [
        { ...input, title: 'not applied' },
        { ...input, providerRoomId: 'external' },
        { ...input, durationMinutes: 90 },
        { ...input, subscriptionId: 'bad' },
        [],
      ])
        expect(
          (await t.app.inject({ method: 'POST', url: prefix, headers, payload })).statusCode,
        ).toBe(400);
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: prefix,
            headers: { authorization: headers.authorization },
            payload: input,
          })
        ).statusCode,
      ).toBe(400);
      for (const path of ['/capability', '/locations', '/by-key'])
        expect(
          (await t.app.inject({ url: prefix + path + '?provider=VIVA', headers })).statusCode,
        ).toBe(400);
      expect(t.runtime.execute).not.toHaveBeenCalled();
    } finally {
      await t.app.close();
    }
  });
  it('reconcile binds exact authenticated original operation/key and never switches to ordinary create', async () => {
    const t = await setup();
    try {
      const id = await qcOperationId(tenantId, userId, await qcHash(key));
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: prefix + '/' + input.courtId + '/reconcile',
            headers,
            payload: input,
          })
        ).statusCode,
      ).toBe(404);
      expect(t.runtime.execute).not.toHaveBeenCalled();
      const r = await t.app.inject({
        method: 'POST',
        url: prefix + '/' + id + '/reconcile',
        headers,
        payload: input,
      });
      expect(r.statusCode).toBe(202);
      expect(t.runtime.execute).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, userId, tenantKey: 'synthetic' }),
        key,
        input,
        true,
      );
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    } finally {
      await t.app.close();
    }
  });
  it('public locations contain public IDs only; unavailable evidence is redacted', async () => {
    const t = await setup();
    try {
      const r = await t.app.inject({ url: prefix + '/locations', headers });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        items: [
          {
            stationId: input.stationId,
            courtId: input.courtId,
            stationTitle: 'Synthetic station',
            courtName: 'Court1',
          },
        ],
      });
      t.runtime.locations.mockRejectedValueOnce(new Error('private-provider-token'));
      const denied = await t.app.inject({ url: prefix + '/locations', headers });
      expect(denied.statusCode).toBe(503);
      expect(denied.body).not.toContain('private-provider');
      expect((await t.app.inject({ url: prefix + '/by-key', headers })).statusCode).toBe(404);
      expect(t.runtime.execute).not.toHaveBeenCalled();
    } finally {
      await t.app.close();
    }
  });
});
