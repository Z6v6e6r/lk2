import { afterEach, describe, it, expect, vi } from 'vitest';
import { QuarterCreateOwnerClient } from './quarter-create.js';
import { quarterFixture, expiredQuarterReceipt } from './quarter-create.test-fixture.js';
const env = {
  correlationId: 'synthetic-correlation',
  actorDelegation: 'synthetic-delegation-proof',
  actorToken: {
    token: 'synthetic-actor-token-not-real',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
};
afterEach(() => vi.useRealTimers());
describe('private quarter HTTP boundary', () => {
  it('only exact preparation subscription403 refuses; admit/read/actor403 stay unknown', async () => {
    const f = await quarterFixture(),
      code = 'GAME_CREATE_PREPARATION_SUBSCRIPTION_MISMATCH',
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation: () =>
          Promise.resolve(new Response(JSON.stringify({ code, error: code }), { status: 403 })),
      });
    await expect(
      client.prepare(f.request, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_REFUSED' });
    for (const action of ['admit', 'read'] as const)
      await expect(
        client[action](f.admission, { ...env, operationId: f.receipt.operationId }),
      ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_UNAVAILABLE' });
    const denied = new QuarterCreateOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: 'GAME_CREATE_PREPARATION_ACTOR_MISMATCH',
              error: 'GAME_CREATE_PREPARATION_ACTOR_MISMATCH',
            }),
            { status: 403 },
          ),
        ),
    });
    await expect(
      denied.prepare(f.request, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_UNAVAILABLE' });
  });

  it('accepts actual LK raw preparation capsule, not an invented wrapper', async () => {
    const f = await quarterFixture(),
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation: async () => {
          await Promise.resolve();
          return new Response(JSON.stringify(f.admission.preparation));
        },
      });
    expect(await client.prepare(f.request, { ...env, operationId: f.receipt.operationId })).toEqual(
      f.admission,
    );
  });
  it.each([
    'GAME_CREATE_LOCATION_MISMATCH',
    'GAME_CREATE_SERVICE_MISMATCH',
    'GAME_CREATE_SERVICE_UNRESOLVED',
    'GAME_CREATE_PRICE_UNRESOLVED',
    'GAME_CREATE_PREPARATION_EXPIRED',
  ])('only exact nonbinding preparation refusal %s is terminalizable', async (code) => {
    const f = await quarterFixture(),
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation: async () => {
          await Promise.resolve();
          return new Response(JSON.stringify({ code, error: code }), { status: 409 });
        },
      });
    await expect(
      client.prepare(f.request, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_REFUSED' });
    await expect(
      client.admit(f.admission, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_UNAVAILABLE' });
  });
  it('strict POST read keeps original admission hash, actor and no redirect/retry', async () => {
    const f = await quarterFixture(),
      fetchImplementation = vi.fn(async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            contractVersion: 1,
            operationId: f.receipt.operationId,
            operation: { status: 'CONFIRMED', receipt: f.receipt },
            registration: { status: 'UNKNOWN', asOf: null },
          }),
        );
      }),
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation,
      });
    const result = await client.read(f.admission, { ...env, operationId: f.receipt.operationId });
    expect(result.registration.status).toBe('UNKNOWN');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]).toMatchObject([
      'https://padlhub.su/lk/integrations/v1/game-create-operations/' +
        f.receipt.operationId +
        '/read',
      { method: 'POST', redirect: 'error', cache: 'no-store' },
    ]);
  });
  it.each([401, 409, 500, 302])('never retries or accepts status%s', async (status) => {
    const f = await quarterFixture(),
      fetchImplementation = vi.fn(async () => {
        await Promise.resolve();
        return new Response('{}', { status });
      }),
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation,
      });
    await expect(
      client.admit(f.admission, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
  it('rejects changed origin and never leaks raw provider error', async () => {
    const f = await quarterFixture(),
      response = new Response('{}');
    Object.defineProperty(response, 'url', { value: 'https://elsewhere.invalid/' });
    const client = new QuarterCreateOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation: async () => {
        await Promise.resolve();
        return response;
      },
    });
    await expect(
      client.read(f.admission, { ...env, operationId: f.receipt.operationId }),
    ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_UNAVAILABLE' });
  });
  it('rejects oversized body and trips persistent client breaker', async () => {
    const f = await quarterFixture(),
      fetchImplementation = vi.fn(async () => {
        await Promise.resolve();
        return new Response('x'.repeat(33000));
      }),
      client = new QuarterCreateOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1000,
        fetchImplementation,
      });
    for (let i = 0; i < 4; i++)
      await expect(
        client.read(f.admission, { ...env, operationId: f.receipt.operationId }),
      ).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
  it.each(['https://foreign.invalid/', 'https://padlhub.su/api', 'https://user:pass@padlhub.su/'])(
    'refuses endpoint %s',
    (baseUrl) => {
      expect(
        () => new QuarterCreateOwnerClient({ baseUrl, environment: 'production', timeoutMs: 1000 }),
      ).toThrow();
    },
  );
});

