import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { PadlHubApiClient } from '@phub/api-sdk';
import { BookedOperationReadClient } from '@phub/subscription-runtime-adapter';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildAppWithActiveSession } from '../apps/api/src/testing/build-test-app.js';
import { SubscriptionRuntimeActorDelegationIssuer } from '../apps/api/src/subscriptions/subscription-runtime-actor-delegation-issuer.js';

// Called only by the task-owned physical Mongo test. Synthetic keys travel through stdin,
// never logs, argv, the environment, a provider request or persistent credentials.
assert.match(process.version, /^v22\./);
let input = '';
for await (const chunk of process.stdin) {
  input += String(chunk);
  assert.ok(input.length < 16_384);
}
const fixture = z
  .object({
    baseUrl: z.string().url(),
    privateKeyPem: z.string(),
    claims: z.object({
      sub: z.uuid(),
      tenant_id: z.uuid(),
      tenant_key: z.string(),
      sid: z.uuid(),
      provider_client_id: z.string(),
      provider_mapping_id: z.uuid(),
      operation_id: z.uuid(),
      iss: z.string(),
      aud: z.string(),
      correlation_id: z.string(),
    }),
  })
  .parse(JSON.parse(input));
assert.equal(new URL(fixture.baseUrl).hostname, '127.0.0.1');
const claims = fixture.claims;
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://synthetic:test@127.0.0.1:5432/synthetic',
  REDIS_URL: 'redis://127.0.0.1:6379',
  RABBITMQ_URL: 'amqp://synthetic:test@127.0.0.1:5672',
  JWT_ISSUER: 'b1-synthetic-auth',
  JWT_AUDIENCE: 'b1-synthetic-api',
  JWT_ACCESS_SECRET: randomUUID() + randomUUID(),
  JWT_REFRESH_SECRET: randomUUID() + randomUUID(),
});
const issuer = new SubscriptionRuntimeActorDelegationIssuer({
  privateKeyPem: fixture.privateKeyPem,
  keyId: 'synthetic-key',
  issuer: claims.iss,
  audience: claims.aud,
  ttlSeconds: 30,
});
let calls = 0;
const pool = {
  query(sql: string) {
    assert.ok(sql.includes('identity.tenants'));
    return Promise.resolve({ rows: [{ id: claims.tenant_id }] });
  },
} as unknown as Pool;
const app = await buildAppWithActiveSession({
  config,
  pool,
  logger: createLogger('b1-synthetic', 'silent'),
  bookedOperationRead: {
    delegationIssuer: issuer,
    // Synthetic verified-context seam; this is not physical PG or production mapping proof.
    actorContextRepository: {
      resolve: () =>
        Promise.resolve({
          outcome: 'ok',
          providerClientId: claims.provider_client_id,
          providerMappingId: claims.provider_mapping_id,
        }),
    },
    client: new BookedOperationReadClient({
      baseUrl: fixture.baseUrl,
      environment: 'development',
      timeoutMs: 1000,
      fetchImplementation: async (url, options) => {
        calls++;
        assert.equal(options?.method, 'GET');
        assert.equal(options.body, undefined);
        return fetch(url, options);
      },
    }),
  },
});
await app.listen({ host: '127.0.0.1', port: 0 });
try {
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function accessToken(userId: string) {
    return new SignJWT({
      sid: claims.sid,
      tenants: [claims.tenant_id],
      roles: ['client'],
      permissions: ['games.play'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setSubject(userId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  }
  const sdk = new PadlHubApiClient({
    baseUrl,
    tenantKey: claims.tenant_key,
    platform: 'web',
    appVersion: 'b1-synthetic',
    initialAccessToken: await accessToken(claims.sub),
    fetchImplementation: (url, options) =>
      fetch(url, {
        ...options,
        headers: {
          ...Object.fromEntries(new Headers(options?.headers)),
          'X-Correlation-ID': claims.correlation_id,
        },
      }),
  });
  for (let i = 0; i < 2; i++) {
    const outcome = await sdk.getBookedOperation(claims.operation_id);
    assert.equal(outcome.operationId, claims.operation_id);
    assert.equal(outcome.status, 'CONFIRMED');
    assert.equal(
      Object.keys(outcome).sort().join(','),
      'asOf,contractVersion,operationId,reason,status',
    );
  }
  assert.equal(calls, 2);
  const other = new PadlHubApiClient({
    baseUrl,
    tenantKey: claims.tenant_key,
    platform: 'web',
    appVersion: 'b1-synthetic',
    initialAccessToken: await accessToken(randomUUID()),
    fetchImplementation: (url, options) =>
      fetch(url, {
        ...options,
        headers: {
          ...Object.fromEntries(new Headers(options?.headers)),
          'X-Correlation-ID': claims.correlation_id,
        },
      }),
  });
  await assert.rejects(other.getBookedOperation(claims.operation_id));
  assert.equal(calls, 3, 'foreign principal produces one GET and no creation fallback');
  const unauthenticated = await fetch(
    `${baseUrl}/user/api/v1/${claims.tenant_key}/booked-operations/${claims.operation_id}`,
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(calls, 3);
  console.log(
    'B1 consumer: SDK -> real PadlHub HTTP auth route -> signed GET -> physical synthetic Mongo; no creation fallback.',
  );
} finally {
  await app.close();
}
