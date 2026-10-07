import { randomUUID } from 'node:crypto';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import {
  BookedOperationAdmissionClient,
  bookedOperationAdmissionId,
} from '@phub/subscription-runtime-adapter';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppWithActiveSession } from '../testing/build-test-app.js';
import {
  SubscriptionRuntimeActorDelegationIssuer,
  subscriptionRuntimeIdempotencyKeySha256,
} from './subscription-runtime-actor-delegation-issuer.js';
const tenantId = randomUUID(),
  userId = randomUUID(),
  sid = randomUUID(),
  mappingId = randomUUID(),
  targetId = randomUUID(),
  targetMappingId = randomUUID(),
  key = randomUUID();
const tenantKey = 'b1-synthetic',
  route = `/user/api/v1/${tenantKey}/booked-operation-admissions`;
const body = {
  action: 'JOIN_GAME',
  target: { id: targetId, expectedRevision: 1 },
  paymentIntent: 'USE_SUBSCRIPTION',
};
const operationId = bookedOperationAdmissionId(
  tenantId,
  userId,
  subscriptionRuntimeIdempotencyKeySha256(key),
);
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'b1-identity',
  JWT_AUDIENCE: 'b1-api',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
});
const pool = {
  query: vi.fn((sql: string) =>
    sql.includes('identity.tenants')
      ? Promise.resolve({ rows: [{ id: tenantId }] })
      : Promise.reject(Error('Unexpected DB access')),
  ),
} as unknown as Pool;
const apps: Awaited<ReturnType<typeof buildAppWithActiveSession>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function headers(permissions = ['games.play'], tenants = [tenantId]) {
  const token = await new SignJWT({ sid, permissions, tenants, roles: ['client'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  return {
    authorization: `Bearer ${token}`,
    'idempotency-key': key,
    'x-correlation-id': 'b1-synthetic-correlation',
  };
}
async function fixture(disabled = false) {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const delegationIssuer = new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: await exportPKCS8(keys.privateKey),
    keyId: 'b1-key',
    issuer: 'https://lk2.example.test',
    audience: 'admission-owner',
    ttlSeconds: 30,
  });
  const actor = {
    resolve: vi.fn().mockResolvedValue({
      outcome: 'ok',
      providerClientId: 'synthetic-client',
      providerMappingId: mappingId,
    }),
  };
  const target = {
    resolve: vi.fn().mockResolvedValue({
      providerExerciseId: 'synthetic-exercise',
      targetMappingId,
      targetVersion: 'fixture-v1',
      startsAt: '2099-01-01T09:00:00.000Z',
      durationMinutes: 60,
      capacity: 4,
      admissible: true,
    }),
  };
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    expect(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url).toBe(
      'https://owner.example.test/lk/integrations/v1/booked-operation-admissions',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const raw = init?.body;
    if (typeof raw !== 'string') throw Error('Expected JSON body');
    const requestBody: unknown = JSON.parse(raw);
    expect(requestBody).toEqual(body);
    const proof = new Headers(init?.headers).get('X-Subscription-Actor-Delegation')!;
    const { payload } = await jwtVerify(proof, keys.publicKey, {
      issuer: 'https://lk2.example.test',
      audience: 'admission-owner',
    });
    expect(payload).toMatchObject({
      sub: userId,
      sid,
      tenant_id: tenantId,
      provider_mapping_id: mappingId,
      target_mapping_id: targetMappingId,
      operation_id: operationId,
      scope: 'subscription-runtime.booked-operation.admit',
      method: 'POST',
      target_id: targetId,
      expected_revision: 1,
      correlation_id: 'b1-synthetic-correlation',
    });
    return Response.json(
      {
        contractVersion: 1,
        operationId,
        status: 'PENDING',
        asOf: '2026-10-06T08:00:00.000Z',
        reason: 'OWNER_PENDING',
      },
      { status: 202 },
    );
  });
  const client = new BookedOperationAdmissionClient({
    baseUrl: 'https://owner.example.test',
    environment: 'production',
    timeoutMs: 500,
    fetchImplementation,
  });
  const app = await buildAppWithActiveSession({
    config,
    pool,
    logger: createLogger('b1-test', 'silent'),
    ...(disabled
      ? {}
      : {
          bookedOperationAdmission: {
            actorContextRepository: actor,
            targetRepository: target,
            delegationIssuer,
            client,
          },
        }),
  });
  apps.push(app);
  return { app, actor, target, fetchImplementation };
}
describe('booked admission public boundary', () => {
  it('server generates the actor/key UUID and delegates only physical mapping-shaped authority', async () => {
    const f = await fixture(),
      auth = await headers();
    for (let i = 0; i < 2; i++) {
      const r = await f.app.inject({ method: 'POST', url: route, headers: auth, payload: body });
      expect(r.statusCode).toBe(202);
      expect(r.json<{ operationId: string }>().operationId).toBe(operationId);
    }
    expect(f.actor.resolve).toHaveBeenCalledWith({ tenantId, userId, sessionId: sid });
    expect(f.target.resolve).toHaveBeenCalledWith({ tenantId, targetId, expectedRevision: 1 });
    expect(f.fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('denies missing session, permission and tenant before delegation', async () => {
    const f = await fixture();
    for (const [auth, status] of [
      [{}, 401],
      [await headers([]), 403],
      [await headers(['games.play'], [randomUUID()]), 403],
    ] as const) {
      const r = await f.app.inject({ method: 'POST', url: route, headers: auth, payload: body });
      expect(r.statusCode).toBe(status);
    }
    expect(f.actor.resolve).not.toHaveBeenCalled();
    expect(f.fetchImplementation).not.toHaveBeenCalled();
  });
  it('strict body, key and query prohibit external identifiers or a public operation UUID', async () => {
    const f = await fixture(),
      auth = await headers();
    for (const payload of [
      { ...body, operationId: randomUUID() },
      { ...body, providerClientId: 'guessed' },
      { ...body, target: { ...body.target, providerId: 'guessed' } },
      { ...body, paymentIntent: 'PAY' },
      { ...body, target: { ...body.target, expectedRevision: 0 } },
    ])
      expect(
        (await f.app.inject({ method: 'POST', url: route, headers: auth, payload })).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: route + '?actorId=guessed',
          headers: auth,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: route,
          headers: { ...auth, 'idempotency-key': 'bad key' },
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect(f.fetchImplementation).not.toHaveBeenCalled();
  });
  it('does not claim rejection for owner 503 or a lost response after dispatch', async () => {
    const f = await fixture(),
      auth = await headers();
    for (const failure of [
      () => f.fetchImplementation.mockRejectedValueOnce(new TypeError('Synthetic lost response')),
      () => f.fetchImplementation.mockResolvedValueOnce(Response.json({}, { status: 503 })),
    ]) {
      failure();
      const result = await f.app.inject({
        method: 'POST',
        url: route,
        headers: auth,
        payload: body,
      });
      expect(result.statusCode).toBe(503);
      expect(result.json<{ code: string; message: string; correlationId: string }>()).toEqual({
        code: 'BOOKED_OPERATION_ADMISSION_UNAVAILABLE',
        message:
          'Статус операции не подтверждён. Сохраните текущую попытку; новую покупку не начинайте.',
        correlationId: auth['x-correlation-id'],
      });
    }
    expect(f.fetchImplementation).toHaveBeenCalledTimes(2);
    f.target.resolve.mockResolvedValueOnce(null);
    const rejected = await f.app.inject({
      method: 'POST',
      url: route,
      headers: auth,
      payload: body,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ message: string }>().message).toBe('Операция не принята.');
    expect(f.fetchImplementation).toHaveBeenCalledTimes(2);
  });
  it('inactive session, missing mapping/target and disabled runtime fail closed', async () => {
    const f = await fixture(),
      auth = await headers();
    f.actor.resolve.mockResolvedValueOnce({ outcome: 'session_inactive' });
    expect(
      (await f.app.inject({ method: 'POST', url: route, headers: auth, payload: body })).statusCode,
    ).toBe(401);
    f.actor.resolve.mockResolvedValueOnce({ outcome: 'provider_mapping_unavailable' });
    expect(
      (await f.app.inject({ method: 'POST', url: route, headers: auth, payload: body })).statusCode,
    ).toBe(503);
    f.target.resolve.mockResolvedValueOnce(null);
    expect(
      (await f.app.inject({ method: 'POST', url: route, headers: auth, payload: body })).statusCode,
    ).toBe(409);
    expect(f.fetchImplementation).not.toHaveBeenCalled();
    const disabled = await fixture(true);
    expect(
      (await disabled.app.inject({ method: 'POST', url: route, headers: auth, payload: body }))
        .statusCode,
    ).toBe(503);
  });
});