it('emits only bounded redacted metrics for success/refusal/malformed response and ignores observer failure', async () => {
  const f = await quarterFixture(),
    metrics: { operation: string; outcome: string; durationMs: number }[] = [];
  const replies = [
    Response.json(f.admission.preparation),
    Response.json(
      { code: 'GAME_CREATE_LOCATION_MISMATCH', error: 'GAME_CREATE_LOCATION_MISMATCH' },
      { status: 409 },
    ),
    Response.json({
      contractVersion: 1,
      operationId: f.receipt.operationId,
      operation: { status: ['CONFIRMED'], receipt: f.receipt },
      registration: { status: 'UNKNOWN', asOf: null },
    }),
  ];
  const client = new QuarterCreateOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 1000,
    fetchImplementation: async () => {
      await Promise.resolve();
      return replies.shift()!;
    },
    onMetric: (m) => {
      metrics.push(m);
      throw new Error('synthetic-observer-failure');
    },
  });
  await client.prepare(f.request, { ...env, operationId: f.receipt.operationId });
  await expect(
    client.prepare(f.request, { ...env, operationId: f.receipt.operationId }),
  ).rejects.toMatchObject({ code: 'GAME_QUARTER_CREATE_REFUSED' });
  await expect(
    client.read(f.admission, { ...env, operationId: f.receipt.operationId }),
  ).rejects.toThrow();
  expect(metrics.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
    { operation: 'prepare', outcome: 'success' },
    { operation: 'prepare', outcome: 'refused' },
    { operation: 'read', outcome: 'failure' },
  ]);
  for (const metric of metrics) {
    expect(typeof metric.durationMs).toBe('number');
    expect(metric.durationMs).toBeGreaterThanOrEqual(0);
  }
  const serialized = JSON.stringify(metrics);
  for (const forbidden of [
    env.actorToken.token,
    env.actorDelegation,
    env.correlationId,
    f.receipt.operationId,
    f.receipt.providerExerciseId,
    'https://',
    'subscriptionInstanceId',
  ])
    expect(serialized).not.toContain(forbidden);
});

it('parses schema2 unused expiry through actual admit/read HTTP boundary without retries', async () => {
  const f = await quarterFixture({ observedAt: new Date(Date.now() - 120000).toISOString() }),
    receipt = expiredQuarterReceipt(f);
  const fetchImplementation = vi.fn(
    async () =>
      await Promise.resolve(
        new Response(
          JSON.stringify({
            contractVersion: 1,
            operationId: receipt.operationId,
            operation: { status: 'REJECTED', receipt },
            registration: { status: 'UNKNOWN', asOf: null },
          }),
        ),
      ),
  );
  const client = new QuarterCreateOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 1000,
    fetchImplementation,
  });
  for (const mode of ['admit', 'read'] as const)
    expect(
      (await client[mode](f.admission, { ...env, operationId: receipt.operationId })).receipt,
    ).toEqual(receipt);
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
});
